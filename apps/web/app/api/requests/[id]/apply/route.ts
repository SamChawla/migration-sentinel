import { NextResponse } from "next/server";
import {
  getRequest,
  getGithubLink,
  getTrueforgeSession,
  markExportMerged,
  transitionRequestStatus,
  insertAuditEvent,
  setRequestStatus,
} from "@sentinel/db/queries";
import {
  assertApproved,
  GateError,
  escalateForEnvironment,
  type GateDisposition,
} from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import { applyMigration, createGithubClient, resolveApplyGate, GithubApiError } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * The merge-verified apply (PR4, gate 2): only an `awaiting_merge` request
 * with a recorded export PR can come through here, and only after a LIVE
 * merge check against GitHub — the cached state and the UI button are
 * cosmetic; this route is the authority. On a verified merge the request
 * moves (guarded) back to `approved` and the guarded executor runs with
 * every existing check intact.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const typedConfirm = typeof body.typedConfirm === "string" ? body.typedConfirm : null;

  const [rec, link] = await Promise.all([getRequest(id), getGithubLink(id)]);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rec.status !== "awaiting_merge") {
    return NextResponse.json(
      { error: `Request is not awaiting a merge (status=${rec.status}).` },
      { status: 409 },
    );
  }
  if (!link || link.exportPrNumber == null) {
    return NextResponse.json({ error: "No export PR is recorded for this request." }, { status: 409 });
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN is not configured — the merge cannot be verified.", code: "github_token_missing" },
      { status: 409 },
    );
  }

  const gh = createGithubClient({ token });

  // ── LIVE merge verification — never trust the cached state for the release.
  let exportPr: Awaited<ReturnType<typeof gh.getPr>>;
  try {
    exportPr = await gh.getPr(link.repo, link.exportPrNumber);
  } catch (e) {
    const msg = e instanceof GithubApiError ? e.message : (e as Error).message;
    return NextResponse.json({ error: `Could not verify the merge: ${msg}` }, { status: 502 });
  }
  if (!exportPr.merged) {
    return NextResponse.json(
      { error: `Export PR #${link.exportPrNumber} is not merged yet — merge it on GitHub to release the apply.`, code: "not_merged" },
      { status: 409 },
    );
  }

  // ── Issue 2: distinct approver — the person who merged the PR on GitHub
  // must not be the same user releasing the apply on Sentinel.
  if (exportPr.mergedBy && exportPr.mergedBy === session.user) {
    return NextResponse.json(
      { error: "The person who merged the export PR on GitHub cannot also release the apply — a distinct approver is required for gate 2." },
      { status: 403 },
    );
  }

  // ── Issue 1: verify merged SQL matches the analyzed artifact.
  try {
    const prFiles = await gh.getPrFiles(link.repo, link.exportPrNumber);
    const upFile = prFiles.find((f) => f.filename.endsWith("/up.sql"));
    if (upFile) {
      const mergedSql = await gh.getFileContents(link.repo, upFile.filename, exportPr.headSha);
      if (mergedSql.trim() !== rec.upSql.trim()) {
        return NextResponse.json(
          { error: "The merged up.sql does not match the analyzed migration SQL — the PR was modified after export. Re-analyze before applying." },
          { status: 409 },
        );
      }
    }
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 404) {
      return NextResponse.json(
        { error: "Could not read the merged up.sql — the export folder may have been modified or removed." },
        { status: 409 },
      );
    }
    const msg = e instanceof GithubApiError ? e.message : (e as Error).message;
    return NextResponse.json({ error: `Could not verify merged SQL: ${msg}` }, { status: 502 });
  }

  await markExportMerged(id);

  // ── Issue 3: validate typed confirmation BEFORE transitioning state — a
  // mistyped confirmation must not leave the request stranded in 'approved'.
  const blocked = classifyMigration(rec.upSql).hasBlockingStatement;
  const storedDisposition: GateDisposition = blocked
    ? "blocked"
    : rec.approval.requiresTypedConfirm
      ? "typed_confirm"
      : rec.overallSeverity === "amber"
        ? "approval"
        : "auto";
  const requiresTypedConfirm =
    rec.approval.requiresTypedConfirm ||
    escalateForEnvironment(storedDisposition, rec.overallSeverity, rec.environment) === "typed_confirm";

  if (requiresTypedConfirm || blocked) {
    try {
      assertApproved({
        decision: rec.approval.decision,
        requiresTypedConfirm,
        typedConfirmValue: typedConfirm,
        expectedConfirmValue: rec.approval.expectedConfirm ?? null,
        blocked,
      });
    } catch (e) {
      if (e instanceof GateError) {
        return NextResponse.json({ error: e.message }, { status: 403 });
      }
      throw e;
    }
  }

  // Guarded awaiting_merge → approved; the one-shot claim inside applyMigration
  // then takes approved → applying exactly as on the direct path.
  const released = await transitionRequestStatus(id, "awaiting_merge", "approved");
  if (!released) {
    const fresh = await getRequest(id);
    return NextResponse.json(
      { error: `Request already moved to ${fresh?.status ?? "unknown"}.` },
      { status: 409 },
    );
  }
  try {
    await insertAuditEvent({
      migrationRequestId: id,
      actor: session.user,
      action: "export.merge_verified",
      detail: `Export PR ${link.repo}#${link.exportPrNumber} verified MERGED live (by ${exportPr.mergedBy ?? "unknown"}) — apply released.`,
      tone: "green",
    });
  } catch (auditErr) {
    console.error(`[apply] merge audit write failed for ${id}:`, auditErr);
  }

  try {
    const gateSession = await getTrueforgeSession(id);
    const gate = await resolveApplyGate({
      session: gateSession,
      decision: "approved",
      assertGate: () =>
        assertApproved({
          decision: rec.approval.decision,
          requiresTypedConfirm,
          typedConfirmValue: typedConfirm,
          expectedConfirmValue: rec.approval.expectedConfirm ?? null,
          blocked,
        }),
      execute: () => applyMigration(id, { typedConfirm }),
    });
    const result = gate.result!;
    if (result.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: result.error }, { status: 500 });
    }
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
    try {
      const cur = await getRequest(id);
      if (cur?.status === "approved") {
        await setRequestStatus(id, "failed");
        await insertAuditEvent({
          migrationRequestId: id,
          actor: "sentinel.apply",
          action: "apply.failed",
          detail: `Apply could not start after the merge release: ${(e as Error).message}`,
          tone: "red",
        });
      }
    } catch {
      /* best-effort unstrand */
    }
    if (e instanceof GateError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
