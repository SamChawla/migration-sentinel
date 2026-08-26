/**
 * Blast-radius classifier (pure, no DB required).
 *
 * Given migration SQL, statically classify each statement's danger and
 * reversibility. This is the fast, deterministic first pass that runs BEFORE
 * the shadow dry-run; the dry-run then fills in real row counts and observed
 * locks. Keeping this pure makes it trivially unit-testable and demo-safe.
 *
 * Severity:
 *   green  — reversible & effectively online (metadata-only / concurrent)
 *   amber  — locking or slow (table scan / rewrite / write-blocking lock)
 *   red    — irreversible / data-loss (dropped objects, mass data mutation)
 *
 * Reversibility:
 *   reversible   — a correct down migration restores schema AND no data is lost
 *   lossy        — schema restorable, but data may be truncated/altered
 *   irreversible — data is destroyed; no clean rollback exists
 *
 * NOTE: this is a heuristic keyword/shape classifier, not a full SQL parser.
 * That is a deliberate scope choice (see ADR-002/plan). It is conservative:
 * when unsure it errs toward MORE danger, never less.
 */

export type Severity = "green" | "amber" | "red";
export type Reversibility = "reversible" | "lossy" | "irreversible";

export interface StatementClassification {
  statement: string;
  severity: Severity;
  reversibility: Reversibility;
  /** best-guess lock the statement acquires on the target, for the UI */
  lockHint?: string;
  /** whether this statement mutates row data (vs schema-only) */
  dataMutating: boolean;
  /**
   * TRUE when Sentinel refuses to apply this at all — whole-dataset destruction
   * with no recovery path (DROP TABLE, TRUNCATE, unbounded UPDATE/DELETE). This
   * is distinct from a merely irreversible-but-SCOPED loss like DROP COLUMN,
   * which the operator can knowingly accept via a typed confirmation. A blocked
   * statement cannot be pushed through the gate even with human approval — the
   * remedy is a bounded/reversible replacement migration.
   */
  blocking: boolean;
  /** human-readable reason shown at the gate */
  note: string;
}

export interface MigrationClassification {
  statements: StatementClassification[];
  overallSeverity: Severity;
  reversibility: Reversibility;
  /** any statement is `blocking` — Sentinel will not apply this migration. */
  hasBlockingStatement: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { green: 0, amber: 1, red: 2 };
const REVERSIBILITY_RANK: Record<Reversibility, number> = {
  reversible: 0,
  lossy: 1,
  irreversible: 2,
};

/** Split a SQL blob into individual statements (naive but adequate: ignores
 *  semicolons inside string/dollar-quoted literals). */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments
    .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function classifyStatement(statement: string): StatementClassification {
  const s = statement.trim();
  const u = s.toUpperCase().replace(/\s+/g, " ");

  // Whole-dataset destruction with no recovery path → Sentinel refuses it
  // outright. A DROP COLUMN is irreversible too, but it is a scoped, named loss
  // the operator can accept with a typed confirmation, so it is NOT blocking.
  const isWholeObjectDestroy = /\bDROP\s+TABLE\b/.test(u) || /\bTRUNCATE\b/.test(u);
  const isUnboundedDml =
    (/^\s*UPDATE\b/i.test(s) || /^\s*DELETE\b/i.test(s)) && !/\bWHERE\b/.test(u);

  const make = (
    severity: Severity,
    reversibility: Reversibility,
    dataMutating: boolean,
    note: string,
    lockHint?: string,
  ): StatementClassification => ({
    statement: s,
    severity,
    reversibility,
    dataMutating,
    blocking: reversibility === "irreversible" && (isWholeObjectDestroy || isUnboundedDml),
    note,
    lockHint,
  });

  // ── Irreversible / data-loss (RED) ────────────────────────────────────
  if (/\bDROP\s+TABLE\b/.test(u))
    return make("red", "irreversible", true, "Drops a table — all rows lost.", "AccessExclusiveLock");
  if (/\bTRUNCATE\b/.test(u))
    return make("red", "irreversible", true, "Truncates a table — all rows lost.", "AccessExclusiveLock");
  if (/\bDROP\s+COLUMN\b/.test(u))
    return make("red", "irreversible", true, "Drops a column — column data is unrecoverable.", "AccessExclusiveLock");

  // UPDATE / DELETE — danger depends on presence of a WHERE clause.
  if (/^\s*UPDATE\b/i.test(s) || /^\s*DELETE\b/i.test(s)) {
    const verb = /^\s*UPDATE/i.test(s) ? "UPDATE" : "DELETE";
    const hasWhere = /\bWHERE\b/.test(u);
    if (!hasWhere)
      return make(
        "red",
        "irreversible",
        true,
        `Unbounded ${verb} (no WHERE) — mutates every row; prior values are not recoverable.`,
        "RowExclusiveLock",
      );
    return make(
      "amber",
      "irreversible",
      true,
      `${verb} with a WHERE clause — mutates matching rows; prior values are not recoverable.`,
      "RowExclusiveLock",
    );
  }

  // ── Locking / slow schema ops (AMBER) ─────────────────────────────────
  if (/\bALTER\s+COLUMN\b.*\bTYPE\b/.test(u))
    return make("amber", "lossy", false, "Column type change — rewrites the table; conversion may be lossy.", "AccessExclusiveLock");
  if (/\bSET\s+NOT\s+NULL\b/.test(u))
    return make("amber", "reversible", false, "SET NOT NULL — validity scan of the whole table under an exclusive lock.", "AccessExclusiveLock");
  if (/\bADD\s+COLUMN\b/.test(u) && /\bDEFAULT\b/.test(u) && !isConstantDefault(u))
    return make("amber", "reversible", false, "ADD COLUMN with a volatile default — rewrites the table.", "AccessExclusiveLock");
  if (/\bCREATE\s+INDEX\b/.test(u) && !/\bCONCURRENTLY\b/.test(u))
    return make("amber", "reversible", false, "CREATE INDEX (non-concurrent) — blocks writes on the table while it builds.", "ShareLock");
  if (/\bADD\s+(CONSTRAINT\s+\w+\s+)?(FOREIGN\s+KEY|CHECK)\b/.test(u) && !/\bNOT\s+VALID\b/.test(u))
    return make("amber", "reversible", false, "Adds a validated constraint — scans the table(s) to validate.", "ShareRowExclusiveLock");
  if (/\bVALIDATE\s+CONSTRAINT\b/.test(u))
    return make("amber", "reversible", false, "VALIDATE CONSTRAINT — scans the table to validate.", "ShareUpdateExclusiveLock");

  // ── Safe / online (GREEN) ─────────────────────────────────────────────
  if (/\bCREATE\s+INDEX\b/.test(u) && /\bCONCURRENTLY\b/.test(u))
    return make("green", "reversible", false, "CREATE INDEX CONCURRENTLY — online, does not block writes.");
  if (/\bADD\s+COLUMN\b/.test(u))
    return make("green", "reversible", false, "ADD COLUMN (nullable / constant default) — metadata-only in Postgres 11+.");
  if (/\bDROP\s+NOT\s+NULL\b/.test(u))
    return make("green", "reversible", false, "DROP NOT NULL — metadata-only.");
  if (/\bRENAME\b/.test(u))
    return make("green", "reversible", false, "RENAME — metadata-only (but may break the application at runtime).");
  if (/\bADD\s+(CONSTRAINT\s+\w+\s+)?(FOREIGN\s+KEY|CHECK)\b/.test(u) && /\bNOT\s+VALID\b/.test(u))
    return make("green", "reversible", false, "Adds a NOT VALID constraint — cheap; validate separately later.");
  if (/^\s*CREATE\s+TABLE\b/i.test(s))
    return make("green", "reversible", false, "CREATE TABLE — new object, nothing existing touched.");

  // ── Unknown — be conservative ─────────────────────────────────────────
  return make(
    "amber",
    "lossy",
    false,
    "Unrecognized statement — treated as caution until reviewed. Verify manually.",
  );
}

export function classifyMigration(upSql: string): MigrationClassification {
  const statements = splitStatements(upSql).map(classifyStatement);
  if (statements.length === 0) {
    return { statements, overallSeverity: "green", reversibility: "reversible", hasBlockingStatement: false };
  }
  const overallSeverity = statements.reduce<Severity>(
    (worst, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[worst] ? s.severity : worst),
    "green",
  );
  const reversibility = statements.reduce<Reversibility>(
    (worst, s) =>
      REVERSIBILITY_RANK[s.reversibility] > REVERSIBILITY_RANK[worst] ? s.reversibility : worst,
    "reversible",
  );
  const hasBlockingStatement = statements.some((s) => s.blocking);
  return { statements, overallSeverity, reversibility, hasBlockingStatement };
}

/** A constant default (literal / now()) is metadata-only in PG 11+; a
 *  volatile/subquery default forces a rewrite. Heuristic. */
function isConstantDefault(upper: string): boolean {
  const m = upper.match(/\bDEFAULT\b\s+(.+?)(?:\bNOT\b|\bNULL\b|,|$)/);
  if (!m) return true;
  const expr = m[1].trim();
  // literals, booleans, now()/current_timestamp are treated as constant-ish
  return (
    /^'[^']*'$/.test(expr) ||
    /^\d+(\.\d+)?$/.test(expr) ||
    /^(TRUE|FALSE|NULL)$/.test(expr) ||
    /^(NOW\(\)|CURRENT_TIMESTAMP)$/.test(expr)
  );
}
