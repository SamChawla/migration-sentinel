import { NextResponse, after } from "next/server";
import { createPromotedRequest, getRequest, setRequestStatus, insertAuditEvent } from "@sentinel/db/queries";
import { runAgentPipeline } from "@sentinel/agent";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Promote a request one rung up the environment ladder (doc 11 §5): clone it —
 * same promotion_group_id, the latest artifact SQL — against a next-env
 * connection, then re-run the FULL analysis pipeline on the clone. Promotion
 * never skips analysis: the next environment gets its own shadow run, blast
 * report, and gate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const source = await getRequest(id);
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Only a migration that has actually landed on this environment moves up —
  // the rail is a ladder, not a fan-out of unproven copies.
  if (source.status !== "applied") {
    return NextResponse.json(
      { error: `Only an applied request can be promoted (status=${source.status}).` },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const targetAlias = typeof body.targetAlias === "string" ? body.targetAlias.trim() || undefined : undefined;

  const promoted = await createPromotedRequest({
    sourceRequestId: id,
    requestedBy: session.user,
    targetAlias,
  });
  if (!promoted.ok) {
    const messages: Record<string, { error: string; status: number }> = {
      not_found: { error: "not found", status: 404 },
      no_artifact: { error: "The request has no migration SQL to promote.", status: 409 },
      at_top: { error: "Already at prod — there is no higher environment.", status: 409 },
      no_connection: {
        error: "No registered connection (with a URL) exists for the next environment — add one in Settings.",
        status: 409,
      },
      already_promoted: { error: "This migration has already been promoted to the next environment.", status: 409 },
    };
    const m = messages[promoted.reason] ?? { error: promoted.reason, status: 500 };
    return NextResponse.json({ error: m.error, code: promoted.reason }, { status: m.status });
  }

  // Same tracked post-response pattern (and the same strand backstop) as the
  // intake route — the clone must never sit in 'received' forever.
  after(async () => {
    try {
      await runAgentPipeline(promoted.id);
    } catch (e) {
      console.error(`[agent] pipeline failed for promoted ${promoted.id}:`, e);
      try {
        const cur = await getRequest(promoted.id);
        if (cur && ["received", "generating", "dry_running"].includes(cur.status)) {
          await setRequestStatus(promoted.id, "failed");
          await insertAuditEvent({
            migrationRequestId: promoted.id,
            actor: "sentinel.agent",
            action: "pipeline.failed",
            detail: `Pipeline crashed before completing: ${(e as Error).message}`,
            tone: "red",
          });
        }
      } catch (inner) {
        console.error(`[agent] failed to mark promoted ${promoted.id} failed:`, inner);
      }
    }
  });

  return NextResponse.json({ id: promoted.id, environment: promoted.environment });
}
