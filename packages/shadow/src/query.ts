/**
 * Read-only interrogation guard (ADR-009).
 *
 * The blast-radius "ask" box turns NL → SQL. This module makes that SQL
 * physically incapable of mutating anything, WITHOUT trusting the model:
 *
 *   1. assertReadOnly() — allowlist: exactly one statement, starting with
 *      SELECT or WITH, containing no write/DDL keywords.
 *   2. runReadOnlyQuery() — executes inside `SET TRANSACTION READ ONLY` with a
 *      statement_timeout, and rolls back. Combined with a DB role that only has
 *      SELECT, this is belt-and-suspenders: any one layer alone rejects a write.
 *
 * If any guard is missing at runtime, the feature must not be exposed (ADR-009).
 */
import type { Client } from "pg";
import { splitStatements, codeOnly } from "./blast";

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|LOCK|COMMENT|SECURITY\s+LABEL|REFRESH|SET|RESET|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|ABORT)\b/i;

// State-mutating / session-escaping functions that survive a read-only txn +
// rollback (session advisory locks, sequence mutation, config, file/network I/O).
const FORBIDDEN_FUNCTIONS =
  /\b(pg_advisory\w*|nextval|setval|set_config|dblink\w*|lo_import|lo_export|pg_read_file|pg_ls_dir|pg_sleep)\b/i;

export class ReadOnlyViolation extends Error {}

/** Throws ReadOnlyViolation unless `sql` is a single, pure read query. */
export function assertReadOnly(sql: string): void {
  const statements = splitStatements(sql);
  if (statements.length === 0) throw new ReadOnlyViolation("Empty query.");
  if (statements.length > 1) {
    throw new ReadOnlyViolation("Only a single statement is allowed (no ';'-chaining).");
  }
  const stmt = statements[0];
  // Keyword/function checks run on the code-only form so a harmless returned
  // literal — SELECT 'DELETE', SELECT $$DROP TABLE$$ — is not misread as a write.
  const code = codeOnly(stmt);
  const head = code.trimStart().toUpperCase();
  if (!/^(SELECT|WITH)\b/.test(head)) {
    throw new ReadOnlyViolation("Read-only queries only — must start with SELECT or WITH.");
  }
  // `WITH ... ( ... )` CTEs can hide a writable statement (INSERT/UPDATE/DELETE
  // inside a CTE), so scan the whole thing for write/DDL keywords too.
  if (FORBIDDEN.test(code)) {
    throw new ReadOnlyViolation("Query contains a write or DDL keyword — rejected.");
  }
  if (FORBIDDEN_FUNCTIONS.test(code)) {
    throw new ReadOnlyViolation("Query calls a state-mutating or session-escaping function — rejected.");
  }
}

export interface ReadOnlyResult {
  sql: string;
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * Run a validated read-only query on a shadow/read-only client. Enforces a
 * read-only transaction + timeout + row cap on top of assertReadOnly().
 */
export async function runReadOnlyQuery(
  client: Client,
  sql: string,
  opts: { timeoutMs?: number; rowCap?: number } = {},
): Promise<ReadOnlyResult> {
  assertReadOnly(sql);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const rowCap = opts.rowCap ?? 500;

  // Cap at the DATABASE, not in memory: wrapping the validated read in a
  // subquery with LIMIT means Postgres never streams more than rowCap+1 rows
  // back, so a `SELECT * FROM huge_table` can't buffer the whole table.
  const inner = sql.trim().replace(/;\s*$/, "");
  const capped = `SELECT * FROM (${inner}) AS _capped LIMIT ${Number(rowCap) + 1}`;

  await client.query("BEGIN");
  try {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    const res = await client.query(capped);
    const truncated = res.rows.length > rowCap;
    const rows = truncated ? res.rows.slice(0, rowCap) : res.rows;
    return { sql, rows, truncated };
  } finally {
    await client.query("ROLLBACK");
  }
}
