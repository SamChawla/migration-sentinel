import Link from "next/link";
import { Client } from "pg";
import { listRequests, listAuditEvents, getDashboardStats, getSeverityDistribution } from "@sentinel/db/queries";
import { SeverityChip, StatusChip } from "@/components/chips";
import { StatReadout } from "@/components/instruments/Readouts";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Real availability probe — a quick connect + SELECT 1 with a short timeout. */
async function probeDb(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Liveness probe for an HTTP service (the TrueForge harness). ANY response —
 *  even a 404 — means the harness is reachable; only a network error/timeout is
 *  "down". Replaces the old hardcoded "configure key" placeholder. */
async function probeHttp(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export default async function Dashboard() {
  const [requests, audit, stats, sevDist, targetUp, shadowUp, sentinelUp, trueforgeUp] = await Promise.all([
    // Only the 5 most recent are rendered below — ask for 5, not the default 50.
    // Each record is hydrated with several sequential queries, so fetching 50 to
    // show 5 was ~10x the database work per dashboard load.
    listRequests({ limit: 5 }),
    listAuditEvents(),
    getDashboardStats(),
    getSeverityDistribution(),
    probeDb(process.env.TARGET_DB_URL),
    probeDb(process.env.SHADOW_ADMIN_URL),
    probeDb(process.env.DATABASE_URL),
    probeHttp(process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790"),
  ]);
  const copilotUp = Boolean(process.env.EURON_API_KEY?.trim());
  const dot = (up: boolean) => (up ? "ok" : "off");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Migrations</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            Every schema change: analyzed, dry-run on a shadow, and gated on you.
          </p>
        </div>
        <Link href="/requests/new" className="btn btn-cyan" data-tour="new">+ New migration</Link>
      </div>

      {/* Stat readouts */}
      <div data-tour="stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <div className="glass" style={{ padding: 16, textAlign: "center" }}>
          <StatReadout label="Awaiting approval" value={String(stats.awaiting)} tone={stats.awaiting > 0 ? "warn" : undefined} />
        </div>
        <div className="glass" style={{ padding: 16, textAlign: "center" }}>
          <StatReadout label="Applied with guards" value={String(stats.applied)} tone="safe" />
        </div>
        <div className="glass" style={{ padding: 16, textAlign: "center" }}>
          <StatReadout label="Blocked at gate" value={String(stats.blocked)} tone={stats.blocked > 0 ? "danger" : undefined} />
        </div>
        <div className="glass" style={{ padding: 16, textAlign: "center" }}>
          <StatReadout label="Rollbacks proven" value={String(stats.proven)} tone="cyan" />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        {/* Recent migrations list */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 className="section-title" style={{ margin: 0 }}>Recent migrations</h3>
            <Link href="/requests" className="btn btn-sm">View all</Link>
          </div>
          <div className="glass" style={{ padding: 0 }} data-tour="recent">
            {requests.slice(0, 5).map((r) => (
              <div key={r.id} className="list-row" style={{ gridTemplateColumns: "1.5fr .8fr auto auto auto" }}>
                <div>
                  <Link href={`/requests/${r.id}`} className="lr-title">{r.title}</Link>
                  <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{r.id}</div>
                </div>
                <span className="lr-target">{r.targetDb}</span>
                <SeverityChip severity={r.overallSeverity} />
                <StatusChip status={r.status} />
                <Link href={`/requests/${r.id}`} className="lr-action">Review</Link>
              </div>
            ))}
          </div>

          {/* Severity distribution */}
          <div className="glass" style={{ marginTop: 14 }}>
            <h3 className="section-title">Severity distribution</h3>
            <div className="sev-meter" style={{ height: 12, marginBottom: 10 }}>
              {[
                { key: "green", color: "var(--safe)", count: sevDist.green },
                { key: "amber", color: "var(--warn)", count: sevDist.amber },
                { key: "red", color: "var(--danger)", count: sevDist.red },
              ].filter((s) => s.count > 0).map((s) => (
                <div key={s.key} className="seg active" style={{ background: s.color, color: s.color, flex: s.count }} title={`${s.key}: ${s.count}`} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-dim)" }}>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--safe)", marginRight: 6 }} />Safe: {sevDist.green}</span>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--warn)", marginRight: 6 }} />Caution: {sevDist.amber}</span>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--danger)", marginRight: 6 }} />Danger: {sevDist.red}</span>
            </div>
          </div>
        </section>

        {/* Right column */}
        <section>
          <div className="glass" style={{ marginBottom: 14 }} data-tour="health">
            <h3 className="section-title">Pipeline health</h3>
            <div className="health-row"><span className={`pulse-dot-live ${dot(targetUp)}`} /> <span>target-db</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{targetUp ? ":5433 read-only" : "unreachable"}</span></div>
            <div className="health-row"><span className={`pulse-dot-live ${dot(shadowUp)}`} /> <span>shadow-db</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{shadowUp ? ":5434 ephemeral" : "unreachable"}</span></div>
            <div className="health-row"><span className={`pulse-dot-live ${dot(sentinelUp)}`} /> <span>sentinel-db</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{sentinelUp ? ":5435 control" : "unreachable"}</span></div>
            <div className="health-row"><span className={`pulse-dot-live ${dot(trueforgeUp)}`} /> <span>TrueForge</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{trueforgeUp ? "agent harness · live" : "unreachable"}</span></div>
            <div className="health-row"><span className={`pulse-dot-live ${copilotUp ? "ok" : "off"}`} /> <span>Copilot</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{copilotUp ? "Euron · BYOK" : "configure key"}</span></div>
            <div className="health-row"><span className="pulse-dot-live off" /> <span>Qodo</span> <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>advisory</span></div>
          </div>

          <div className="glass">
            <h3 className="section-title">Recent activity</h3>
            <div className="timeline" style={{ marginTop: 10 }}>
              {audit.slice(0, 5).map((e) => (
                <div key={e.id} className={`tl-item tl-${e.tone}`}>
                  <span className="tl-dot" />
                  <div style={{ fontSize: 12 }}>
                    <span className="mono" style={{ fontSize: 11 }}>{e.action}</span>
                    <span style={{ color: "var(--faint)", marginLeft: 6 }}>{timeAgo(e.at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{e.detail}</div>
                </div>
              ))}
            </div>
            <Link href="/audit" style={{ fontSize: 12, marginTop: 8, display: "inline-block" }}>Full audit log</Link>
          </div>
        </section>
      </div>
    </>
  );
}
