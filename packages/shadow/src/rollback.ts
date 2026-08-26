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
  // Kept for API compatibility but no longer restricts scope — the fingerprint
  // covers ALL user schemas so a change outside `public` can't look restored.
  _schema = "public",
): Promise<string> {
  // Only user schemas — exclude pg_catalog / information_schema / pg_* internals.
  const NS = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;

  // The set of user schemas ITSELF — otherwise CREATE SCHEMA extra (an empty
  // schema with no objects) leaves every object query unchanged and the hash
  // identical, so an ineffective down would falsely read as schema-restored.
  const schemas = await client.query(
    `SELECT n.nspname AS schema
       FROM pg_namespace n
      WHERE ${NS} ORDER BY 1`,
  );

  // Columns with PRECISE types via format_type (captures varchar(50) vs (100),
  // numeric(10,2), etc. that information_schema.data_type flattens away).
  const columns = await client.query(
    `SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_get_expr(ad.adbin, ad.adrelid) AS "default"
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r','p')
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND ${NS}
      ORDER BY 1, 2, 3`,
  );
  const constraints = await client.query(
    `SELECT n.nspname AS schema, c.conrelid::regclass::text AS table_name,
            c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE ${NS} ORDER BY 1, 2, 3`,
  );
  const indexes = await client.query(
    `SELECT n.nspname AS schema, c.relname AS table_name, ic.relname AS index_name,
            pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NS} ORDER BY 1, 2, 3`,
  );
  // reloptions carries security_barrier / security_invoker — a down that leaves a
  // view with different security semantics must change the hash even if the SQL
  // text (pg_get_viewdef) is identical.
  const views = await client.query(
    `SELECT n.nspname AS schema, c.relname AS view_name, pg_get_viewdef(c.oid) AS def,
            c.reloptions
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND ${NS} ORDER BY 1, 2`,
  );
  // Functions WITH attributes — volatility and SECURITY DEFINER must change the
  // hash (a down that flips a function to SECURITY DEFINER is a real change).
  const routines = await client.query(
    `SELECT n.nspname AS schema, p.proname,
            pg_get_function_identity_arguments(p.oid) AS args, p.prosrc,
            p.provolatile, p.prosecdef, p.prorettype::regtype::text AS rettype, l.lanname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE ${NS} ORDER BY 1, 2, 3`,
  );
  // tgenabled captures the enabled/disabled/replica/always state — a down that
  // fails to re-enable a trigger it disabled must NOT read as schema-restored.
  const triggers = await client.query(
    `SELECT n.nspname AS schema, t.tgname, c.relname AS table_name,
            pg_get_triggerdef(t.oid) AS def, t.tgenabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${NS} ORDER BY 1, 2, 3`,
  );
  // Sequences — a down that recreates a sequence with different bounds/step is
  // a real change the schema (columns+constraints) alone would miss.
  const sequences = await client.query(
    `SELECT schemaname AS schema, sequencename, data_type::text AS type,
            start_value, min_value, max_value, increment_by, cycle
       FROM pg_sequences
      WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema'
      ORDER BY 1, 2`,
  );
  // Sequence OWNED BY dependencies — ALTER SEQUENCE ... OWNED BY changes an auto
  // dependency (pg_depend deptype 'a') that pg_sequences alone doesn't expose, so
  // an un-reverted ownership change would otherwise pass rollback verification.
  const sequenceOwnership = await client.query(
    `SELECT n.nspname AS schema, s.relname AS sequence,
            dn.nspname AS owned_schema, t.relname AS owned_table, a.attname AS owned_column
       FROM pg_class s
       JOIN pg_namespace n ON n.oid = s.relnamespace
       JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a'
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace dn ON dn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      ORDER BY 1, 2`,
  );
  const canonical = JSON.stringify({
    schemas: schemas.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    views: views.rows,
    routines: routines.rows,
    triggers: triggers.rows,
    sequences: sequences.rows,
    sequenceOwnership: sequenceOwnership.rows,
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
