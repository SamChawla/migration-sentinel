import { NextResponse } from "next/server";
import {
  getRequest,
  getTrueforgeSession,
  recordApproval,
  resetApproval,
  insertAuditEvent,
  setRequestStatus,
} from "@sentinel/db/queries";
import { assertApproved, GateError } from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import { applyMigration, resolveApplyGate } from "@sentinel/agent";
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
    // The decision is already committed; the audit event is best-effort. A write
    // failure here must NOT 500 (the rejection took, and a retry would 409 without
    // recreating the event) — log it and still report the real outcome.
    try {
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor,
        action: "approval.rejected",
        detail: `Rejected — "${rec.title}".`,
        tone: "red",
      });
    } catch (auditErr) {
      console.error(`[approvals] rejected ${requestId} but audit write failed:`, auditErr);
    }
    // Phase A: carry the rejection to the paused TrueForge turn as a real
    // `user.tool_approval: deny`. Best-effort — the rejection above is already
    // authoritative; an unreachable TrueForge changes nothing.
    try {
      const gateSession = await getTrueforgeSession(requestId);
      if (gateSession) {
        const gate = await resolveApplyGate({
          session: gateSession,
          decision: "rejected",
          reason: `Rejected at the Sentinel gate by ${actor}.`,
          assertGate: () => {},
          execute: async () => undefined,
        });
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor: "sentinel.gate",
          action: "gate.trueforge_resolved",
          detail: gate.trueforgeUsed
            ? "TrueForge apply_migration pause resolved: DENY."
            : "TrueForge unreachable — deny not delivered; the deterministic gate already refused the apply.",
          tone: "neutral",
          payload: { trueforgeUsed: gate.trueforgeUsed, decision: "deny" },
        });
      }
    } catch (tfErr) {
      console.error(`[approvals] TrueForge deny resolve failed for ${requestId} (non-fatal):`, tfErr);
    }
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
    // Phase A: the decision travels through TrueForge's own protocol — resolve
    // the paused apply_migration turn with `user.tool_approval: allow`, but ONLY
    // after the deterministic core gate passes again (assertGate below re-runs
    // assertApproved with the same inputs — ADR-004: TrueForge is resumed by a
    // decision core has validated, never in place of it). No persisted session,
    // or an unreachable TrueForge, degrades to exactly the pre-Phase-A direct
    // call; the gate never depends on network liveness.
    const gateSession = await getTrueforgeSession(requestId);
    const gate = await resolveApplyGate({
      session: gateSession,
      decision: "approved",
      assertGate: () =>
        assertApproved({
          decision: "approved",
          requiresTypedConfirm: rec.approval.requiresTypedConfirm,
          typedConfirmValue: typedConfirm ?? null,
          expectedConfirmValue: rec.approval.expectedConfirm ?? null,
          blocked,
        }),
      execute: () => applyMigration(requestId, { typedConfirm: typedConfirm ?? null }),
    });
    if (gateSession) {
      // Which mechanism actually gated this apply — best-effort observability
      // (A.4); a failed audit write must not mask the (already done) apply.
      try {
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor: "sentinel.gate",
          action: "gate.trueforge_resolved",
          detail: gate.trueforgeUsed
            ? "TrueForge apply_migration pause resolved: ALLOW — guarded executor ran."
            : "TrueForge unreachable — fell back to the deterministic gate; guarded executor ran.",
          tone: "info",
          payload: { trueforgeUsed: gate.trueforgeUsed, decision: "allow" },
        });
      } catch (auditErr) {
        console.error(`[approvals] trueforge_resolved audit write failed for ${requestId}:`, auditErr);
      }
    }
    const result = gate.result!;
    if (result.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: result.error }, { status: 500 });
    }
    // The target committed. But applyMigration treats the control-plane 'applied'
    // status write as retried-best-effort; if it never stuck, the request may
    // still read 'applying'. Report that honestly instead of a clean 'applied'.
    if (result.controlPlaneSynced === false) {
      return NextResponse.json({
        ok: true,
        status: "applied",
        controlPlaneSynced: false,
        warning: "Applied to the target, but the control-plane status write did not complete — the request may show 'applying' until reconciled.",
      });
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
