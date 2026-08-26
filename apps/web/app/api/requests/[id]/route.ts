import { NextResponse } from "next/server";
import { getRequest } from "@sentinel/db/queries";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = await getRequest(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rec);
}
