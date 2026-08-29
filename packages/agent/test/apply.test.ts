import { describe, it, expect, vi, beforeEach } from "vitest";
import { isNonTransactional, findExecutorSubversion, applyMigration } from "../src/apply";

vi.mock("@sentinel/db/queries", () => ({
  getRequest: vi.fn(),
  getLatestArtifact: vi.fn(),
  getRequestTargetUrl: vi.fn(),
  getApplyGuardContext: vi.fn(),
  getGithubLink: vi.fn(),
  insertApplyRun: vi.fn(),
  finishApplyRun: vi.fn(),
  setRequestStatus: vi.fn(),
  claimRequestForApply: vi.fn(),
  insertAuditEvent: vi.fn(),
}));
import * as queries from "@sentinel/db/queries";

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

  it("detects ALTER SUBSCRIPTION ... REFRESH/SET PUBLICATION as autocommit-only (R12 #1)", () => {
    expect(isNonTransactional("ALTER SUBSCRIPTION s REFRESH PUBLICATION")).toBe(true);
    expect(isNonTransactional("ALTER SUBSCRIPTION s SET PUBLICATION p1, p2")).toBe(true);
    // ENABLE/DISABLE are transactional
    expect(isNonTransactional("ALTER SUBSCRIPTION s DISABLE")).toBe(false);
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

  it("flags set_config() of a safety GUC — the function form of SET (R13 #1)", () => {
    expect(findExecutorSubversion("SELECT set_config('statement_timeout', '0', false)")).toMatch(/set_config of a safety GUC/);
    expect(findExecutorSubversion("SELECT set_config('lock_timeout','0',true)")).toMatch(/set_config of a safety GUC/);
    // set_config of an UNRELATED GUC, or the name only in a string, must not trip
    expect(findExecutorSubversion("SELECT set_config('search_path', 'public', false)")).toBeNull();
    expect(findExecutorSubversion("INSERT INTO log (msg) VALUES ('set_config(''statement_timeout'')')")).toBeNull();
  });

  it("does NOT flag a normal DDL migration", () => {
    expect(findExecutorSubversion("ALTER TABLE users ADD COLUMN age int; CREATE INDEX i ON users (age);")).toBeNull();
  });

  it("does NOT flag SET CONSTRAINTS — it stays within the executor txn (R7 #1)", () => {
    expect(findExecutorSubversion("SET CONSTRAINTS ALL DEFERRED; UPDATE t SET x = 1 WHERE id = 1;")).toBeNull();
  });

  it("flags PREPARE TRANSACTION / COMMIT PREPARED / ROLLBACK PREPARED (R12 #4)", () => {
    expect(findExecutorSubversion("PREPARE TRANSACTION 'gid1'")).toMatch(/two-phase-commit/);
    expect(findExecutorSubversion("COMMIT PREPARED 'gid1'")).toMatch(/two-phase-commit/);
    expect(findExecutorSubversion("ROLLBACK PREPARED 'gid1'")).toMatch(/two-phase-commit/);
    // a plain prepared STATEMENT is not transaction control
    expect(findExecutorSubversion("PREPARE p AS SELECT 1")).toBeNull();
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

/**
 * PR4 — the pre-claim guards of applyMigration: the export-merge gate (DB-only)
 * and the promotion lock, plus unchanged behaviour when neither applies. The
 * query layer is mocked; each scenario stops BEFORE the one-shot claim (or at
 * it), so no Postgres connection is ever attempted.
 */
describe("applyMigration — pre-claim guards (PR4)", () => {
  const UP = "ALTER TABLE t ADD COLUMN x int;";
  const q = queries as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    q.getRequest.mockResolvedValue({
      id: "r1",
      title: "add col",
      reversibility: "reversible",
      approval: { decision: "approved", requiresTypedConfirm: false, expectedConfirm: null },
    });
    q.getLatestArtifact.mockResolvedValue({ id: "a1", version: 1, upSql: UP, downSql: "" });
    q.getRequestTargetUrl.mockResolvedValue("postgres://postgres:postgres@localhost:5433/prod");
    q.getApplyGuardContext.mockResolvedValue({ environment: "dev", upSql: UP, siblings: [] });
    q.getGithubLink.mockResolvedValue(null);
    // The claim refuses — every scenario that legitimately REACHES the claim
    // ends here with a definite non-throw failure, proving the guards passed.
    q.claimRequestForApply.mockResolvedValue(false);
  });

  it("refuses an UNMERGED export PR — gate 2 has not released the migration", async () => {
    q.getGithubLink.mockResolvedValue({ repo: "o/r", exportPrNumber: 12, exportPrState: "open" });
    await expect(applyMigration("r1")).rejects.toThrow(/not merged/);
    expect(q.claimRequestForApply).not.toHaveBeenCalled();
  });

  it("refuses a prod request with no lower-env applied sibling (promotion lock)", async () => {
    q.getApplyGuardContext.mockResolvedValue({ environment: "prod", upSql: UP, siblings: [] });
    await expect(applyMigration("r1")).rejects.toThrow(/promotion locked/);
    expect(q.claimRequestForApply).not.toHaveBeenCalled();
  });

  it("a MERGED export PR passes the gate and reaches the claim", async () => {
    q.getGithubLink.mockResolvedValue({ repo: "o/r", exportPrNumber: 12, exportPrState: "merged" });
    const result = await applyMigration("r1");
    expect(q.claimRequestForApply).toHaveBeenCalled();
    expect(result.status).toBe("failed"); // the mocked claim refused — nothing ran
    expect(result.error).toMatch(/not in an applicable state/);
  });

  it("no link + non-prod env → behaviour unchanged: straight to the claim", async () => {
    const result = await applyMigration("r1");
    expect(q.claimRequestForApply).toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not in an applicable state/);
  });
});
