import { NextResponse } from "next/server";
import { listRequests, createRequest } from "@sentinel/db/queries";
import { runAgentPipeline } from "@sentinel/agent";

export const runtime = "nodejs";

export async function GET() {
  const records = await listRequests();
  return NextResponse.json(records);
}

export async function POST(req: Request) {
  const body = await req.json();
  const rec = await createRequest({
    title: body.title,
    targetDb: body.targetDb,
    upSql: body.upSql ?? "",
    downSql: body.downSql ?? "",
    requestedBy: "sam.chawla26@gmail.com",
  });

  // Kick off the live safety pipeline (generate?/dry-run/gate) in the background.
  // It advances the request status in the DB, which the console reads + streams.
  // We return immediately so intake stays responsive.
  void runAgentPipeline(rec.id).catch((e) => {
    console.error(`[agent] pipeline failed for ${rec.id}:`, e);
  });

  return NextResponse.json({ id: rec.id });
}
