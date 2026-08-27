/**
 * Read-only SQL guard — the safety invariant behind the copilot's `query_target_db`
 * tool. The copilot may only ever run a SINGLE read-only SELECT/WITH statement
 * against a target database; anything that could mutate data or schema is refused
 * here by shape (and again at run time by a READ ONLY transaction). This lives in
 * the deterministic core so the promise "the copilot is read-only" is unit-tested,
 * not asserted only in the web layer.
 */

export class ReadOnlySqlError extends Error {}

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|merge|call|do|vacuum|reindex|comment|lock)\b/i;

/**
 * Assert that `raw` is a single read-only SELECT/WITH query and return the
 * normalized statement (trailing `;` stripped). Throws ReadOnlySqlError otherwise.
 *
 * Defenses:
 *  - exactly one statement (no embedded `;` → no statement stacking)
 *  - leading keyword must be SELECT or WITH, checked AFTER stripping leading
 *    comments so `/*  * / delete …` can't slip past
 *  - no write/DDL keyword anywhere — this also refuses data-modifying CTEs
 *    (`WITH d AS (DELETE … RETURNING *) SELECT …`) that begin with WITH
 */
export function assertReadOnlySelect(raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/, ""); // tolerate a single trailing ;
  if (!sql) throw new ReadOnlySqlError("Empty query.");
  if (sql.includes(";")) throw new ReadOnlySqlError("Only a single statement is allowed.");

  const bare = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g, "").trimStart();
  if (!/^(select|with)\b/i.test(bare)) {
    throw new ReadOnlySqlError("Only SELECT / WITH (read-only) queries are allowed.");
  }
  if (WRITE_KEYWORDS.test(bare)) {
    throw new ReadOnlySqlError("Query contains a write/DDL keyword and was refused.");
  }
  return sql;
}
