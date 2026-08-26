/**
 * Data pre-flight checks (ADR-011).
 *
 * The schema-only shadow catches SYNTAX and proves schema ROLLBACK, but it is
 * blind to DATA-dependent failures — a migration that is valid DDL yet fails at
 * apply time because existing rows violate a new constraint:
 *   - SET NOT NULL          → fails if any row is NULL
 *   - ADD COLUMN ... NOT NULL (no default) → fails if the table has any rows
 *   - ADD UNIQUE            → fails if duplicate values exist
 *   - ADD CHECK             → fails if existing rows violate the predicate
 *   - ADD FOREIGN KEY       → fails if orphan rows exist
 *
 * For these we derive an EXACT, READ-ONLY aggregate probe and run it against the
 * REAL target (not a sample) to know — before the gate — whether the data will
 * block the migration, and by how much. When it will fail, the agent asks the
 * human for a backfill value and regenerates a safe two-phase migration.
 *
 * `requiredPreflightChecks` is pure (no DB) and unit-tested. `runPreflight`
 * executes the probes read-only.
 */
import type { Client } from "pg";
import { splitStatements } from "./blast";
import { runReadOnlyQuery } from "./query";

export type PreflightKind =
  | "not_null"
  | "add_notnull_no_default"
  | "unique"
  | "check"
  | "foreign_key"
  | "type_change";

export interface PreflightCheck {
  kind: PreflightKind;
  table: string;
  /** read-only COUNT probe; null when it can't be auto-derived (needs review) */
  probeSql: string | null;
  /** the migration fails if the probe returns a positive count */
  failIfPositive: boolean;
  description: string;
}

/** True when a migration has any data-dependent risk. */
export function isDataDependent(sql: string): boolean {
  return requiredPreflightChecks(sql).length > 0;
}

export function requiredPreflightChecks(sql: string): PreflightCheck[] {
  const out: PreflightCheck[] = [];

  for (const stmt of splitStatements(sql)) {
    const tableM = stmt.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.\"]+)/i);
    const table = tableM?.[1] ?? "";

    // SET NOT NULL
    let m = stmt.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.\"]+)\s+ALTER\s+(?:COLUMN\s+)?([\w\"]+)\s+SET\s+NOT\s+NULL/i);
    if (m) {
      const [, t, c] = m;
      out.push({
        kind: "not_null",
        table: t,
        probeSql: `SELECT count(*) AS violations FROM ${t} WHERE ${c} IS NULL`,
        failIfPositive: true,
        description: `Rows where ${c} IS NULL will block SET NOT NULL — a backfill is required first.`,
      });
      continue;
    }

    // ADD COLUMN ... NOT NULL without DEFAULT
    if (/ADD\s+COLUMN\b/i.test(stmt) && /\bNOT\s+NULL\b/i.test(stmt) && !/\bDEFAULT\b/i.test(stmt)) {
      out.push({
        kind: "add_notnull_no_default",
        table,
        probeSql: `SELECT count(*) AS violations FROM ${table}`,
        failIfPositive: true,
        description: `Adding a NOT NULL column with no DEFAULT fails if the table has any rows — add a DEFAULT or backfill.`,
      });
      continue;
    }

    // ADD UNIQUE (cols)
    m = stmt.match(/ADD\s+(?:CONSTRAINT\s+[\w\"]+\s+)?UNIQUE\s*\(([^)]+)\)/i);
    if (m) {
      const cols = m[1].trim();
      out.push({
        kind: "unique",
        table,
        probeSql: `SELECT count(*) AS violations FROM (SELECT ${cols} FROM ${table} GROUP BY ${cols} HAVING count(*) > 1) dup`,
        failIfPositive: true,
        description: `Duplicate (${cols}) values will block the UNIQUE constraint.`,
      });
      continue;
    }

    // ADD CHECK (expr)
    m = stmt.match(/ADD\s+(?:CONSTRAINT\s+[\w\"]+\s+)?CHECK\s*\((.+?)\)\s*(?:NOT\s+VALID)?\s*$/i);
    if (m) {
      const expr = m[1].trim();
      out.push({
        kind: "check",
        table,
        probeSql: `SELECT count(*) AS violations FROM ${table} WHERE NOT (${expr})`,
        failIfPositive: true,
        description: `Existing rows violating CHECK (${expr}) will block it.`,
      });
      continue;
    }

    // ADD FOREIGN KEY (col) REFERENCES parent(pcol)
    m = stmt.match(/ADD\s+(?:CONSTRAINT\s+[\w\"]+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([\w.\"]+)\s*\(([^)]+)\)/i);
    if (m) {
      const [, col, ptable, pcol] = m;
      const c = col.trim();
      const pc = pcol.trim();
      out.push({
        kind: "foreign_key",
        table,
        probeSql: `SELECT count(*) AS violations FROM ${table} c WHERE c.${c} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ptable} p WHERE p.${pc} = c.${c})`,
        failIfPositive: true,
        description: `Orphan rows with no matching ${ptable}.${pc} will block the foreign key.`,
      });
      continue;
    }

    // ALTER COLUMN ... TYPE — can fail on non-castable values; no safe generic probe
    if (/ALTER\s+(?:COLUMN\s+)?[\w\"]+\s+TYPE\b/i.test(stmt)) {
      out.push({
        kind: "type_change",
        table,
        probeSql: null,
        failIfPositive: true,
        description: `Type change may fail on values that don't cast cleanly — review or supply a USING clause. No automatic probe generated.`,
      });
      continue;
    }
  }

  return out;
}

export interface PreflightResult {
  check: PreflightCheck;
  violations: number | null; // null when no probe could be derived OR it degraded
  willFail: boolean | null; // null → could not be evaluated (review required)
  /** the probe could not complete (e.g. timed out on a large table). */
  degraded?: boolean;
  /** why it could not be evaluated, for the console. */
  reason?: string;
}

/**
 * Aggressive hard cap for pre-flight probes on the REAL target (ADR-011 safety
 * hardening). These probes are read-only, but an un-indexed COUNT on a huge
 * table can still hammer production — the product's whole thesis is not to harm
 * the DB it is protecting. If a probe can't finish inside this budget we DEGRADE
 * to "manual review required" rather than hold a scan open.
 */
export const PREFLIGHT_TIMEOUT_MS = 3000;

/** Run the derived probes read-only against a target/shadow client. */
export async function runPreflight(client: Client, sql: string): Promise<PreflightResult[]> {
  const checks = requiredPreflightChecks(sql);
  const results: PreflightResult[] = [];
  for (const check of checks) {
    if (!check.probeSql) {
      results.push({
        check,
        violations: null,
        willFail: null,
        reason: "No automatic probe could be derived — manual review required.",
      });
      continue;
    }
    try {
      const r = await runReadOnlyQuery(client, check.probeSql, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      const violations = Number((r.rows[0] as { violations?: number })?.violations ?? 0);
      results.push({ check, violations, willFail: check.failIfPositive ? violations > 0 : violations === 0 });
    } catch (e) {
      // A statement_timeout (or any probe failure) must NOT be read as "safe".
      // Degrade gracefully: the operator is told the data could not be proven.
      results.push({
        check,
        violations: null,
        willFail: null,
        degraded: true,
        reason: `Table too large to probe within ${PREFLIGHT_TIMEOUT_MS}ms — data safety could not be proven; manual review required. (${(e as Error).message})`,
      });
    }
  }
  return results;
}
