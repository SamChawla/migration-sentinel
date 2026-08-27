import { describe, it, expect } from "vitest";
import { assertReadOnlySelect, ReadOnlySqlError } from "../src/readonly-sql";

/**
 * The copilot's "read-only" promise. These cases are the security contract for
 * query_target_db — a regression here would let the chat mutate a target DB.
 */
describe("assertReadOnlySelect — allows read-only queries", () => {
  it("accepts a plain SELECT", () => {
    expect(assertReadOnlySelect("SELECT count(*) FROM users WHERE email IS NULL")).toMatch(/^SELECT/);
  });

  it("strips a single trailing semicolon", () => {
    expect(assertReadOnlySelect("SELECT 1;")).toBe("SELECT 1");
  });

  it("accepts a read-only CTE (WITH … SELECT)", () => {
    const sql = "WITH t AS (SELECT id FROM orders) SELECT count(*) FROM t";
    expect(assertReadOnlySelect(sql)).toBe(sql);
  });

  it("accepts a leading comment before SELECT", () => {
    expect(assertReadOnlySelect("-- how many?\nSELECT 1")).toBe("-- how many?\nSELECT 1");
  });
});

describe("assertReadOnlySelect — refuses anything that could write", () => {
  const refused: [string, string][] = [
    ["empty", "   "],
    ["DELETE", "DELETE FROM users"],
    ["UPDATE", "UPDATE users SET active = false"],
    ["INSERT", "INSERT INTO users (id) VALUES (1)"],
    ["DROP", "DROP TABLE users"],
    ["TRUNCATE", "TRUNCATE users"],
    ["statement stacking", "SELECT 1; DROP TABLE users"],
    ["comment-hidden DELETE", "/* x */ DELETE FROM users"],
    ["data-modifying CTE", "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d"],
    ["non-select leading", "EXPLAIN ANALYZE DELETE FROM users"],
  ];

  it.each(refused)("refuses %s", (_label, sql) => {
    expect(() => assertReadOnlySelect(sql)).toThrow(ReadOnlySqlError);
  });
});
