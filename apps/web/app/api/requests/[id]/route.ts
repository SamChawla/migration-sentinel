import { NextResponse } from "next/server";
import { getRequest, deleteRequest, insertAuditEvent } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = await getRequest(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rec);
}

// Statuses where a write to the target is in progress — deleting the control
// record out from under a live apply would orphan the transaction, so refuse.
const UNDELETABLE = new Set(["applying"]);

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const rec = await getRequest(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (UNDELETABLE.has(rec.status)) {
    return NextResponse.json(
      { error: `Cannot delete a migration while it is ${rec.status}. Wait for the apply to finish.` },
      { status: 409 },
    );
  }

  // Audit BEFORE the delete — the audit FK is ON DELETE SET NULL, so the row
  // survives the cascade with its detail intact (just detached from the id).
  await insertAuditEvent({
    migrationRequestId: id,
    actor: session.user,
    action: "request.deleted",
    detail: `Deleted "${rec.title}" (${rec.targetDb}, was ${rec.status}).`,
    tone: "red",
  }).catch(() => {});

  const ok = await deleteRequest(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
