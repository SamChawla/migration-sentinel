import Link from "next/link";
import { listAuditEvents } from "@sentinel/db/queries";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AuditLog() {
  const events = await listAuditEvents();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            Append-only. Every state change, decision, and apply — actor, action, timestamp.
          </p>
        </div>
        <span className="sev-chip sev-green" style={{ fontSize: 12 }}>✓ append-only</span>
      </div>

      <div className="glass">
        <div className="timeline" style={{ marginTop: 4 }}>
          {events.map((e) => (
            <div key={e.id} className={`tl-item tl-${e.tone}`}>
              <span className="tl-dot" />
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 12 }}>{e.action}</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>by <b>{e.actor}</b></span>
                {e.requestId && <Link href={`/requests/${e.requestId}`} className="mono" style={{ fontSize: 11 }}>{e.requestId}</Link>}
                <span style={{ fontSize: 11, marginLeft: "auto", color: "var(--faint)" }} title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{e.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
