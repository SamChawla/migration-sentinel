import { NextResponse } from "next/server";
import { getRequest, recordApproval, resetApproval, insertAuditEvent, setRequestStatus } from "@sentinel/db/queries";
import { assertApproved, GateError } from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import { applyMigration } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

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
  // Only an authenticated approver may reach the gate.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const actor = session.user;

  const { requestId, decision, typedConfirm } = await req.json().catch(() => ({}));
  // Decisions must be explicit — anything other than 'approved'/'rejected' is
  // rejected outright so a malformed body can never fall through to the approve
  // path.
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: "decision must be 'approved' or 'rejected'." }, { status: 400 });
  }
  if (typeof requestId !== "string" || !requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  const rec = await getRequest(requestId);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  const blocked = classifyMigration(rec.upSql).hasBlockingStatement;

  // A blocked request may still be rejected (closed out), but never approved.
  const decidable = rec.status === "awaiting_approval" || rec.status === "blocked";
  if (!decidable) {
    return NextResponse.json({ error: `not awaiting approval (status=${rec.status})` }, { status: 409 });
  }

  if (decision === "rejected") {
    // recordApproval is a GUARDED transition — it only decides a request that is
    // still awaiting_approval/blocked. If a concurrent approval has already
    // claimed this request for apply (status=applying) between our status read
    // above and here, it returns false and we must NOT report a rejection that
    // didn't take — otherwise the apply finishes 'applied' after we told the
    // caller 'rejected', with contradictory audit events.
    const moved = await recordApproval({ requestId, decision: "rejected", approver: actor });
    if (!moved) {
      const fresh = await getRequest(requestId);
      return NextResponse.json(
        { error: `could not reject — request already ${fresh?.status ?? "changed"}.` },
        { status: 409 },
      );
    }
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor,
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
          actor,
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
  // Same guard: if the request left the decidable state under a concurrent
  // decision, refuse rather than approve-then-apply on stale state.
  const decided = await recordApproval({ requestId, decision: "approved", approver: actor });
  if (!decided) {
    const fresh = await getRequest(requestId);
    return NextResponse.json(
      { error: `could not record approval — request already ${fresh?.status ?? "changed"}.` },
      { status: 409 },
    );
  }
  // From here the request is 'approved'. If ANYTHING below throws before the
  // guarded apply claims it (an audit-write failure, or applyMigration throwing
  // on the gate / subversion / no-target checks that run BEFORE its claim), the
  // request would be stranded in 'approved' — the console hides its controls and
  // the approvals API 409s it, so no operator can move it. Terminate it instead.
  try {
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor,
      action: "approval.approved",
      detail: `Approved — "${rec.title}". Handing to the guarded apply executor.`,
      tone: "green",
    });
    const result = await applyMigration(requestId, { typedConfirm: typedConfirm ?? null });
    if (result.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: "applied" });
  } catch (e) {
    // applyMigration lands its OWN post-claim failures in 'failed' (it returns,
    // doesn't throw). A throw here means the apply never claimed, so the request
    // is still 'approved' — mark it failed so it isn't stranded.
    try {
      const cur = await getRequest(requestId);
      if (cur?.status === "approved") {
        await setRequestStatus(requestId, "failed");
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor: "sentinel.apply",
          action: "apply.failed",
          detail: `Apply could not start after approval: ${(e as Error).message}`,
          tone: "red",
        });
      }
    } catch {
      /* best-effort unstrand — don't mask the original error */
    }
    if (e instanceof GateError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
