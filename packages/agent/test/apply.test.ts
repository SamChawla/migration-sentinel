import { describe, it, expect } from "vitest";
import { isNonTransactional } from "../src/apply";

/**
 * Regression tests for the Qodo PR #4 finding on the guarded apply executor:
 * a keyword hidden in a comment (or a string literal) must NOT flip an
 * otherwise-transactional migration into the non-atomic autocommit path.
 */
describe("isNonTransactional — autocommit detection (R5 #4)", () => {
  it("detects a real CREATE INDEX CONCURRENTLY", () => {
    expect(isNonTransactional("CREATE INDEX CONCURRENTLY idx ON users (email)")).toBe(true);
  });

  it("ignores CONCURRENTLY inside a line comment", () => {
    const sql = "-- run CONCURRENTLY later\nALTER TABLE users ADD COLUMN age int";
    expect(isNonTransactional(sql)).toBe(false);
  });

  it("ignores CONCURRENTLY inside a block comment", () => {
    const sql = "/* CONCURRENTLY */ ALTER TABLE users ADD COLUMN age int";
    expect(isNonTransactional(sql)).toBe(false);
  });

  it("ignores a keyword inside a string literal", () => {
    const sql = "INSERT INTO notes (body) VALUES ('do it CONCURRENTLY please')";
    expect(isNonTransactional(sql)).toBe(false);
  });

  it("still detects ALTER TYPE ... ADD VALUE across statements", () => {
    expect(isNonTransactional("ALTER TYPE mood ADD VALUE 'excited'")).toBe(true);
  });

  it("treats a plain multi-statement DDL migration as transactional", () => {
    const sql = "ALTER TABLE a ADD COLUMN x int; ALTER TABLE b ADD COLUMN y int;";
    expect(isNonTransactional(sql)).toBe(false);
  });
});
