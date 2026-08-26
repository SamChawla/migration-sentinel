/**
 * Rollback verifier (requires a live shadow Postgres).
 *
 * Proves — on a disposable shadow DB — whether applying `up` then `down`
 * returns the database to its starting state. It computes a schema fingerprint
 * before/after-up/after-down and compares.
 *
 * CRITICAL honesty rule (see ADR-006): schema restoration is necessary but NOT
 * sufficient. A `DROP COLUMN` whose `down` re-adds the column restores the
 * schema fingerprint yet destroys data. So the final `rollbackVerified` verdict
 * is:
 *
 *     rollbackVerified = schemaRestored AND (migration is not data-mutating)
 *
 * where "data-mutating" comes from the static classifier. This is why a
 * DROP COLUMN or an unbounded UPDATE reports rollbackVerified = false even
 * though the schema comes back.
 */
import type { Client } from "pg";
import { createHash } from "node:crypto";
import { classifyMigration, splitStatements } from "./blast";

export interface RollbackResult {
  schemaBefore: string;
  schemaAfterUp: string;
  schemaAfterDown: string;
  /** did the schema fingerprint return to its original value? */
  schemaRestored: boolean;
  /** does the up migration mutate row data (static analysis)? */
  dataMutating: boolean;
  /** the honest verdict: schema restored AND no data mutation */
  rollbackVerified: boolean;
}

/**
 * Canonical fingerprint of the `public` schema: columns + constraints,
 * deterministically ordered and hashed. Sensitive to add/drop/rename column,
 * type changes, nullability, and constraints — everything a migration touches.
 */
export async function schemaFingerprint(
  client: Client,
  schema = "public",
): Promise<string> {
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, column_name`,
    [schema],
  );
  // Full constraint DEFINITIONS (not just name+type): a down migration that
  // recreates a CHECK/FK/UNIQUE under the same name but a different definition
  // must change the fingerprint.
  const constraints = await client.query(
    `SELECT c.conrelid::regclass::text AS table_name,
            c.conname AS constraint_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1
      ORDER BY 1, 2`,
    [schema],
  );
  // Indexes are migration-relevant too — a down that rebuilds an index on the
  // wrong columns restores the columns but not the index.
  const indexes = await client.query(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = $1
      ORDER BY tablename, indexname`,
    [schema],
  );
  const canonical = JSON.stringify({
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function runSql(client: Client, sql: string): Promise<void> {
  for (const stmt of splitStatements(sql)) {
    await client.query(stmt);
  }
}

/**
 * Apply up then down on the given (shadow) client and report the verdict.
 * The caller owns the shadow lifecycle; wrap in a transaction you roll back
 * if you want the shadow left untouched.
 */
export async function verifyRollback(
  client: Client,
  up: string,
  down: string,
): Promise<RollbackResult> {
  const schemaBefore = await schemaFingerprint(client);

  await runSql(client, up);
  const schemaAfterUp = await schemaFingerprint(client);

  await runSql(client, down);
  const schemaAfterDown = await schemaFingerprint(client);

  const schemaRestored = schemaBefore === schemaAfterDown;
  const dataMutating = classifyMigration(up).statements.some((s) => s.dataMutating);

  return {
    schemaBefore,
    schemaAfterUp,
    schemaAfterDown,
    schemaRestored,
    dataMutating,
    rollbackVerified: schemaRestored && !dataMutating,
  };
}
