"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
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

function matchesFilter(r: RequestRecord, f: string): boolean {
  // Each filter maps to a DISTINCT outcome — never conflate approved with
  // applied, or human rejections with pipeline/apply failures.
  if (f === "all") return true;
  if (f === "awaiting_approval") return r.status === "awaiting_approval";
  if (f === "in_flight") return ["received", "generating", "reviewing", "dry_running", "approved", "applying"].includes(r.status);
  if (f === "applied") return r.status === "applied";
  if (f === "blocked") return r.status === "blocked";
  if (f === "rejected") return r.status === "rejected";
  if (f === "failed") return ["failed", "rolled_back"].includes(r.status);
  return true;
}

export function RequestsTable({ records, filterable = false, initialQuery = "" }: { records: RequestRecord[]; filterable?: boolean; initialQuery?: string }) {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState(initialQuery);

  const rows = useMemo(
    () =>
      records
        .filter((r) => matchesFilter(r, filter))
        .filter((r) => !q || (r.title + r.targetDb + r.requestedBy).toLowerCase().includes(q.toLowerCase())),
    [records, filter, q],
  );

  return (
    <>
      {filterable && (
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f.key} className={`fchip${filter === f.key ? " on" : ""}`} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
          <input
            className="field"
            style={{ maxWidth: 220, marginLeft: "auto", padding: "6px 12px", fontSize: 12 }}
            placeholder="Filter..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
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
            {rows.map((r) => (
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
            {rows.length === 0 && (
              <tr><td colSpan={7}>
                <div className="empty-state">
                  <h3>{q || filter !== "all" ? "No migrations match" : "No migrations yet"}</h3>
                  <p>{q || filter !== "all"
                    ? "Adjust your filters."
                    : "Submit your first migration and the agent will analyze it."}</p>
                  {!q && filter === "all" && (
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
