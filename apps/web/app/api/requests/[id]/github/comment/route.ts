import { NextResponse } from "next/server";
import {
  getRequest,
  getGithubLink,
  setGithubLinkCommentId,
  insertAuditEvent,
} from "@sentinel/db/queries";
import { buildVerdictComment } from "@sentinel/core";
import { createGithubClient, GithubApiError } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Post (or idempotently UPDATE, via the stored comment id) the Sentinel
 * safety verdict as a comment on the linked PR.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const [rec, link] = await Promise.all([getRequest(id), getGithubLink(id)]);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!link) return NextResponse.json({ error: "No GitHub PR is linked to this request." }, { status: 404 });

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN is not configured.", code: "github_token_missing" },
      { status: 409 },
    );
  }

  // A verdict comment only makes sense once the analysis completed successfully.
  const ELIGIBLE = new Set(["awaiting_approval", "approved", "applying", "applied", "rejected", "rolled_back"]);
  if (!ELIGIBLE.has(rec.status)) {
    return NextResponse.json(
      { error: rec.status === "failed"
          ? "Analysis failed — there is no valid verdict to post."
          : "Analysis is still running — there is no verdict to post yet." },
      { status: 409 },
    );
  }

  const body = buildVerdictComment({
    requestId: rec.id,
    title: rec.title,
    severity: rec.overallSeverity,
    environment: rec.environment,
    rollbackVerified: rec.rollbackVerified,
    reversibility: rec.reversibility,
    rowsAffected: rec.rowsAffected,
    findings: rec.findings.map((f) => ({ statement: f.statement, severity: f.severity, note: f.note })),
    qodo: { verdict: rec.qodoVerdict, findings: rec.qodoFindings },
    consoleUrl: `${new URL(req.url).origin}/requests/${rec.id}`,
  });

  try {
    const gh = createGithubClient({ token });

    // Refuse to post a verdict if the PR head has moved since the analyzed commit.
    const livePr = await gh.getPr(link.repo, link.prNumber);
    if (livePr.headSha !== link.commitSha) {
      return NextResponse.json(
        {
          error: `The PR head has moved (analyzed ${link.commitSha.slice(0, 7)}, now ${livePr.headSha.slice(0, 7)}). Re-analyze this migration before posting a verdict.`,
          code: "head_drift",
        },
        { status: 409 },
      );
    }

    let commentId = link.commentId;
    if (commentId) {
      try {
        await gh.updateComment(link.repo, commentId, body);
      } catch (e) {
        // The stored comment may have been deleted on GitHub — fall back to a
        // fresh post rather than failing the re-post.
        if (e instanceof GithubApiError && e.status === 404) commentId = null;
        else throw e;
      }
    }
    if (!commentId) {
      // Re-read to guard against a concurrent POST that created a comment
      // between our initial read and here.
      const freshLink = await getGithubLink(id);
      if (freshLink?.commentId) {
        commentId = freshLink.commentId;
        await gh.updateComment(link.repo, commentId, body);
      } else {
        const created = await gh.createComment(link.repo, link.prNumber, body);
        commentId = created.id;
        await setGithubLinkCommentId(id, commentId);
      }
    }
    try {
      await insertAuditEvent({
        migrationRequestId: id,
        actor: session.user,
        action: "github.verdict_posted",
        detail: `Safety verdict posted to ${link.repo}#${link.prNumber} (comment ${commentId}).`,
        tone: "info",
      });
    } catch (auditErr) {
      console.error(`[github] verdict audit write failed for ${id}:`, auditErr);
    }
    return NextResponse.json({ commentId });
  } catch (e) {
    if (e instanceof GithubApiError) {
      return NextResponse.json({ error: e.message, code: "github_error" }, { status: e.status === 404 ? 404 : 502 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
