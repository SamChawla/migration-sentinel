import Link from "next/link";
import { listRequests, countRequests } from "@sentinel/db/queries";
import { RequestsTable } from "@/components/RequestsTable";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const SORTS = new Set(["created_at", "title", "target", "status"]);

export default async function Migrations({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; status?: string; sort?: string; dir?: string }>;
}) {
  const { q, page: pageParam, status, sort: sortParam, dir: dirParam } = await searchParams;
  const filter = status ?? "all";
  const sort = SORTS.has(sortParam ?? "") ? (sortParam as string) : "created_at";
  const dir: "asc" | "desc" = dirParam === "asc" ? "asc" : "desc";
  // Filter + sort + count SERVER-SIDE so they apply across ALL pages and the
  // total is the filtered total (not "everything, then hide 45 client-side").
  const total = await countRequests({ q, status: filter });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(pageParam ?? "1", 10) || 1, 1), pageCount);
  const offset = (page - 1) * PAGE_SIZE;
  const requests = await listRequests({ limit: PAGE_SIZE, offset, q, status: filter, sort, dir });

  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (filter !== "all") sp.set("status", filter);
    if (sort !== "created_at") sp.set("sort", sort);
    if (dir !== "desc") sp.set("dir", dir);
    sp.set("page", String(p));
    return `/requests?${sp.toString()}`;
  };

  const filtered = Boolean(q) || filter !== "all";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>All Migrations</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            {total} {filtered ? "matching" : "total"}
            {pageCount > 1 && <span style={{ color: "var(--faint)" }}> · page {page} of {pageCount}</span>}
          </p>
        </div>
        <Link href="/requests/new" className="btn btn-cyan">+ New migration</Link>
      </div>
      <RequestsTable records={requests} filterable query={q ?? ""} activeFilter={filter} sort={sort} dir={dir} />
      {pageCount > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 16 }}>
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn btn-sm">← Previous</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>← Previous</span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{page} / {pageCount}</span>
          {page < pageCount ? (
            <Link href={pageHref(page + 1)} className="btn btn-sm">Next →</Link>
          ) : (
            <span className="btn btn-sm" aria-disabled style={{ opacity: 0.4, pointerEvents: "none" }}>Next →</span>
          )}
        </div>
      )}
    </>
  );
}
