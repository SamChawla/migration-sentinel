import { NextResponse } from "next/server";
import { getRequest, recordApproval, resetApproval, insertAuditEvent } from "@sentinel/db/queries";
import { assertApproved, GateError } from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import { applyMigration } from "@sentinel/agent";

export const runtime = "nodejs";

/**
 * The gate (ADR-004). Records the human decision, runs the INDEPENDENT gate
 * check, and — only when it passes — drives the guarded apply against the real
 * target. The apply cannot proceed unless assertApproved() passes here AND again
 * inside applyMigration (defense in depth).
 *
 * `blocked` is derived from the SQL of record (not a stored flag) so the refusal
 * is authoritative and tamper-proof: a whole-dataset destruction can never be
 * approved through this endpoint.
 */
export async function POST(req: Request) {
  const { requestId, decision, typedConfirm } = await req.json();
  const rec = await getRequest(requestId);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  const blocked = classifyMigration(rec.upSql).hasBlockingStatement;

  // A blocked request may still be rejected (closed out), but never approved.
  const decidable = rec.status === "awaiting_approval" || rec.status === "blocked";
  if (!decidable) {
    return NextResponse.json({ error: `not awaiting approval (status=${rec.status})` }, { status: 409 });
  }

  if (decision === "rejected") {
    await recordApproval({ requestId, decision: "rejected", approver: "operator" });
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor: "operator",
      action: "approval.rejected",
      detail: `Rejected — "${rec.title}".`,
      tone: "red",
    });
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // Pre-check the gate before recording an approval.
  try {
    assertApproved({
      decision: "approved",
      requiresTypedConfirm: rec.approval.requiresTypedConfirm,
      typedConfirmValue: typedConfirm ?? null,
      expectedConfirmValue: rec.approval.expectedConfirm ?? null,
      blocked,
    });
  } catch (e) {
    if (e instanceof GateError) {
      await resetApproval(requestId);
      if (blocked) {
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor: "operator",
          action: "apply.blocked",
          detail: `Apply refused — BLOCKED migration cannot be approved: "${rec.title}".`,
          tone: "red",
        });
      }
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  // Record the human decision, then run the guarded apply against the real target.
  await recordApproval({ requestId, decision: "approved", approver: "operator" });
  await insertAuditEvent({
    migrationRequestId: requestId,
    actor: "operator",
    action: "approval.approved",
    detail: `Approved — "${rec.title}". Handing to the guarded apply executor.`,
    tone: "green",
  });

  try {
    const result = await applyMigration(requestId, { typedConfirm: typedConfirm ?? null });
    if (result.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: "applied" });
  } catch (e) {
    if (e instanceof GateError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
