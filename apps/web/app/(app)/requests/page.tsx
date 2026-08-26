import Link from "next/link";
import { listRequests } from "@sentinel/db/queries";
import { RequestsTable } from "@/components/RequestsTable";

export const dynamic = "force-dynamic";

export default async function Migrations({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const requests = await listRequests();
  const awaiting = requests.filter((r) => r.status === "awaiting_approval").length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>All Migrations</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            {requests.length} total
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
    </>
  );
}
