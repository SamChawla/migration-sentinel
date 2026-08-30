import { NextResponse } from "next/server";
import { getRequest, deleteRequestIfDeletable } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";
import { UNDELETABLE_STATUSES } from "@/lib/requests";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = await getRequest(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rec);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  // The status check, audit, and delete happen together under a row lock inside
  // deleteRequestIfDeletable — so a worker (analysis or apply) can't flip the row
  // into an active state between our check and the delete.
  const res = await deleteRequestIfDeletable(id, UNDELETABLE_STATUSES, { actor: session.user });
  if (res.outcome === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
  if (res.outcome === "blocked") {
    return NextResponse.json(
      { error: `Cannot delete a migration while it is ${res.status} — a worker is still running against it. Wait for it to finish (or retry / reject it first).` },
      { status: 409 },
    );
  }
  return NextResponse.json({ deleted: true });
}
