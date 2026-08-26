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

// A PostgreSQL identifier: a double-quoted name (which may contain spaces or
// escaped quotes) OR an unquoted name, optionally schema-qualified.
const IDENT = `(?:"(?:[^"]|"")+"|[\\w$]+)`;
const QIDENT = `${IDENT}(?:\\.${IDENT})*`;

export function requiredPreflightChecks(sql: string): PreflightCheck[] {
  const out: PreflightCheck[] = [];

  for (const stmt of splitStatements(sql)) {
    const tableM = stmt.match(new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QIDENT})`, "i"));
    const table = tableM?.[1] ?? "";
    // A constraint added NOT VALID does not validate existing rows — nothing to
    // pre-flight (probing it would raise a false failure).
    const notValid = /\bNOT\s+VALID\b/i.test(stmt);

    // SET NOT NULL — scan ALL actions (a single ALTER TABLE may list several).
    for (const m of stmt.matchAll(new RegExp(`ALTER\\s+(?:COLUMN\\s+)?(${QIDENT})\\s+SET\\s+NOT\\s+NULL`, "gi"))) {
      const c = m[1];
      out.push({
        kind: "not_null",
        table,
        probeSql: `SELECT count(*) AS violations FROM ${table} WHERE ${c} IS NULL`,
        failIfPositive: true,
        description: `Rows where ${c} IS NULL will block SET NOT NULL — a backfill is required first.`,
      });
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
    }

    // ADD UNIQUE [NULLS [NOT] DISTINCT] (cols)
    for (const m of stmt.matchAll(
      new RegExp(`ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?UNIQUE\\s*(NULLS\\s+(?:NOT\\s+)?DISTINCT\\s*)?\\(([^)]+)\\)`, "gi"),
    )) {
      const nullsNotDistinct = /NOT\s+DISTINCT/i.test(m[1] ?? "");
      const cols = m[2].trim();
      const colList = cols.split(",").map((x) => x.trim());
      // NULLS NOT DISTINCT → null keys DO collide, so don't exclude them. Under
      // the default NULLS DISTINCT they never collide, so exclude null-bearing rows.
      const where = nullsNotDistinct
        ? ""
        : ` WHERE ${colList.map((c) => `${c} IS NOT NULL`).join(" AND ")}`;
      out.push({
        kind: "unique",
        table,
        probeSql: `SELECT count(*) AS violations FROM (SELECT ${cols} FROM ${table}${where} GROUP BY ${cols} HAVING count(*) > 1) dup`,
        failIfPositive: true,
        description: `Duplicate ${nullsNotDistinct ? "" : "non-null "}(${cols}) values will block the UNIQUE constraint.`,
      });
    }

    // ADD CHECK (expr) [NO INHERIT] — skipped when NOT VALID.
    if (!notValid) {
      for (const m of stmt.matchAll(
        new RegExp(`ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?CHECK\\s*\\((.+?)\\)\\s*(?:NO\\s+INHERIT)?\\s*(?:NOT\\s+VALID)?\\s*(?:,|$)`, "gi"),
      )) {
        const expr = m[1].trim();
        out.push({
          kind: "check",
          table,
          probeSql: `SELECT count(*) AS violations FROM ${table} WHERE NOT (${expr})`,
          failIfPositive: true,
          description: `Existing rows violating CHECK (${expr}) will block it.`,
        });
      }
    }

    // ADD FOREIGN KEY (cols) REFERENCES parent [(pcols)] [MATCH FULL] — skipped when NOT VALID.
    if (!notValid) {
      for (const m of stmt.matchAll(
        new RegExp(
          `ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s*REFERENCES\\s+(${QIDENT})\\s*(?:\\(([^)]+)\\))?\\s*(MATCH\\s+FULL)?`,
          "gi",
        ),
      )) {
        const ptable = m[2];
        const matchFull = Boolean(m[4]);
        const cols = m[1].split(",").map((x) => x.trim());
        if (!m[3]) {
          // REFERENCES parent (implicit primary key) — the parent's PK columns
          // aren't known statically, so flag it for review rather than skip it.
          out.push({
            kind: "foreign_key",
            table,
            probeSql: null,
            failIfPositive: true,
            description: `Foreign key references ${ptable}'s primary key implicitly — orphan-row check needs the parent PK columns; manual review.`,
          });
          continue;
        }
        const pcols = m[3].split(",").map((x) => x.trim());
        const join = cols.map((c, i) => `p.${pcols[i]} = c.${c}`).join(" AND ");
        let where: string;
        if (matchFull) {
          // MATCH FULL: only all-null rows are exempt; a partially-null key is a violation.
          const allNull = cols.map((c) => `c.${c} IS NULL`).join(" AND ");
          const anyNull = cols.map((c) => `c.${c} IS NULL`).join(" OR ");
          where = `NOT (${allNull}) AND ((${anyNull}) OR NOT EXISTS (SELECT 1 FROM ${ptable} p WHERE ${join}))`;
        } else {
          // MATCH SIMPLE (default): rows with any null key are exempt.
          const allNotNull = cols.map((c) => `c.${c} IS NOT NULL`).join(" AND ");
          where = `${allNotNull} AND NOT EXISTS (SELECT 1 FROM ${ptable} p WHERE ${join})`;
        }
        out.push({
          kind: "foreign_key",
          table,
          probeSql: `SELECT count(*) AS violations FROM ${table} c WHERE ${where}`,
          failIfPositive: true,
          description: `Orphan rows with no matching ${ptable}(${m[3]}) will block the foreign key${matchFull ? " (MATCH FULL)" : ""}.`,
        });
      }
    }

    // ALTER COLUMN ... TYPE — can fail on non-castable values; no safe generic probe.
    if (new RegExp(`ALTER\\s+(?:COLUMN\\s+)?${QIDENT}\\s+(?:SET\\s+DATA\\s+)?TYPE\\b`, "i").test(stmt)) {
      out.push({
        kind: "type_change",
        table,
        probeSql: null,
        failIfPositive: true,
        description: `Type change may fail on values that don't cast cleanly — review or supply a USING clause. No automatic probe generated.`,
      });
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
