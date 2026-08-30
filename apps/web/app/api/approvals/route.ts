import { NextResponse } from "next/server";
import {
  getRequest,
  getTrueforgeSession,
  getApplyGuardContext,
  getGithubLink,
  recordApproval,
  recordExportPr,
  transitionRequestStatus,
  resetApproval,
  insertAuditEvent,
  setRequestStatus,
} from "@sentinel/db/queries";
import {
  assertApproved,
  GateError,
  escalateForEnvironment,
  promotionEligible,
  buildVerdictComment,
  type GateDisposition,
} from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import {
  applyMigration,
  resolveApplyGate,
  createGithubClient,
  exportMigrationPr,
} from "@sentinel/agent";
import { getSession } from "@/lib/auth";
import { publicBaseUrl } from "@/lib/base-url";

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

  // ── Environment guards (doc 11 §4) — approve path only, before the gate. ──
  // PROMOTION LOCK: a prod request cannot be APPROVED until a sibling in the
  // same promotion group was APPLIED on a lower environment with the same
  // (normalized) SQL. Server-side authority — a curl straight at this endpoint
  // hits the same refusal as the UI. Rejection of a locked request stays open
  // (handled above); only approval is locked.
  if (rec.environment === "prod") {
    const guardCtx = await getApplyGuardContext(requestId);
    if (!guardCtx || !promotionEligible(guardCtx)) {
      try {
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor,
          action: "gate.promotion_locked",
          detail: `Prod approval refused — no lower-environment applied run of this migration exists yet: "${rec.title}".`,
          tone: "red",
        });
      } catch (auditErr) {
        console.error(`[approvals] promotion-lock audit write failed for ${requestId}:`, auditErr);
      }
      return NextResponse.json(
        {
          error:
            "Promotion locked: apply this migration on a lower environment first. Prod approval unlocks once a lower-env run of the same SQL is applied.",
          code: "promotion_locked",
        },
        { status: 403 },
      );
    }
  }

  // Re-derive the env-scaled typed-confirm requirement instead of trusting the
  // stored flag alone: prod amber/red demands a typed confirmation even when the
  // persisted gate was armed softer (legacy row, or a tampered write). Non-prod
  // resolves to the stored flag — behaviour there is unchanged.
  const storedDisposition: GateDisposition = blocked
    ? "blocked"
    : rec.approval.requiresTypedConfirm
      ? "typed_confirm"
      : rec.overallSeverity === "amber"
        ? "approval"
        : "auto";
  const requiresTypedConfirm =
    rec.approval.requiresTypedConfirm ||
    escalateForEnvironment(storedDisposition, rec.overallSeverity, rec.environment) ===
      "typed_confirm";

  // When environment escalation promotes a request to typed_confirm but the
  // pipeline never set an expectedConfirmValue (older row, or severity was
  // green when persisted), derive a fallback from the SQL so the user has a
  // real token to type rather than a permanently stuck gate.
  let expectedConfirmValue = rec.approval.expectedConfirm ?? null;
  if (requiresTypedConfirm && !expectedConfirmValue) {
    const tableM =
      rec.upSql.match(/\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)/i) ??
      rec.upSql.match(/\bUPDATE\s+(?:ONLY\s+)?([\w."]+)/i) ??
      rec.upSql.match(/\bDELETE\s+FROM\s+(?:ONLY\s+)?([\w."]+)/i) ??
      rec.upSql.match(/\bTRUNCATE\s+(?:TABLE\s+)?([\w."]+)/i) ??
      rec.upSql.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i);
    expectedConfirmValue = tableM
      ? tableM[1].replace(/"/g, "").split(".").pop() ?? "CONFIRM"
      : "CONFIRM";
  }

  // Pre-check the gate before recording an approval.
  try {
    assertApproved({
      decision: "approved",
      requiresTypedConfirm,
      typedConfirmValue: typedConfirm ?? null,
      expectedConfirmValue,
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

    // ── PR4 EXPORT GATE (doc 11 §5): a PROD approval with a linked repo and a
    // configured token does NOT apply. Sentinel exports {up, down, report} on
    // a branch, opens the gate-2 PR, and parks the request in awaiting_merge —
    // the human merge on GitHub is what releases the apply. The TrueForge
    // pause deliberately stays open: the apply has not been released yet.
    if (rec.environment === "prod") {
      const ghLink = await getGithubLink(requestId);
      const ghToken = process.env.GITHUB_TOKEN?.trim();
      if (ghLink && ghToken) {
        try {
          const gh = createGithubClient({ token: ghToken });
          const report = buildVerdictComment({
            requestId: rec.id,
            title: rec.title,
            severity: rec.overallSeverity,
            environment: rec.environment,
            rollbackVerified: rec.rollbackVerified,
            reversibility: rec.reversibility,
            rowsAffected: rec.rowsAffected,
            findings: rec.findings.map((f) => ({ statement: f.statement, severity: f.severity, note: f.note })),
            qodo: { verdict: rec.qodoVerdict, findings: rec.qodoFindings },
            consoleUrl: `${publicBaseUrl(req)}/requests/${rec.id}`,
          });
          const exported = await exportMigrationPr(gh, {
            repo: ghLink.repo,
            requestId: rec.id,
            title: rec.title,
            upSql: rec.upSql,
            downSql: rec.downSql,
            report,
          });
          await recordExportPr(requestId, {
            branch: exported.branch,
            prNumber: exported.prNumber,
            prUrl: exported.prUrl,
          });
          // Guarded approved → awaiting_merge — if a concurrent path already
          // moved the request, report the real state instead of pretending.
          const parked = await transitionRequestStatus(requestId, "approved", "awaiting_merge");
          if (!parked) {
            const fresh = await getRequest(requestId);
            return NextResponse.json(
              { error: `Export PR opened (${exported.prUrl}) but the request already moved to ${fresh?.status ?? "unknown"}.` },
              { status: 409 },
            );
          }
          try {
            await insertAuditEvent({
              migrationRequestId: requestId,
              actor: "sentinel.gate",
              action: "export.pr_opened",
              detail: `Exported to ${ghLink.repo}#${exported.prNumber} (${exported.branch}) — awaiting the source-of-truth merge (gate 2). No apply has run.`,
              tone: "info",
              payload: { prUrl: exported.prUrl, branch: exported.branch },
            });
          } catch (auditErr) {
            console.error(`[approvals] export audit write failed for ${requestId}:`, auditErr);
          }
          return NextResponse.json({ ok: true, status: "awaiting_merge", prUrl: exported.prUrl });
        } catch (exportErr) {
          // Existing unstrand pattern: the approval stands but the export leg
          // failed — land the request in 'failed' (never limbo) and say why.
          await transitionRequestStatus(requestId, "approved", "failed").catch(() => {});
          await insertAuditEvent({
            migrationRequestId: requestId,
            actor: "sentinel.gate",
            action: "export.failed",
            detail: `Export PR could not be opened: ${(exportErr as Error).message}`,
            tone: "red",
          }).catch(() => {});
          return NextResponse.json(
            { ok: false, status: "failed", error: `Export failed: ${(exportErr as Error).message}` },
            { status: 502 },
          );
        }
      }
      // Prod WITHOUT an export path (no linked repo, or no token): the direct
      // apply below still runs — loudly audited so nobody mistakes it for the
      // two-gate flow.
      try {
        await insertAuditEvent({
          migrationRequestId: requestId,
          actor: "sentinel.gate",
          action: "apply.direct_prod",
          detail: ghLink
            ? "PROD DIRECT APPLY — a repo is linked but GITHUB_TOKEN is not configured, so the export gate is unavailable."
            : "PROD DIRECT APPLY — no repo linked to this request; the GitHub merge gate is skipped.",
          tone: "red",
        });
      } catch (auditErr) {
        console.error(`[approvals] direct_prod audit write failed for ${requestId}:`, auditErr);
      }
    }

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
          requiresTypedConfirm,
          typedConfirmValue: typedConfirm ?? null,
          expectedConfirmValue,
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
