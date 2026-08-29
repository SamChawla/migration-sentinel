import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequest, getRequestTargetUrl, getPromotionGroup, getApplyGuardContext } from "@sentinel/db/queries";
import { classifyMigration, introspectConnection, type SchemaIntrospection } from "@sentinel/shadow";
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

// Sentinel for "the migration's table could not be identified". Never a real
// table name, so it can't match a live table and inherit its FKs.
const UNPARSED_TABLE = "public.?";

interface SqlModel {
  table: string;
  /** Columns the SQL provably touches (with their op metadata). */
  columns: SceneCol[];
  /** Set for whole-table / whole-rows operations — tints EVERY live column. */
  tableOp?: { affected: Affected; severity: Sev; opLabel: string };
}

/** Derive the table + touched columns + operation highlight from the migration
 *  SQL alone. No fixtures: the live schema (introspection) supplies the real
 *  columns; this model is the OVERLAY saying what the SQL does to them. */
function db3dModel(upSql: string): SqlModel {
  const sql = upSql.toLowerCase();

  const tableMatch =
    sql.match(/(?:drop|alter|truncate)\s+table\s+(?:only\s+)?(?:public\.)?(\w+)/) ||
    sql.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/) ||
    sql.match(/(?:update|delete\s+from|insert\s+into)\s+(?:public\.)?(\w+)/) ||
    sql.match(/create\s+index[^;]*\bon\s+(?:public\.)?(\w+)/);
  const parsed = tableMatch?.[1];
  const table = parsed ? `public.${parsed}` : UNPARSED_TABLE;

  // Whole-table destruction → the entire stack is affected.
  if (/\bdrop\s+table\b/.test(sql))
    return { table, columns: [], tableOp: { affected: "table", severity: "red", opLabel: "DROP TABLE" } };
  if (/\btruncate\b/.test(sql))
    return { table, columns: [], tableOp: { affected: "table", severity: "red", opLabel: "TRUNCATE" } };
  if (/^\s*delete\s+from\b/.test(sql)) {
    return /\bwhere\b/.test(sql)
      ? { table, columns: [], tableOp: { affected: "row", severity: "amber", opLabel: "DELETE ROWS" } }
      : { table, columns: [], tableOp: { affected: "table", severity: "red", opLabel: "DELETE ALL ROWS" } };
  }

  // UPDATE → highlight the SET columns (or all rows if none parsed).
  if (/^\s*update\b/.test(sql)) {
    const unbounded = !/\bwhere\b/.test(sql);
    const sev: Sev = unbounded ? "red" : "amber";
    const opLabel = unbounded ? "UPDATE · all rows" : "UPDATE";
    const setPart = sql.match(/\bset\b([\s\S]+?)(?:\bwhere\b|;|$)/)?.[1] ?? "";
    const setCols = [...setPart.matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
    if (setCols.length > 0) {
      return {
        table,
        columns: setCols.map((name) => ({ name, type: "—", affected: "alter" as Affected, severity: sev, opLabel })),
      };
    }
    return { table, columns: [], tableOp: { affected: "row", severity: sev, opLabel } };
  }

  // DROP COLUMN
  let m = sql.match(/drop\s+column\s+(?:if\s+exists\s+)?(\w+)/);
  if (m) {
    return { table, columns: [{ name: m[1], type: "—", affected: "drop", severity: "red", opLabel: "DROP COLUMN" }] };
  }

  // ADD COLUMN
  m = sql.match(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+([a-z0-9_(), ]+?)(?:\s+not\s+null|\s+default|,|;|$)/);
  if (m) {
    const notNull = /\bnot\s+null\b/.test(sql);
    return {
      table,
      columns: [{
        name: m[1],
        type: (m[2] || "").trim() || "—",
        affected: "add",
        severity: notNull ? "amber" : "green",
        opLabel: "ADD COLUMN",
      }],
    };
  }

  // ALTER COLUMN (type change / SET NOT NULL / DROP NOT NULL)
  m = sql.match(/alter\s+column\s+(\w+)/);
  if (m) {
    const sev: Sev = /\bdrop\s+not\s+null\b/.test(sql) ? "green" : "amber";
    return { table, columns: [{ name: m[1], type: "—", affected: "alter", severity: sev, opLabel: "ALTER COLUMN" }] };
  }

  // CREATE INDEX → highlight the indexed column.
  if (/\bcreate\s+index\b/.test(sql)) {
    const name = sql.match(/create\s+index[^;]*\(\s*(\w+)/)?.[1];
    const online = /\bconcurrently\b/.test(sql);
    if (name) {
      return {
        table,
        columns: [{
          name, type: "—", affected: "alter",
          severity: online ? "green" : "amber",
          opLabel: online ? "INDEX · online" : "CREATE INDEX",
        }],
      };
    }
    return { table, columns: [] };
  }

  return { table, columns: [] };
}

/** How many FK-neighbour tables the ERD shows next to the affected one. */
const MAX_NEIGHBOURS = 3;

/** Build the ERD scene from the LIVE introspected schema with the SQL model
 *  overlaid by column name: real tables/columns/FKs, with the touched columns
 *  tinted by the operation. Returns null when the primary table can't be
 *  anchored in the live schema (caller falls back to the SQL-only card). */
function liveScene(
  model: SqlModel,
  live: SchemaIntrospection,
): { tables: SceneTable[]; edges: FkEdge[] } | null {
  if (model.table === UNPARSED_TABLE) return null;
  const bare = model.table.replace(/^public\./, "");
  const primary = live.tables.find((t) => t.name === model.table || t.name.endsWith(`.${bare}`));
  if (!primary) return null;

  const overlay = new Map(model.columns.map((c) => [c.name, c]));
  let primaryCols: SceneCol[] = primary.columns.map((c) => {
    const touched = overlay.get(c.name);
    return {
      name: c.name,
      type: c.type,
      pk: c.pk,
      affected: touched?.affected ?? model.tableOp?.affected ?? "none",
      severity: touched?.severity ?? model.tableOp?.severity,
      opLabel: touched?.opLabel ?? model.tableOp?.opLabel,
    };
  });
  // Columns the SQL touches that don't exist live yet (ADD COLUMN) — append.
  for (const c of model.columns) {
    if (!primaryCols.some((p) => p.name === c.name)) primaryCols = [...primaryCols, c];
  }

  const edges = live.fks.filter((e) => e.fromTable === primary.name || e.toTable === primary.name);
  const neighbourNames: string[] = [];
  for (const e of edges) {
    const other = e.fromTable === primary.name ? e.toTable : e.fromTable;
    if (other !== primary.name && !neighbourNames.includes(other)) neighbourNames.push(other);
  }
  const keptNeighbours = neighbourNames.slice(0, MAX_NEIGHBOURS);
  const kept = new Set([primary.name, ...keptNeighbours]);

  const tables: SceneTable[] = [
    { name: primary.name, columns: primaryCols, role: "primary" },
    ...keptNeighbours.map((name) => {
      const t = live.tables.find((lt) => lt.name === name)!;
      return {
        name,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk, affected: "none" as Affected })),
        role: "related" as const,
      };
    }),
  ];
  return { tables, edges: edges.filter((e) => kept.has(e.fromTable) && kept.has(e.toTable)) };
}

/** SQL-only fallback card — shown with an honest caption when the live schema
 *  is unavailable. Shows ONLY what the SQL touches; nothing is fabricated. */
function fallbackScene(model: SqlModel): { tables: SceneTable[]; edges: FkEdge[] } {
  return { tables: [{ name: model.table, columns: model.columns, role: "primary" }], edges: [] };
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

  // Real ERD: introspect the request's target live and overlay what the SQL
  // touches. Any failure (no URL, unreachable, timeout, table not found) falls
  // back to the SQL-only card with an honest caption — nothing is fabricated.
  const model = db3dModel(r.upSql);
  let live: SchemaIntrospection | null = null;
  try {
    const targetUrl = await getRequestTargetUrl(r.id);
    if (targetUrl) live = await introspectConnection(targetUrl, { deadlineMs: 8000 });
  } catch {
    live = null;
  }
  const sceneFromLive = live ? liveScene(model, live) : null;
  const scene = sceneFromLive ?? fallbackScene(model);
  const erdCaption = sceneFromLive
    ? undefined
    : "Live schema unavailable — showing only what the SQL touches";

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
            <SchemaErd tables={scene.tables} edges={scene.edges} caption={erdCaption} />
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
