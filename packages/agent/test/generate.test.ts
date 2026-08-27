import { describe, it, expect } from "vitest";
import { extractJson } from "../src/generate";

/**
 * Regression tests for the Qodo R8 finding: extractJson must not give up when the
 * FIRST brace fragment isn't valid JSON — the real {up,down} object may follow.
 */
describe("extractJson (R8 #1)", () => {
  it("finds the valid object after a non-JSON brace placeholder", () => {
    const text = 'Here is {up,down}: {"up":"CREATE TABLE t()","down":"DROP TABLE t"}';
    const obj = extractJson(text);
    expect(obj).not.toBeNull();
    expect(obj!.up).toBe("CREATE TABLE t()");
    expect(obj!.down).toBe("DROP TABLE t");
  });

  it("parses a clean single object", () => {
    const obj = extractJson('{"up":"a","down":"b","summary":"s"}');
    expect(obj!.up).toBe("a");
  });

  it("handles braces inside JSON string values", () => {
    const obj = extractJson('{"up":"UPDATE t SET j = \'{\\"k\\":1}\'","down":""}');
    expect(obj).not.toBeNull();
    expect(String(obj!.up)).toContain("UPDATE t");
  });

  it("returns null when there is no JSON object at all", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("just {a plain brace phrase}")).toBeNull();
  });

  it("skips multiple invalid fragments before the real one", () => {
    const text = 'note {a} then {b,c} finally {"up":"x","down":"y"} done';
    const obj = extractJson(text);
    expect(obj!.up).toBe("x");
  });
});
