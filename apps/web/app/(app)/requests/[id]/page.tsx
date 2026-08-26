import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequest } from "@sentinel/db/queries";
import { classifyMigration } from "@sentinel/shadow";
import { gateDisposition, dispositionLabel } from "@sentinel/core";
import { SeverityChip, StatusChip } from "@/components/chips";
import { StatReadout, EnergyProgressBar } from "@/components/instruments/Readouts";
import { SqlWell } from "@/components/console/SqlWell";
import { CommitConsole } from "@/components/console/CommitConsole";
import { Db3D } from "@/components/scene/Db3D";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

const PHASES = ["Generate", "Review", "Dry-run", "Gate", "Apply"];

function phaseIndex(status: string): number {
  switch (status) {
    case "received": case "generating": return 0;
    case "reviewing": return 1;
    case "dry_running": return 2;
    case "awaiting_approval": case "approved": case "rejected": return 3;
    case "applying": return 4;
    case "applied": case "failed": case "rolled_back": return 4;
    default: return 0;
  }
}

function phasePercent(status: string): number {
  const i = phaseIndex(status);
  const terminal = ["applied", "failed", "rolled_back"].includes(status);
  if (terminal) return 100;
  return ((i + 0.5) / PHASES.length) * 100;
}

type Affected = "none" | "drop" | "add" | "alter" | "row" | "table";
type Sev = "green" | "amber" | "red";
interface SceneCol {
  name: string;
  type: string;
  affected: Affected;
  severity?: Sev;
  opLabel?: string;
}

// Real demo-target schema (fixtures/target_schema.sql). The 3D reflects the
// actual table the migration touches, so decided (applied/rejected/blocked)
// requests still render their table instead of an empty stack.
const DEMO_TABLES: Record<string, { name: string; type: string }[]> = {
  users: [
    { name: "id", type: "bigserial" },
    { name: "email", type: "text" },
    { name: "full_name", type: "text" },
    { name: "is_active", type: "boolean" },
    { name: "legacy_notes", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ],
  orders: [
    { name: "id", type: "bigserial" },
    { name: "user_id", type: "bigint" },
    { name: "amount_cents", type: "integer" },
    { name: "status", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ],
};

/** Derive the table + columns + operation highlight the 3D should show from
 *  the migration SQL. Always returns a labeled table (never an empty stack). */
function db3dModel(upSql: string): { table: string; columns: SceneCol[] } {
  const sql = upSql.toLowerCase();

  let key: keyof typeof DEMO_TABLES = "users";
  const tableMatch =
    sql.match(/(?:drop|alter|truncate)\s+table\s+(?:only\s+)?(?:public\.)?(\w+)/) ||
    sql.match(/(?:update|delete\s+from|insert\s+into)\s+(?:public\.)?(\w+)/) ||
    sql.match(/create\s+index[^;]*\bon\s+(?:public\.)?(\w+)/);
  if (tableMatch && tableMatch[1] in DEMO_TABLES) key = tableMatch[1] as keyof typeof DEMO_TABLES;

  const table = `public.${key}`;
  let columns: SceneCol[] = DEMO_TABLES[key].map((c) => ({ ...c, affected: "none" }));
  const tint = (affected: Affected, severity: Sev, opLabel: string): SceneCol[] =>
    columns.map((c) => ({ ...c, affected, severity, opLabel }));

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

export default async function ApprovalConsole({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getRequest(id);
  if (!r) notFound();

  // Deterministic gate policy (ADR-004) — derived from the SQL of record, not
  // from a stored flag, so the UI and the enforced gate always agree.
  const cls = classifyMigration(r.upSql);
  const dataWillFail = r.preflight.some((p) => p.willFail === true);
  const dataUnknown = r.preflight.some((p) => p.willFail === null);
  const disposition = gateDisposition({
    severity: r.overallSeverity,
    hasBlockingStatement: cls.hasBlockingStatement,
    dataWillFail,
    dataUnknown,
    rollbackVerified: r.rollbackVerified,
  });
  const blocked = disposition === "blocked";
  const decidable = r.status === "awaiting_approval" || r.status === "blocked";
  const paused = decidable;
  const scene = db3dModel(r.upSql);

  return (
    <>
      <AutoRefresh status={r.status} />
      <Link href="/requests" style={{ fontSize: 12, color: "var(--muted)" }}>← All migrations</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 14px" }}>
        <h1 style={{ margin: 0 }}>{r.title}</h1>
        <StatusChip status={r.status} />
      </div>

      {paused && (
        <div className="paused-banner" style={{ marginBottom: 14, ...(blocked ? { borderColor: "var(--danger)" } : {}) }}>
          <span className="pulse-dot" />
          {blocked
            ? "Agent halted — migration BLOCKED. No production changes have been made."
            : "Agent paused — awaiting operator decision. No production changes have been made."}
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

      {/* Main grid: 3D + readouts */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 22 }}>

        {/* Left column: 3D viz + SQL + commit */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 3D Database */}
          <div className="glass glass-energized" style={{ padding: 0 }}>
            <Db3D table={scene.table} columns={scene.columns} />
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
            <EnergyProgressBar phases={PHASES} currentIndex={phaseIndex(r.status)} percent={phasePercent(r.status)} />
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
          <div className={`glass ${r.overallSeverity === "red" ? "glass-danger" : ""}`} style={{ padding: "16px 18px" }}>
            <StatReadout label="Rows affected · est" value={r.rowsAffected?.toLocaleString() ?? "—"} tone={r.overallSeverity === "red" ? "danger" : r.overallSeverity === "amber" ? "warn" : "safe"} hero />
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
                {r.rollbackVerified ? (
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
          <div className={`glass ${r.overallSeverity === "red" ? "glass-danger" : ""}`}>
            <h3 className="section-title">Blast report <SeverityChip severity={r.overallSeverity} /></h3>
            {r.findings.map((f, i) => (
              <div key={i} className="finding-row">
                <span className="f-icon" style={{ color: `var(--${f.severity === "green" ? "safe" : f.severity === "amber" ? "warn" : "danger"})` }}>
                  {f.severity === "green" ? "✓" : f.severity === "amber" ? "▲" : "⛔"}
                </span>
                <div>
                  <div style={{ color: "var(--text-dim)" }}>{f.note}</div>
                  {f.lockType && <div className="f-lock">{f.lockType}</div>}
                </div>
              </div>
            ))}
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
    </>
  );
}
