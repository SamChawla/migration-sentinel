import { describe, it, expect } from "vitest";
import { isNonTransactional, findExecutorSubversion } from "../src/apply";

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

  it("does NOT treat CONCURRENTLY as a keyword when it's a column identifier (R10 #5)", () => {
    expect(isNonTransactional("ALTER TABLE t ADD COLUMN concurrently int")).toBe(false);
    expect(isNonTransactional("UPDATE t SET concurrently = 1 WHERE id = 2")).toBe(false);
  });

  it("detects REINDEX / REFRESH MATVIEW CONCURRENTLY (R10 #5)", () => {
    expect(isNonTransactional("REINDEX TABLE CONCURRENTLY t")).toBe(true);
    expect(isNonTransactional("REFRESH MATERIALIZED VIEW CONCURRENTLY mv")).toBe(true);
  });

  it("detects ALTER DATABASE ... SET TABLESPACE as autocommit-only (R11 #3)", () => {
    expect(isNonTransactional("ALTER DATABASE app SET TABLESPACE fast_ssd")).toBe(true);
    // ALTER TABLE ... SET TABLESPACE is transactional and must NOT be flagged
    expect(isNonTransactional("ALTER TABLE t SET TABLESPACE fast_ssd")).toBe(false);
  });

  it("treats ALTER TYPE ... ADD VALUE as transactional in PG12+ (R6 #3)", () => {
    // No longer forced to autocommit — running it in the executor's txn lets a
    // later failure roll back atomically instead of leaving the enum value.
    expect(isNonTransactional("ALTER TYPE mood ADD VALUE 'excited'")).toBe(false);
  });

  it("treats a plain multi-statement DDL migration as transactional", () => {
    const sql = "ALTER TABLE a ADD COLUMN x int; ALTER TABLE b ADD COLUMN y int;";
    expect(isNonTransactional(sql)).toBe(false);
  });
});

describe("findExecutorSubversion — guarded-apply contract (R6 #1/#2)", () => {
  it("flags an embedded COMMIT", () => {
    expect(findExecutorSubversion("ALTER TABLE a ADD COLUMN x int; COMMIT;")).toMatch(/transaction-control/);
  });

  it("flags BEGIN / SAVEPOINT / ROLLBACK", () => {
    expect(findExecutorSubversion("BEGIN; UPDATE t SET x=1 WHERE id=1;")).toMatch(/transaction-control/);
    expect(findExecutorSubversion("SAVEPOINT s1")).toMatch(/transaction-control/);
    expect(findExecutorSubversion("ROLLBACK")).toMatch(/transaction-control/);
  });

  it("flags SET statement_timeout / lock_timeout overrides", () => {
    expect(findExecutorSubversion("SET statement_timeout = 0; VACUUM;")).toMatch(/timeout override/);
    expect(findExecutorSubversion("SET LOCAL lock_timeout = 0")).toMatch(/timeout override/);
    expect(findExecutorSubversion("RESET statement_timeout")).toMatch(/RESET of a safety GUC/);
  });

  it("does NOT flag a normal DDL migration", () => {
    expect(findExecutorSubversion("ALTER TABLE users ADD COLUMN age int; CREATE INDEX i ON users (age);")).toBeNull();
  });

  it("does NOT flag SET CONSTRAINTS — it stays within the executor txn (R7 #1)", () => {
    expect(findExecutorSubversion("SET CONSTRAINTS ALL DEFERRED; UPDATE t SET x = 1 WHERE id = 1;")).toBeNull();
  });

  it("does NOT flag COMMIT appearing in a comment or string", () => {
    expect(findExecutorSubversion("ALTER TABLE t ADD COLUMN note text DEFAULT 'please COMMIT often'")).toBeNull();
    expect(findExecutorSubversion("-- remember to COMMIT\nALTER TABLE t ADD COLUMN x int")).toBeNull();
  });

  it("does NOT flag END inside a function body", () => {
    const sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql";
    expect(findExecutorSubversion(sql)).toBeNull();
  });
});
