import { NextResponse, after } from "next/server";
import { listRequests, createRequest } from "@sentinel/db/queries";
import { runAgentPipeline } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  // Migration SQL + target details are not public — require an approver session.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const records = await listRequests();
  return NextResponse.json(records);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const targetDb = typeof body.targetDb === "string" ? body.targetDb.trim() : "";
  const upSql = typeof body.upSql === "string" ? body.upSql : "";
  const downSql = typeof body.downSql === "string" ? body.downSql : "";
  if (!title || !targetDb || !upSql.trim()) {
    return NextResponse.json({ error: "title, targetDb and upSql are required." }, { status: 400 });
  }

  const rec = await createRequest({ title, targetDb, upSql, downSql, requestedBy: session.user });

  // Run the safety pipeline as tracked post-response work (Next `after`), not a
  // detached floating promise that can be dropped — it advances the request
  // status in the DB, which the console reads + streams.
  after(async () => {
    try {
      await runAgentPipeline(rec.id);
    } catch (e) {
      console.error(`[agent] pipeline failed for ${rec.id}:`, e);
    }
  });

  return NextResponse.json({ id: rec.id });
}
