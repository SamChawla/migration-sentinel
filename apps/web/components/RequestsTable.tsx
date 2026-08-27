import Link from "next/link";
import type { RequestRecord } from "@sentinel/db/queries";
import { SeverityChip, StatusChip } from "@/components/chips";
import { timeAgo } from "@/lib/format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "awaiting_approval", label: "Awaiting" },
  { key: "in_flight", label: "In flight" },
  { key: "applied", label: "Applied" },
  { key: "blocked", label: "Blocked" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
] as const;

function chipHref(status: string, q: string): string {
  const sp = new URLSearchParams();
  if (status && status !== "all") sp.set("status", status);
  if (q) sp.set("q", q);
  const qs = sp.toString();
  return qs ? `/requests?${qs}` : "/requests";
}

/**
 * Records are filtered SERVER-SIDE (by q + status), so the chips and search box
 * drive navigation — a filter reflects EVERY matching migration across all
 * pages, and the total/pagination stay consistent, instead of filtering only the
 * ~50 rows already loaded for the current page.
 */
export function RequestsTable({
  records,
  filterable = false,
  query = "",
  activeFilter = "all",
}: {
  records: RequestRecord[];
  filterable?: boolean;
  query?: string;
  activeFilter?: string;
}) {
  return (
    <>
      {filterable && (
        <div className="filters">
          {FILTERS.map((f) => (
            <Link key={f.key} href={chipHref(f.key, query)} className={`fchip${activeFilter === f.key ? " on" : ""}`}>
              {f.label}
            </Link>
          ))}
          <form action="/requests" method="get" style={{ marginLeft: "auto" }}>
            {activeFilter && activeFilter !== "all" && <input type="hidden" name="status" value={activeFilter} />}
            <input
              className="field"
              name="q"
              defaultValue={query}
              style={{ maxWidth: 220, padding: "6px 12px", fontSize: 12 }}
              placeholder="Search title / target / requester…"
            />
          </form>
        </div>
      )}
      <div className="glass" style={{ padding: 0, overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Migration</th>
              <th>Target</th>
              <th>Severity</th>
              <th>Rollback</th>
              <th>Status</th>
              <th>Age</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/requests/${r.id}`} style={{ color: "var(--text)", fontWeight: 600 }}>{r.title}</Link>
                  <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{r.id}</div>
                </td>
                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{r.targetDb}</td>
                <td><SeverityChip severity={r.overallSeverity} /></td>
                <td>
                  {r.rollbackVerified
                    ? <span className="sev-chip sev-green">✓ proven</span>
                    : r.reversibility === "irreversible"
                      ? <span className="sev-chip sev-red">⛔ none</span>
                      : <span style={{ color: "var(--faint)" }}>pending</span>}
                </td>
                <td><StatusChip status={r.status} /></td>
                <td style={{ color: "var(--faint)", fontSize: 12 }} suppressHydrationWarning>{timeAgo(r.createdAt)}</td>
                <td><Link href={`/requests/${r.id}`} style={{ fontSize: 12, color: "var(--cyan)" }}>Review</Link></td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td colSpan={7}>
                <div className="empty-state">
                  <h3>{query || activeFilter !== "all" ? "No migrations match" : "No migrations yet"}</h3>
                  <p>{query || activeFilter !== "all"
                    ? "Adjust your filters."
                    : "Submit your first migration and the agent will analyze it."}</p>
                  {!query && activeFilter === "all" && (
                    <Link href="/requests/new" className="btn btn-cyan btn-sm">+ Submit migration</Link>
                  )}
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
