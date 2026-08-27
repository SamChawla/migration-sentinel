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
  sort = "created_at",
  dir = "desc",
}: {
  records: RequestRecord[];
  filterable?: boolean;
  query?: string;
  activeFilter?: string;
  sort?: string;
  dir?: "asc" | "desc";
}) {
  // Clicking a sortable header toggles asc/desc (server-side, across all pages);
  // switching columns starts at desc. Preserves search + status, resets to page 1.
  function sortHref(col: string): string {
    const sp = new URLSearchParams();
    if (query) sp.set("q", query);
    if (activeFilter && activeFilter !== "all") sp.set("status", activeFilter);
    const nextDir = sort === col && dir === "desc" ? "asc" : "desc";
    if (col !== "created_at") sp.set("sort", col);
    if (nextDir !== "desc") sp.set("dir", nextDir);
    const qs = sp.toString();
    return qs ? `/requests?${qs}` : "/requests";
  }
  function SortTh({ col, label }: { col: string; label: string }) {
    const active = sort === col;
    return (
      <th>
        <Link href={sortHref(col)} className="th-sort" style={{ color: active ? "var(--text)" : "inherit", display: "inline-flex", alignItems: "center", gap: 5 }}>
          {label}
          <span style={{ fontSize: 9, color: active ? "var(--cyan)" : "var(--faint)" }}>{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
        </Link>
      </th>
    );
  }
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
              <SortTh col="title" label="Migration" />
              <SortTh col="target" label="Target" />
              <th>Severity</th>
              <th>Rollback</th>
              <SortTh col="status" label="Status" />
              <SortTh col="created_at" label="Age" />
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
