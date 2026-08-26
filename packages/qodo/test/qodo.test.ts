import { describe, it, expect, afterEach } from "vitest";
import { extractJson, normalizeVerdict, normalizeFindings, reviewMigration } from "../src/index";

describe("extractJson", () => {
  it("pulls a clean JSON object out of noisy CLI stdout", () => {
    const out = 'thinking...\nhere is the result:\n{"verdict":"passed","findings":[]}\nBye.';
    expect(extractJson(out)).toEqual({ verdict: "passed", findings: [] });
  });

  it("returns the LAST balanced object when several appear", () => {
    const out = '{"a":1}\n... {"verdict":"failed"}';
    expect(extractJson(out)).toEqual({ verdict: "failed" });
  });

  it("handles nested braces", () => {
    const out = 'x {"verdict":"passed","meta":{"k":{"n":1}}} y';
    expect(extractJson(out)).toEqual({ verdict: "passed", meta: { k: { n: 1 } } });
  });

  it("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("normalizeVerdict", () => {
  it("passes through valid verdicts", () => {
    expect(normalizeVerdict("passed")).toBe("passed");
    expect(normalizeVerdict("failed")).toBe("failed");
    expect(normalizeVerdict("passed_with_warnings")).toBe("passed_with_warnings");
  });
  it("defaults unknown/garbage to passed_with_warnings (never silently 'passed')", () => {
    expect(normalizeVerdict("great")).toBe("passed_with_warnings");
    expect(normalizeVerdict(undefined)).toBe("passed_with_warnings");
    expect(normalizeVerdict(42)).toBe("passed_with_warnings");
  });
});

describe("normalizeFindings", () => {
  it("keeps well-formed findings and coerces severity", () => {
    const out = normalizeFindings([
      { severity: "error", message: "drops a column" },
      { severity: "nonsense", message: "no default" },
      { text: "alt message field" },
    ]);
    expect(out).toEqual([
      { severity: "error", message: "drops a column", line: undefined },
      { severity: "info", message: "no default", line: undefined },
      { severity: "info", message: "alt message field", line: undefined },
    ]);
  });
  it("drops entries with no message and non-arrays", () => {
    expect(normalizeFindings([{ severity: "error" }, null, "x"])).toEqual([]);
    expect(normalizeFindings("not an array")).toEqual([]);
    expect(normalizeFindings(undefined)).toEqual([]);
  });
});

describe("reviewMigration degradation", () => {
  const orig = process.env.QODO_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.QODO_API_KEY;
    else process.env.QODO_API_KEY = orig;
  });

  it("skips (does not throw) when QODO_API_KEY is unset — Qodo is advisory", async () => {
    delete process.env.QODO_API_KEY;
    const r = await reviewMigration({ upSql: "ALTER TABLE t ADD COLUMN c int;", downSql: "" });
    expect(r.verdict).toBe("skipped");
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/skipped/i);
  });
});
