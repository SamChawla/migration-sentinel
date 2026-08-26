import Link from "next/link";
import { listRequests, countRequests } from "@sentinel/db/queries";
import { RequestsTable } from "@/components/RequestsTable";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function Migrations({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: pageParam } = await searchParams;
  // Paginate over the REAL total — the query layer caps a single fetch, so
  // presenting one page as "all history" both hid older rows and made the total
  // and client-side filters wrong once more than one page of requests existed.
  const total = await countRequests();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(pageParam ?? "1", 10) || 1, 1), pageCount);
  const offset = (page - 1) * PAGE_SIZE;
  const requests = await listRequests({ limit: PAGE_SIZE, offset });
  const awaiting = requests.filter((r) => r.status === "awaiting_approval").length;

  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    sp.set("page", String(p));
    return `/requests?${sp.toString()}`;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>All Migrations</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            {total} total
            {pageCount > 1 && <span style={{ color: "var(--faint)" }}> · page {page} of {pageCount}</span>}
            {awaiting > 0 && (
              <span style={{ color: "var(--hold)", marginLeft: 8 }}>
                <span className="glow-dot" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--hold)", marginRight: 6 }} />
                {awaiting} paused at the gate
              </span>
            )}
          </p>
        </div>
        <Link href="/requests/new" className="btn btn-cyan">+ New migration</Link>
      </div>
      <RequestsTable records={requests} filterable initialQuery={q ?? ""} />
      {pageCount > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 16 }}>
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn btn-sm">← Newer</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>← Newer</span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{page} / {pageCount}</span>
          {page < pageCount ? (
            <Link href={pageHref(page + 1)} className="btn btn-sm">Older →</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>Older →</span>
          )}
        </div>
      )}
    </>
  );
}
