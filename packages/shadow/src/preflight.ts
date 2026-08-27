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

/** Split on top-level commas, respecting parens and single/double-quoted text.
 *  Used to break one ALTER TABLE into its individual actions so each is analyzed
 *  on its own (NOT VALID, DEFAULT, etc. are per-action, not statement-wide). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inS) {
      cur += ch;
      if (ch === "'") (s[i + 1] === "'" ? ((cur += "'"), i++) : (inS = false));
      continue;
    }
    if (inD) {
      cur += ch;
      if (ch === '"') (s[i + 1] === '"' ? ((cur += '"'), i++) : (inD = false));
      continue;
    }
    if (ch === "'") inS = true;
    else if (ch === '"') inD = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Extract the balanced `(...)` starting at openIdx, quote-aware (handles nested
 *  parens like CHECK (coalesce(age, 0) >= 0)). Returns content + index after `)`. */
function firstBalanced(s: string, openIdx: number): { content: string; end: number } | null {
  if (s[openIdx] !== "(") return null;
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inS) {
      if (ch === "'") (s[i + 1] === "'" ? i++ : (inS = false));
      continue;
    }
    if (inD) {
      if (ch === '"') (s[i + 1] === '"' ? i++ : (inD = false));
      continue;
    }
    if (ch === "'") inS = true;
    else if (ch === '"') inD = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { content: s.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** True if the string has whitespace at paren-depth 0 outside any quote — i.e. a
 *  key element carries a per-key option (ASC/DESC, NULLS FIRST/LAST, COLLATE, or
 *  an operator class like `text_pattern_ops`) rather than being a bare column or
 *  a single parenthesised expression. Such keys can't be dropped verbatim into a
 *  probe, so we degrade them to manual review instead of inventing invalid SQL. */
function hasTopLevelSpace(s: string): boolean {
  let depth = 0, inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === "'") { if (s[i + 1] === "'") i++; else inS = false; } continue; }
    if (inD) { if (c === '"') { if (s[i + 1] === '"') i++; else inD = false; } continue; }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(c)) return true;
  }
  return false;
}

/** Parse the tail of a CREATE UNIQUE INDEX after its key list, respecting quotes
 *  and parenthesised clauses (INCLUDE (...), WITH (...)). Finds the index's own
 *  top-level NULLS NOT DISTINCT and WHERE — so a `WHERE` that only appears inside
 *  an INCLUDE ("where") identifier or a WITH option can't invent a partial
 *  predicate. Returns the raw predicate text (after WHERE) when present. */
function indexTailClauses(tail: string): { nullsNotDistinct: boolean; predicate?: string } {
  let depth = 0, inS = false, inD = false;
  let nullsNotDistinct = false;
  let predicate: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (inS) { if (c === "'") { if (tail[i + 1] === "'") i++; else inS = false; } continue; }
    if (inD) { if (c === '"') { if (tail[i + 1] === '"') i++; else inD = false; } continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const boundary = i === 0 || /\W/.test(tail[i - 1]);
    if (!boundary) continue;
    const rest = tail.slice(i);
    if (!predicate && /^where\b/i.test(rest)) {
      predicate = rest.replace(/^where\b/i, "").trim() || undefined;
      break; // predicate runs to the end of the statement
    }
    if (/^nulls\s+not\s+distinct\b/i.test(rest)) nullsNotDistinct = true;
  }
  return { nullsNotDistinct, predicate };
}

export function requiredPreflightChecks(sql: string): PreflightCheck[] {
  const out: PreflightCheck[] = [];

  const uniqueProbe = (table: string, cols: string, nullsNotDistinct: boolean, label: string, extraWhere?: string) => {
    const colList = splitTopLevel(cols);
    const conds: string[] = [];
    if (!nullsNotDistinct) conds.push(...colList.map((c) => `${c} IS NOT NULL`));
    // A partial unique index only enforces uniqueness where its predicate holds.
    if (extraWhere?.trim()) conds.push(`(${extraWhere.trim()})`);
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    out.push({
      kind: "unique",
      table,
      probeSql: `SELECT count(*) AS violations FROM (SELECT ${cols} FROM ${table}${where} GROUP BY ${cols} HAVING count(*) > 1) dup`,
      failIfPositive: true,
      description: `Duplicate ${nullsNotDistinct ? "" : "non-null "}(${cols})${extraWhere ? " (partial)" : ""} values will block the ${label}.`,
    });
  };

  for (const stmt of splitStatements(sql)) {
    // CREATE UNIQUE INDEX ... ON table ( key… ) [NULLS [NOT] DISTINCT] [WHERE pred]
    // Match only up to the opening paren, then take the BALANCED key list so an
    // expression key like (lower(email)) isn't truncated at its inner ')'.
    const ciHead = stmt.match(
      new RegExp(
        `CREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${QIDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${QIDENT})\\s*(?:USING\\s+${IDENT}\\s*)?\\(`,
        "i",
      ),
    );
    if (ciHead) {
      const openIdx = ciHead.index! + ciHead[0].length - 1; // the '(' position
      const bal = firstBalanced(stmt, openIdx);
      if (bal) {
        const tail = stmt.slice(bal.end);
        const keyCols = splitTopLevel(bal.content);
        // A key with a per-key option (sort order / NULLS / COLLATE / opclass)
        // can't be dropped verbatim into SELECT/GROUP BY — degrade to manual
        // review rather than emit invalid probe SQL.
        if (keyCols.some(hasTopLevelSpace)) {
          out.push({
            kind: "unique",
            table: ciHead[1],
            probeSql: null,
            failIfPositive: true,
            description: `Unique index with per-key options (sort order / COLLATE / operator class) — an exact duplicate probe isn't derivable; manual review.`,
          });
          continue;
        }
        // NULLS NOT DISTINCT makes NULL keys collide too, so they must NOT be
        // excluded from the duplicate probe; WHERE/NULLS are located structurally
        // (skipping INCLUDE(...)/WITH(...) and quoted identifiers).
        const { nullsNotDistinct, predicate } = indexTailClauses(tail);
        uniqueProbe(ciHead[1], bal.content.trim(), nullsNotDistinct, "UNIQUE INDEX", predicate);
        continue;
      }
    }

    const tableM = stmt.match(new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QIDENT})\\s+([\\s\\S]+)$`, "i"));
    if (!tableM) continue;
    const table = tableM[1];

    // Analyze EACH action independently — NOT VALID / DEFAULT bind to their own action.
    for (const action of splitTopLevel(tableM[2])) {
      const notValid = /\bNOT\s+VALID\b/i.test(action);

      // VALIDATE CONSTRAINT — re-checks existing rows against a previously
      // NOT VALID constraint; it CAN fail on data, but the predicate isn't in
      // this statement, so flag for review rather than skip.
      if (/^\s*VALIDATE\s+CONSTRAINT\b/i.test(action)) {
        out.push({
          kind: "check",
          table,
          probeSql: null,
          failIfPositive: true,
          description: `VALIDATE CONSTRAINT re-checks existing rows; the constraint predicate isn't in this statement — manual review.`,
        });
        continue;
      }

      // ADD EXCLUDE — exclusion constraints use operator-based conflicts with no
      // simple aggregate row probe; flag for review rather than skip.
      if (!notValid && new RegExp(`^\\s*ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?EXCLUDE\\b`, "i").test(action)) {
        out.push({
          kind: "check",
          table,
          probeSql: null,
          failIfPositive: true,
          description: `EXCLUDE constraint — operator-based conflicts have no simple aggregate probe; manual review.`,
        });
        continue;
      }

      let m = action.match(new RegExp(`ALTER\\s+(?:COLUMN\\s+)?(${QIDENT})\\s+SET\\s+NOT\\s+NULL`, "i"));
      if (m) {
        out.push({
          kind: "not_null",
          table,
          probeSql: `SELECT count(*) AS violations FROM ${table} WHERE ${m[1]} IS NULL`,
          failIfPositive: true,
          description: `Rows where ${m[1]} IS NULL will block SET NOT NULL — a backfill is required first.`,
        });
        continue;
      }

      // ADD COLUMN ... NOT NULL without DEFAULT — checked on THIS action only.
      if (/^\s*ADD\s+COLUMN\b/i.test(action) && /\bNOT\s+NULL\b/i.test(action) && !/\bDEFAULT\b/i.test(action)) {
        out.push({
          kind: "add_notnull_no_default",
          table,
          probeSql: `SELECT count(*) AS violations FROM ${table}`,
          failIfPositive: true,
          description: `Adding a NOT NULL column with no DEFAULT fails if the table has any rows — add a DEFAULT or backfill.`,
        });
        continue;
      }

      // ADD PRIMARY KEY (cols) — requires both non-null AND unique.
      m = action.match(new RegExp(`ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?PRIMARY\\s+KEY\\s*\\(([^)]+)\\)`, "i"));
      if (m) {
        const cols = m[1].trim();
        const colList = splitTopLevel(cols);
        out.push({
          kind: "not_null",
          table,
          probeSql: `SELECT count(*) AS violations FROM ${table} WHERE ${colList.map((c) => `${c} IS NULL`).join(" OR ")}`,
          failIfPositive: true,
          description: `Rows with NULL in (${cols}) will block the PRIMARY KEY.`,
        });
        uniqueProbe(table, cols, false, "PRIMARY KEY");
        continue;
      }

      m = action.match(new RegExp(`ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?UNIQUE\\s*(NULLS\\s+(?:NOT\\s+)?DISTINCT\\s*)?\\(([^)]+)\\)`, "i"));
      if (m) {
        uniqueProbe(table, m[2].trim(), /NOT\s+DISTINCT/i.test(m[1] ?? ""), "UNIQUE constraint");
        continue;
      }

      // ADD CHECK (balanced expr) [NO INHERIT] [NOT VALID] — this action's NOT VALID.
      if (/^\s*ADD\b/i.test(action)) {
        const cm = action.match(/\bCHECK\s*\(/i);
        if (cm) {
          const bal = firstBalanced(action, action.indexOf("(", cm.index!));
          if (bal) {
            if (!/\bNOT\s+VALID\b/i.test(action.slice(bal.end))) {
              out.push({
                kind: "check",
                table,
                probeSql: `SELECT count(*) AS violations FROM ${table} WHERE NOT (${bal.content.trim()})`,
                failIfPositive: true,
                description: `Existing rows violating CHECK (${bal.content.trim()}) will block it.`,
              });
            }
            continue;
          }
        }
      }

      // ADD FOREIGN KEY (cols) REFERENCES parent [(pcols)] [MATCH FULL] — this action's NOT VALID.
      m = action.match(
        new RegExp(
          `ADD\\s+(?:CONSTRAINT\\s+${QIDENT}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s*REFERENCES\\s+(${QIDENT})\\s*(?:\\(([^)]+)\\))?\\s*(MATCH\\s+FULL)?`,
          "i",
        ),
      );
      if (m) {
        if (notValid) continue;
        const ptable = m[2];
        const matchFull = Boolean(m[4]);
        const cols = m[1].split(",").map((x) => x.trim());
        if (!m[3]) {
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
          const allNull = cols.map((c) => `c.${c} IS NULL`).join(" AND ");
          const anyNull = cols.map((c) => `c.${c} IS NULL`).join(" OR ");
          where = `NOT (${allNull}) AND ((${anyNull}) OR NOT EXISTS (SELECT 1 FROM ${ptable} p WHERE ${join}))`;
        } else {
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
        continue;
      }

      if (new RegExp(`ALTER\\s+(?:COLUMN\\s+)?${QIDENT}\\s+(?:SET\\s+DATA\\s+)?TYPE\\b`, "i").test(action)) {
        out.push({
          kind: "type_change",
          table,
          probeSql: null,
          failIfPositive: true,
          description: `Type change may fail on values that don't cast cleanly — review or supply a USING clause. No automatic probe generated.`,
        });
      }
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
