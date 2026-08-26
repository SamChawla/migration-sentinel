import { describe, it, expect } from "vitest";
import { splitStatements, classifyStatement, codeOnly } from "../src/blast";
import { assertReadOnly, ReadOnlyViolation } from "../src/query";
import { requiredPreflightChecks } from "../src/preflight";

/**
 * Regression tests for the Qodo PR #3 findings on the safety core.
 */

describe("splitStatements — lexer (dollar-quote + comment-in-string)", () => {
  it("keeps a dollar-quoted function body as ONE statement (#5)", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RAISE NOTICE 'a; b'; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE FUNCTION");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("does not merge across string literals that contain comment markers (#1)", () => {
    // The block-comment open lives inside one string and the close inside a
    // later one; a naive regex would delete the DELETE between them.
    const open = "'/" + "*'";
    const close = "'*" + "/'";
    const sql = `SELECT ${open}; DELETE FROM users; SELECT ${close}`;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts.some((s) => /DELETE FROM users/i.test(s))).toBe(true);
  });
});

describe("assertReadOnly — security (#1)", () => {
  it("rejects the chained comment-in-string bypass as multiple statements", () => {
    const open = "'/" + "*'";
    const close = "'*" + "/'";
    const sql = `SELECT ${open}; DELETE FROM users; SELECT ${close}`;
    expect(() => assertReadOnly(sql)).toThrow(ReadOnlyViolation);
  });

  it("rejects an embedded transaction-control + write", () => {
    expect(() => assertReadOnly("SELECT 1; COMMIT; DELETE FROM users")).toThrow(ReadOnlyViolation);
  });

  it("still allows a genuine single SELECT with a CASE ... END", () => {
    expect(() => assertReadOnly("SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END FROM t")).not.toThrow();
  });
});

describe("classifyStatement", () => {
  it("classifies INSERT as data-mutating so rollback proof can't pass it (#2)", () => {
    const c = classifyStatement("INSERT INTO users (id) VALUES (1)");
    expect(c.dataMutating).toBe(true);
  });

  it("treats a literal WHERE inside a string as an UNBOUNDED update (#3)", () => {
    const c = classifyStatement("UPDATE users SET note = 'reset WHERE everything'");
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("still treats a real WHERE clause as bounded", () => {
    const c = classifyStatement("UPDATE users SET note = 'x' WHERE id = 1");
    expect(c.blocking).toBe(false);
  });
});

describe("codeOnly", () => {
  it("blanks single-quoted and dollar-quoted contents", () => {
    expect(codeOnly("UPDATE t SET x = 'a WHERE b'")).not.toMatch(/WHERE/);
    expect(codeOnly("SELECT $$ DROP TABLE t $$")).not.toMatch(/DROP/);
  });
});

describe("requiredPreflightChecks", () => {
  it("handles ALTER TABLE IF EXISTS ... SET NOT NULL (#11)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE IF EXISTS users ALTER COLUMN email SET NOT NULL");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("not_null");
    expect(checks[0].table).toBe("users");
  });

  it("skips the probe for a NOT VALID check constraint (#9)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE orders ADD CONSTRAINT ck CHECK (total >= 0) NOT VALID");
    expect(checks).toHaveLength(0);
  });

  it("builds a composite foreign-key probe with a proper join (#10)", () => {
    const checks = requiredPreflightChecks(
      "ALTER TABLE orders ADD FOREIGN KEY (a, b) REFERENCES parent (pa, pb)",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("p.pa = c.a AND p.pb = c.b");
  });

  it("excludes null keys from the UNIQUE duplicate probe (#8)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ADD UNIQUE (email)");
    expect(checks[0].probeSql).toContain("email IS NOT NULL");
  });
});

describe("Round 2 regressions", () => {
  it("DROP SCHEMA CASCADE is blocked (#1)", () => {
    const c = classifyStatement("DROP SCHEMA app CASCADE");
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("allows a SELECT that returns a keyword literal (#10)", () => {
    expect(() => assertReadOnly("SELECT 'DELETE' AS word")).not.toThrow();
    expect(() => assertReadOnly("SELECT $$DROP TABLE$$ AS t")).not.toThrow();
  });

  it("rejects a session advisory lock in a read query (#2)", () => {
    expect(() => assertReadOnly("SELECT pg_advisory_lock(1)")).toThrow();
    expect(() => assertReadOnly("SELECT nextval('s')")).toThrow();
  });

  it("produces a preflight check for a quoted identifier with spaces (#7)", () => {
    const checks = requiredPreflightChecks('ALTER TABLE "User Accounts" ALTER COLUMN "email address" SET NOT NULL');
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("not_null");
  });

  it("checks ALL comma-separated actions in one ALTER (#6)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ALTER COLUMN email SET NOT NULL, ADD UNIQUE (handle)");
    const kinds = checks.map((c) => c.kind).sort();
    expect(kinds).toEqual(["not_null", "unique"]);
  });

  it("UNIQUE NULLS NOT DISTINCT keeps null keys in the probe (#8)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ADD UNIQUE NULLS NOT DISTINCT (email)");
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).not.toContain("IS NOT NULL");
  });

  it("flags an implicit-PK foreign key for review instead of skipping (#4)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("foreign_key");
    expect(checks[0].probeSql).toBeNull();
  });
});
