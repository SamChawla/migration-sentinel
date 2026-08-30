import Link from "next/link";
import { listAuditEvents, countAuditEvents } from "@sentinel/db/queries";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function AuditLog({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const total = await countAuditEvents();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(pageParam ?? "1", 10) || 1, 1), pageCount);
  const events = await listAuditEvents({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            Append-only. Every state change, decision, and apply — actor, action, timestamp.
            <span style={{ color: "var(--faint)", marginLeft: 8 }}>
              {total} events{pageCount > 1 && ` · page ${page} of ${pageCount}`}
            </span>
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

      {pageCount > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 16 }}>
          {page > 1 ? (
            <Link href={`/audit?page=${page - 1}`} className="btn btn-sm">← Newer</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>← Newer</span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{page} / {pageCount}</span>
          {page < pageCount ? (
            <Link href={`/audit?page=${page + 1}`} className="btn btn-sm">Older →</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>Older →</span>
          )}
        </div>
      )}
    </>
  );
}
