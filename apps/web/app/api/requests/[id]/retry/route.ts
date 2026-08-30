import { NextResponse, after } from "next/server";
import { retryRequest, getRequest, setRequestStatus, insertAuditEvent } from "@sentinel/db/queries";
import { runAgentPipeline } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Retry a migration request: reset it to 'received' and re-run the FULL analysis
 * pipeline. Eligible when the request FAILED, or when it has been stranded in a
 * pre-apply state (received/generating/reviewing/dry_running) past the staleness
 * window — a crash/restart between the pipeline claim and its failure handler can
 * leave a request stuck with no running worker. Nothing was ever applied for a
 * retryable request, so re-analyzing is always safe.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const outcome = await retryRequest(id, { actor: session.user });
  if (!outcome.ok) {
    const messages: Record<string, { error: string; status: number }> = {
      not_found: { error: "not found", status: 404 },
      not_retryable: {
        error: "Only a failed or stranded request can be retried — this one is still in flight or already resolved.",
        status: 409,
      },
      apply_stage: {
        error:
          "This request failed during apply — the target may have partially changed and needs manual reconciliation, so it can't be auto-retried.",
        status: 409,
      },
      in_progress: {
        error: "This request is still being analyzed — wait for it to finish or fail before retrying.",
        status: 409,
      },
    };
    const m = messages[outcome.reason] ?? { error: outcome.reason, status: 500 };
    return NextResponse.json({ error: m.error, code: outcome.reason }, { status: m.status });
  }

  // Same tracked post-response pattern (and strand backstop) as the intake and
  // promote routes — the reset request must never sit in 'received' forever.
  after(async () => {
    try {
      await runAgentPipeline(id);
    } catch (e) {
      console.error(`[agent] retry pipeline failed for ${id}:`, e);
      try {
        const cur = await getRequest(id);
        if (cur && ["received", "generating", "dry_running"].includes(cur.status)) {
          await setRequestStatus(id, "failed");
          await insertAuditEvent({
            migrationRequestId: id,
            actor: "sentinel.agent",
            action: "pipeline.failed",
            detail: `Retry pipeline crashed before completing: ${(e as Error).message}`,
            tone: "red",
          });
        }
      } catch (inner) {
        console.error(`[agent] failed to mark retried ${id} failed:`, inner);
      }
    }
  });

  return NextResponse.json({ id, retriedFrom: outcome.from });
}
