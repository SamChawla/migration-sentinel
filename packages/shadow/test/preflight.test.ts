import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { requiredPreflightChecks, isDataDependent, runPreflight, PREFLIGHT_TIMEOUT_MS } from "../src/preflight";

/** A stand-in pg Client that lets transaction control through and lets the test
 *  decide what the probe SELECT does. */
function fakeClient(onProbe: () => Promise<{ rows: unknown[] }>): Client {
  return {
    query: (text: string) => {
      const head = text.trim().toUpperCase();
      if (head.startsWith("SELECT")) return onProbe();
      // BEGIN / SET TRANSACTION / SET LOCAL / ROLLBACK all succeed.
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Client;
}

describe("requiredPreflightChecks — derives the right read-only probe", () => {
  it("SET NOT NULL → probe for NULLs", () => {
    const [c] = requiredPreflightChecks("ALTER TABLE public.users ALTER COLUMN legacy_notes SET NOT NULL");
    expect(c.kind).toBe("not_null");
    expect(c.probeSql).toBe("SELECT count(*) AS violations FROM public.users WHERE legacy_notes IS NULL");
    expect(c.failIfPositive).toBe(true);
  });

  it("ADD COLUMN NOT NULL without default → probe table is non-empty", () => {
    const [c] = requiredPreflightChecks("ALTER TABLE users ADD COLUMN region text NOT NULL");
    expect(c.kind).toBe("add_notnull_no_default");
    expect(c.probeSql).toBe("SELECT count(*) AS violations FROM users");
  });

  it("ADD COLUMN NOT NULL WITH default → no probe (safe)", () => {
    expect(requiredPreflightChecks("ALTER TABLE users ADD COLUMN region text NOT NULL DEFAULT 'us'")).toHaveLength(0);
  });

  it("ADD UNIQUE → duplicate-count probe", () => {
    const [c] = requiredPreflightChecks("ALTER TABLE users ADD CONSTRAINT uq_email UNIQUE (email)");
    expect(c.kind).toBe("unique");
    expect(c.probeSql).toContain("GROUP BY email");
    expect(c.probeSql).toContain("HAVING count(*) > 1");
  });

  it("ADD CHECK → violating-rows probe", () => {
    const [c] = requiredPreflightChecks("ALTER TABLE users ADD CONSTRAINT chk_age CHECK (age >= 0)");
    expect(c.kind).toBe("check");
    expect(c.probeSql).toBe("SELECT count(*) AS violations FROM users WHERE NOT (age >= 0)");
  });

  it("ADD FOREIGN KEY → orphan-rows probe", () => {
    const [c] = requiredPreflightChecks(
      "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)",
    );
    expect(c.kind).toBe("foreign_key");
    expect(c.probeSql).toContain("NOT EXISTS");
    expect(c.probeSql).toContain("FROM users p");
  });

  it("ALTER COLUMN TYPE → flagged, no auto probe", () => {
    const [c] = requiredPreflightChecks("ALTER TABLE users ALTER COLUMN amount TYPE bigint");
    expect(c.kind).toBe("type_change");
    expect(c.probeSql).toBeNull();
  });

  it("safe schema ops → no checks", () => {
    expect(requiredPreflightChecks("ALTER TABLE users ADD COLUMN last_login_at timestamptz")).toHaveLength(0);
    expect(isDataDependent("ALTER TABLE users ADD COLUMN last_login_at timestamptz")).toBe(false);
  });

  it("isDataDependent flags SET NOT NULL", () => {
    expect(isDataDependent("ALTER TABLE users ALTER COLUMN full_name SET NOT NULL")).toBe(true);
  });
});

describe("runPreflight — graceful degradation (ADR-011 hardening)", () => {
  const notNull = "ALTER TABLE public.users ALTER COLUMN legacy_notes SET NOT NULL";

  it("a completed probe reports violations and a definite willFail", async () => {
    const client = fakeClient(() => Promise.resolve({ rows: [{ violations: 42 }] }));
    const [res] = await runPreflight(client, notNull);
    expect(res.violations).toBe(42);
    expect(res.willFail).toBe(true);
    expect(res.degraded).toBeFalsy();
  });

  it("a probe that times out DEGRADES to review-required — never read as safe", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const client = fakeClient(() => Promise.reject(timeout));
    const [res] = await runPreflight(client, notNull);
    expect(res.willFail).toBeNull(); // NOT false — we could not prove safety
    expect(res.violations).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.reason).toContain(String(PREFLIGHT_TIMEOUT_MS));
  });

  it("a probe failure on one check does not abort the others", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({ rows: [{ violations: 0 }] });
    });
    const twoChecks =
      "ALTER TABLE users ALTER COLUMN a SET NOT NULL;\nALTER TABLE users ADD CONSTRAINT uq UNIQUE (email)";
    const results = await runPreflight(client, twoChecks);
    expect(results).toHaveLength(2);
    expect(results[0].degraded).toBe(true);
    expect(results[1].willFail).toBe(false);
  });
});
