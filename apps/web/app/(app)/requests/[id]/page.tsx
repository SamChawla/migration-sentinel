import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequest, getPromotionGroup, getApplyGuardContext } from "@sentinel/db/queries";
import { classifyMigration } from "@sentinel/shadow";
import {
  gateDisposition,
  dispositionLabel,
  escalateForEnvironment,
  promotionEligible,
} from "@sentinel/core";
import { SeverityChip, StatusChip } from "@/components/chips";
import { EnvBadge } from "@/components/EnvBadge";
import { PromotionRail } from "@/components/console/PromotionRail";
import { StatReadout, EnergyProgressBar } from "@/components/instruments/Readouts";
import { SqlWell } from "@/components/console/SqlWell";
import { CommitConsole } from "@/components/console/CommitConsole";
import { MigrationChat } from "@/components/console/MigrationChat";
import { SchemaErd, type SceneTable, type FkEdge } from "@/components/scene/SchemaErd";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

const PHASES = ["Generate", "Review", "Dry-run", "Gate", "Apply"];

type PhaseRecord = { status: string; findings: unknown[]; upSql?: string };

function phaseIndex(r: PhaseRecord): number {
  switch (r.status) {
    case "received": case "generating": return 0;
    case "reviewing": return 1;
    case "dry_running": return 2;
    case "awaiting_approval": case "approved": case "rejected": case "blocked": return 3;
    case "applying": case "applied": case "rolled_back": return 4;
    case "failed":
      // A failure can happen at ANY phase — infer the furthest one reached from
      // persisted evidence so an early (config/generate/review/dry-run) failure
      // isn't shown as a completed Apply. Never claim more progress than we have.
      if (r.findings.length > 0) return 3;          // analysis produced a report
      if (r.upSql && r.upSql.trim()) return 1;      // generated, but no analysis
      return 0;                                     // failed at/ before generate
    default: return 0;
  }
}

function phasePercent(r: PhaseRecord): number {
  const i = phaseIndex(r);
  // Only a genuinely COMPLETED terminal run is 100%. A 'failed' run stopped at
  // its reached phase, so it must NOT render as fully complete.
  if (r.status === "applied" || r.status === "rolled_back") return 100;
  return ((i + 0.5) / PHASES.length) * 100;
}

type Affected = "none" | "drop" | "add" | "alter" | "row" | "table";
type Sev = "green" | "amber" | "red";
interface SceneCol {
  name: string;
  type: string;
  pk?: boolean;
  affected: Affected;
  severity?: Sev;
  opLabel?: string;
}

// Real demo-target schema (fixtures/target_schema.sql). The 3D reflects the
// actual table the migration touches, so decided (applied/rejected/blocked)
// requests still render their table instead of an empty stack.
const DEMO_TABLES: Record<string, { name: string; type: string; pk?: boolean }[]> = {
  users: [
    { name: "id", type: "bigserial", pk: true },
    { name: "email", type: "text" },
    { name: "full_name", type: "text" },
    { name: "is_active", type: "boolean" },
    { name: "legacy_notes", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ],
  orders: [
    { name: "id", type: "bigserial", pk: true },
    { name: "user_id", type: "bigint" },
    { name: "amount_cents", type: "integer" },
    { name: "status", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ],
};

/** Derive the table + columns + operation highlight the 3D should show from the
 *  migration SQL. Uses the REAL parsed table name; borrows fixture columns only
 *  for tables we have a fixture for, otherwise shows only the columns the
 *  migration touches (rather than fabricating an unrelated schema). */
// Sentinel for "the migration's table could not be identified". It must NOT be a
// real fixture table, so it never matches SCHEMA_FKS and never fabricates a FK.
const UNPARSED_TABLE = "public.?";

// Own-property lookup: the SQL is user text, so identifiers like "constructor"
// or "toString" must not resolve to Object.prototype members and crash the
// scene build when we try to .map() them.
function fixtureColumns(table: string): { name: string; type: string; pk?: boolean }[] | undefined {
  return Object.prototype.hasOwnProperty.call(DEMO_TABLES, table) ? DEMO_TABLES[table] : undefined;
}

/** Split CREATE TABLE column definitions on commas, but respect parenthesized
 *  sub-expressions like numeric(10,2) so they don't become two fragments. */
function splitDefs(block: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of block) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Extract a column type from the remaining definition text, handling multi-word
 *  types (double precision, character varying) and parenthesized params (numeric(10,2)). */
function parseColumnType(rest: string): string {
  const r = rest.trim();
  const m = r.match(/^(\w+(?:\s*\([^)]*\))?(?:\s+(?:precision|varying|without|with|time|zone)\w*)*)/i);
  return m ? m[1].trim() : r.split(/\s/)[0] || "—";
}

function db3dModel(upSql: string): { table: string; columns: SceneCol[] } {
  const sql = upSql.toLowerCase();

  // Table identifier: optional "schema"."table" with double-quote + any schema support
  const T = String.raw`(?:"?(\w+)"?\.)?"?(\w+)"?`;
  const tableMatch =
    sql.match(new RegExp(String.raw`(?:drop|alter)\s+table\s+(?:only\s+)?${T}`)) ||
    sql.match(new RegExp(String.raw`\btruncate\s+(?:table\s+)?${T}`)) ||
    sql.match(new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${T}`)) ||
    sql.match(new RegExp(String.raw`(?:update|delete\s+from|insert\s+into)\s+${T}`)) ||
    sql.match(new RegExp(String.raw`create\s+index[^;]*\bon\s+${T}`));
  const schema = tableMatch?.[1] ?? "public";
  const parsed = tableMatch?.[2];
  // Only use fixture columns when the schema is "public" — an identically named
  // table in another schema (e.g. audit.users) must not inherit public.users cols.
  const fixture = parsed && schema === "public" ? fixtureColumns(parsed) : undefined;

  const table = parsed ? `${schema}.${parsed}` : UNPARSED_TABLE;
  const isCreate = /\bcreate\s+table\b/.test(sql);
  // For CREATE TABLE, parse the column definitions from the SQL body rather than
  // preloading fixtures (which would duplicate cols for known tables like users).
  let columns: SceneCol[] = !isCreate && fixture ? fixture.map((c) => ({ ...c, affected: "none" })) : [];
  const tint = (affected: Affected, severity: Sev, opLabel: string): SceneCol[] =>
    columns.map((c) => ({ ...c, affected, severity, opLabel }));

  if (isCreate) {
    const colBlock = sql.match(/\(([\s\S]+)\)/)?.[1] ?? "";
    const defs = splitDefs(colBlock);
    const skip = new Set(["constraint", "primary", "unique", "foreign", "check", "exclude"]);
    const pkCols = new Set<string>();
    for (const def of defs) {
      // Table-level PRIMARY KEY (col1, col2) → mark those cols as PK after parsing all defs.
      const pkm = def.match(/^\s*primary\s+key\s*\(([^)]+)\)/);
      if (pkm) { pkm[1].split(",").forEach((c) => pkCols.add(c.trim().replace(/^"|"$/g, ""))); continue; }

      const cm = def.match(/^"?(\w+)"?\s+(.+)/);
      if (cm && !skip.has(cm[1])) {
        columns.push({
          name: cm[1], type: parseColumnType(cm[2]),
          pk: /\bprimary\s+key\b/.test(def) || undefined,
          affected: "add", severity: "green", opLabel: "CREATE TABLE",
        });
      }
    }
    for (const c of columns) { if (pkCols.has(c.name)) c.pk = true; }
    return { table, columns };
  }

  // Whole-table destruction → the entire stack is affected.
  if (/\bdrop\s+table\b/.test(sql)) return { table, columns: tint("table", "red", "DROP TABLE") };
  if (/\btruncate\b/.test(sql)) return { table, columns: tint("table", "red", "TRUNCATE") };
  if (/^\s*delete\s+from\b/.test(sql)) {
    return /\bwhere\b/.test(sql)
      ? { table, columns: tint("row", "amber", "DELETE ROWS") }
      : { table, columns: tint("table", "red", "DELETE ALL ROWS") };
  }

  // UPDATE → highlight the SET columns (or the whole table if unbounded/unparsed).
  if (/^\s*update\b/.test(sql)) {
    const unbounded = !/\bwhere\b/.test(sql);
    const sev: Sev = unbounded ? "red" : "amber";
    const opLabel = unbounded ? "UPDATE · all rows" : "UPDATE";
    const setPart = sql.match(/\bset\b([\s\S]+?)(?:\bwhere\b|;|$)/)?.[1] ?? "";
    const setCols = new Set([...setPart.matchAll(/(\w+)\s*=/g)].map((m) => m[1]));
    const marked = columns.map((c) =>
      setCols.has(c.name) ? { ...c, affected: "alter" as Affected, severity: sev, opLabel } : c,
    );
    return {
      table,
      columns: marked.some((c) => c.affected !== "none") ? marked : tint("row", sev, opLabel),
    };
  }

  // DROP COLUMN
  let m = sql.match(/drop\s+column\s+(?:if\s+exists\s+)?(\w+)/);
  if (m) {
    const name = m[1];
    if (columns.some((c) => c.name === name)) {
      columns = columns.map((c) =>
        c.name === name ? { ...c, affected: "drop", severity: "red", opLabel: "DROP COLUMN" } : c,
      );
    } else {
      columns.push({ name, type: "—", affected: "drop", severity: "red", opLabel: "DROP COLUMN" });
    }
    return { table, columns };
  }

  // ADD COLUMN
  m = sql.match(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+([a-z0-9_(), ]+?)(?:\s+not\s+null|\s+default|,|;|$)/);
  if (m) {
    const notNull = /\bnot\s+null\b/.test(sql);
    columns.push({
      name: m[1],
      type: (m[2] || "").trim() || "—",
      affected: "add",
      severity: notNull ? "amber" : "green",
      opLabel: "ADD COLUMN",
    });
    return { table, columns };
  }

  // ALTER COLUMN (type change / SET NOT NULL / DROP NOT NULL)
  m = sql.match(/alter\s+column\s+(\w+)/);
  if (m) {
    const name = m[1];
    const sev: Sev = /\bdrop\s+not\s+null\b/.test(sql) ? "green" : "amber";
    if (columns.some((c) => c.name === name)) {
      columns = columns.map((c) =>
        c.name === name ? { ...c, affected: "alter", severity: sev, opLabel: "ALTER COLUMN" } : c,
      );
    } else {
      columns.push({ name, type: "—", affected: "alter", severity: sev, opLabel: "ALTER COLUMN" });
    }
    return { table, columns };
  }

  // CREATE INDEX → highlight the indexed column.
  if (/\bcreate\s+index\b/.test(sql)) {
    const name = sql.match(/create\s+index[^;]*\(\s*(\w+)/)?.[1];
    const online = /\bconcurrently\b/.test(sql);
    if (name && columns.some((c) => c.name === name)) {
      columns = columns.map((c) =>
        c.name === name
          ? { ...c, affected: "alter", severity: online ? "green" : "amber", opLabel: online ? "INDEX · online" : "CREATE INDEX" }
          : c,
      );
    }
    return { table, columns };
  }

  return { table, columns };
}

// Foreign-key edges of the demo schema (fixtures/target_schema.sql). Drives the
// "affected table + FK neighbours" view.
const SCHEMA_FKS: FkEdge[] = [
  { fromTable: "public.orders", fromCol: "user_id", toTable: "public.users", toCol: "id" },
];

/** Expand the single-table model into the affected table PLUS its FK-neighbour
 *  tables + the edges between them, so the 3D shows how the change is linked. */
function db3dScene(upSql: string): { tables: SceneTable[]; edges: FkEdge[] } {
  const primary = db3dModel(upSql);
  const primaryName = primary.table; // a real "public.<table>", or UNPARSED_TABLE
  // Only a confidently identified table drives FK-neighbour expansion — an
  // unparsed statement must not inherit a fixture's relationships.
  const parsedTarget = primaryName !== UNPARSED_TABLE;
  // If the parse couldn't attribute columns but the table IS a known fixture,
  // still show its columns (so the card isn't empty and FK links can anchor).
  let primaryCols = primary.columns;
  if (primaryCols.length === 0) {
    const fix = fixtureColumns(primaryName.replace(/^public\./, ""));
    if (fix) primaryCols = fix.map((c) => ({ ...c, affected: "none" as Affected }));
  }
  const tables: SceneTable[] = [{ name: primaryName, columns: primaryCols, role: "primary" }];

  const edges = parsedTarget
    ? SCHEMA_FKS.filter((e) => e.fromTable === primaryName || e.toTable === primaryName)
    : [];
  const neighbours = new Set<string>();
  for (const e of edges) neighbours.add(e.fromTable === primaryName ? e.toTable : e.fromTable);

  for (const name of neighbours) {
    const cols = fixtureColumns(name.replace(/^public\./, ""));
    if (cols) tables.push({ name, columns: cols.map((c) => ({ ...c, affected: "none" as Affected })), role: "related" });
  }
  return { tables, edges };
}

export default async function ApprovalConsole({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getRequest(id);
  if (!r) notFound();

  // Deterministic gate policy (ADR-004) — derived from the SQL of record, not
  // from a stored flag, so the UI and the enforced gate always agree. Scaled to
  // the target's environment exactly like the server arms it (doc 11 §4).
  const cls = classifyMigration(r.upSql);
  const dataWillFail = r.preflight.some((p) => p.willFail === true);
  const dataUnknown = r.preflight.some((p) => p.willFail === null);
  const disposition = escalateForEnvironment(
    gateDisposition({
      severity: r.overallSeverity,
      hasBlockingStatement: cls.hasBlockingStatement,
      dataWillFail,
      dataUnknown,
      rollbackVerified: r.rollbackVerified,
    }),
    r.overallSeverity,
    r.environment,
  );

  // Promotion rail state: the group's per-env runs + the prod lock verdict,
  // computed with the SAME promotionEligible the server enforces.
  const [promotionGroup, guardCtx] = await Promise.all([
    getPromotionGroup(r.promotionGroupId),
    getApplyGuardContext(r.id),
  ]);
  const prodLocked =
    r.environment === "prod" &&
    (r.status === "awaiting_approval" || r.status === "blocked") &&
    (!guardCtx || !promotionEligible(guardCtx));
  const blocked = disposition === "blocked";
  const decidable = r.status === "awaiting_approval" || r.status === "blocked";
  const paused = decidable;
  const scene = db3dScene(r.upSql);

  // Whether the safety pipeline has actually produced a verdict yet. getRequest()
  // substitutes overallSeverity='green' when no blast report exists, so a freshly
  // submitted / generating / dry-running / early-failed request would otherwise
  // render as SAFE before any analysis ran. Analysis populates one finding per
  // classified statement, so a non-empty findings list is the reliable signal.
  const preAnalysis = ["received", "generating", "reviewing", "dry_running"].includes(r.status);
  const analyzed = !preAnalysis && r.findings.length > 0;

  return (
    <>
      <AutoRefresh status={r.status} />
      <Link href="/requests" style={{ fontSize: 12, color: "var(--muted)" }}>← All migrations</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 10px" }}>
        <h1 style={{ margin: 0 }}>{r.title}</h1>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 7 }}>
            {r.targetDb}
            <EnvBadge env={r.environment} />
          </span>
          <StatusChip status={r.status} />
        </span>
      </div>

      {/* Engine attribution — TrueForge runs the agent; this console is the cockpit. */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 9, margin: "0 0 14px",
          fontSize: 11.5, color: "var(--muted)", fontFamily: "var(--font-mono)",
          border: "1px solid var(--line)", borderRadius: 10, padding: "8px 12px",
          background: "var(--panel)",
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cyan)", boxShadow: "var(--glow-cyan)", flexShrink: 0 }} />
        <span>
          Runs on <b style={{ color: "var(--cyan)" }}>TrueForge</b> — the agent turn generates the migration, then{" "}
          <b style={{ color: "var(--text-dim)" }}>blast · rollback · qodo · pre-flight</b> run as parallel sub-agents. This console is the approval cockpit built on its SDK.
        </span>
      </div>

      {paused && (
        <div className="paused-banner" style={{ marginBottom: 14, ...(blocked ? { borderColor: "var(--danger)" } : {}) }}>
          <span className="pulse-dot" />
          {blocked
            ? "TrueForge halted the agent — migration BLOCKED at the apply_migration approval gate. No production changes have been made."
            : "TrueForge paused the agent at the apply_migration approval gate — awaiting your decision. No production changes have been made."}
        </div>
      )}

      {/* Gate disposition — the deterministic policy verdict (ADR-004) */}
      {paused && (
        <div
          className={`sev-tag ${blocked ? "" : ""}`}
          style={{
            marginBottom: 14,
            display: "inline-block",
            background: blocked ? "var(--danger)" : disposition === "typed_confirm" ? "var(--warn)" : disposition === "approval" ? "var(--warn)" : "var(--safe)",
            color: blocked ? "#fff" : "#0b0e13",
          }}
        >
          {blocked ? "⛔ " : disposition === "typed_confirm" ? "▲ " : "✓ "}
          GATE POLICY · {dispositionLabel(disposition)}
        </div>
      )}

      {/* Promotion rail — where this migration sits on the env ladder */}
      <PromotionRail
        requestId={r.id}
        environment={r.environment}
        status={r.status}
        prodLocked={prodLocked}
        runs={promotionGroup.map((g) => ({
          requestId: g.requestId,
          environment: g.environment,
          status: g.status,
          targetAlias: g.targetAlias,
        }))}
      />

      {/* Main grid: 3D + readouts */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 22 }}>

        {/* Left column: 3D viz + SQL + commit */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 3D Database */}
          <div className="glass glass-energized" style={{ padding: 0 }}>
            <SchemaErd tables={scene.tables} edges={scene.edges} />
          </div>

          {/* SQL wells */}
          <div className="glass">
            <SqlWell sql={r.upSql} label="UP.SQL" />
            <div style={{ height: 10 }} />
            <SqlWell
              sql={r.downSql}
              label="DOWN.SQL"
              danger={r.reversibility !== "reversible"}
              banner={r.reversibility === "irreversible" ? "NO CLEAN ROLLBACK" : undefined}
            />
          </div>

          {/* Energy progress bar */}
          <div className="glass" style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="hud-label" style={{ margin: 0 }}>Agent run</span>
              <span className="mono" style={{ fontSize: 10, color: "var(--faint)", letterSpacing: ".06em" }}>⚡ TrueForge session</span>
            </div>
            <EnergyProgressBar phases={PHASES} currentIndex={phaseIndex(r)} percent={phasePercent(r)} />
          </div>

          {/* Commit console */}
          {paused ? (
            <CommitConsole requestId={r.id} requiresTypedConfirm={r.approval.requiresTypedConfirm} expectedConfirm={r.approval.expectedConfirm ?? undefined} blocked={blocked} />
          ) : (
            <div className="glass" style={{ textAlign: "center" }}>
              <span className="hud-label">Decision</span>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4, color: r.approval.decision === "approved" ? "var(--safe)" : r.approval.decision === "rejected" ? "var(--danger)" : "var(--muted)" }}>
                {r.approval.decision.toUpperCase()}
              </div>
              {r.decidedBy && <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>by {r.decidedBy}</div>}
            </div>
          )}
        </div>

        {/* Right column: readouts + findings */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Hero readout — rows affected */}
          <div className={`glass ${analyzed && r.overallSeverity === "red" ? "glass-danger" : ""}`} style={{ padding: "16px 18px" }}>
            <StatReadout label="Rows affected · est" value={r.rowsAffected?.toLocaleString() ?? "—"} tone={!analyzed ? undefined : r.overallSeverity === "red" ? "danger" : r.overallSeverity === "amber" ? "warn" : "safe"} hero />
          </div>

          {/* Lock + Rollback side by side */}
          <div style={{ display: "flex", gap: 12 }}>
            <div className="glass" style={{ flex: 1, padding: 14 }}>
              <StatReadout label="Est. lock" value={r.estLockMs ? `${r.estLockMs.toLocaleString()}` : "—"} tone={r.estLockMs && r.estLockMs > 5000 ? "warn" : "cyan"} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--faint)", textAlign: "center", marginTop: 2 }}>
                {r.estLockMs ? "ms · AccessExclusive" : ""}
              </div>
            </div>
            <div className="glass" style={{ flex: 1, padding: 14 }}>
              <div className="hud-label">Rollback</div>
              <div style={{ textAlign: "center", marginTop: 8, fontSize: 16, fontWeight: 600 }}>
                {!analyzed ? (
                  // No shadow rollback test has run yet — don't assert a definitive
                  // data-loss verdict for a pending/early-failed request.
                  <span style={{ color: "var(--text-dim)" }}>PENDING</span>
                ) : r.rollbackVerified ? (
                  <span style={{ color: "var(--safe)" }}>VERIFIED</span>
                ) : (
                  <span style={{ color: "var(--danger)" }}>UNRECOVERABLE</span>
                )}
              </div>
            </div>
          </div>

          {/* Checks */}
          <div className="glass" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
            {(() => {
              const failing = r.preflight.filter((p) => p.willFail === true).length;
              const review = r.preflight.filter((p) => p.willFail === null).length;
              const tone = failing > 0 ? "danger" : review > 0 ? "warn" : "safe";
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span className="glow-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: `var(--${tone})`, color: `var(--${tone})`, flexShrink: 0 }} />
                  <span style={{ fontSize: 13 }}>
                    Data pre-flight — <b>{failing}</b> {failing === 1 ? "violation" : "violations"}
                    {review > 0 && (
                      <>
                        {" · "}
                        <b style={{ color: "var(--warn)" }}>{review}</b> could not be proven (review required)
                      </>
                    )}
                  </span>
                </div>
              );
            })()}
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span className="glow-dot" style={{
                width: 8, height: 8, borderRadius: "50%",
                background: r.qodoVerdict === "passed" ? "var(--safe)" : "var(--warn)",
                color: r.qodoVerdict === "passed" ? "var(--safe)" : "var(--warn)",
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
                Qodo — {r.qodoVerdict} · {r.qodoFindings.length} {r.qodoFindings.length === 1 ? "warning" : "warnings"}
              </span>
            </div>
          </div>

          {/* Blast findings */}
          <div className={`glass ${analyzed && r.overallSeverity === "red" ? "glass-danger" : ""}`}>
            <h3 className="section-title">
              Blast report{" "}
              {analyzed ? (
                <SeverityChip severity={r.overallSeverity} />
              ) : (
                <span className="sev-chip sev-amber">
                  {preAnalysis ? "Analysis pending" : "No verdict"}
                </span>
              )}
            </h3>
            {analyzed ? (
              r.findings.map((f, i) => (
                <div key={i} className="finding-row">
                  <span className="f-icon" style={{ color: `var(--${f.severity === "green" ? "safe" : f.severity === "amber" ? "warn" : "danger"})` }}>
                    {f.severity === "green" ? "✓" : f.severity === "amber" ? "▲" : "⛔"}
                  </span>
                  <div>
                    <div style={{ color: "var(--text-dim)" }}>{f.note}</div>
                    {f.lockType && <div className="f-lock">{f.lockType}</div>}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
                {preAnalysis
                  ? "The safety pipeline is still running — no severity verdict yet."
                  : "No safety analysis was produced for this request."}
              </div>
            )}
          </div>

          {/* Qodo review */}
          <div className="glass">
            <h3 className="section-title">Qodo review</h3>
            <div style={{ marginBottom: 6 }}>
              <span className={`sev-chip ${r.qodoVerdict === "passed" ? "sev-green" : r.qodoVerdict === "failed" ? "sev-red" : "sev-amber"}`}>
                {r.qodoVerdict === "passed" ? "✓" : r.qodoVerdict === "failed" ? "⛔" : "▲"} {r.qodoVerdict.replace(/_/g, " ")}
              </span>
            </div>
            {r.qodoFindings.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-dim)" }}>
                {r.qodoFindings.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Read-only copilot — ask questions about THIS migration. Powered by the
          operator's Euron key (BYOK, OpenAI-compatible); wholly separate from
          the approval gate. */}
      <MigrationChat requestId={r.id} />
    </>
  );
}
