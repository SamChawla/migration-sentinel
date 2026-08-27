import { NextResponse } from "next/server";
import { getRequest, listAuditEventsForRequest, getRequestTargetUrl } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";
import { euronConfigured, EuronError } from "@/lib/euron";
import { answerMigrationQuestion } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION = 2000;

/**
 * Read-only migration copilot. Auth-gated (approver session), scoped to ONE
 * request. It can read the request's analysis and run guarded read-only SELECTs
 * against the target DB — it can never approve, apply, or mutate anything.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (!euronConfigured()) {
    return NextResponse.json(
      { error: "Copilot is not configured. Set EURON_API_KEY in .env to enable it." },
      { status: 503 },
    );
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "A question is required." }, { status: 400 });
  if (question.length > MAX_QUESTION) {
    return NextResponse.json({ error: `Question too long (max ${MAX_QUESTION} chars).` }, { status: 400 });
  }
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m: unknown): m is { role: "user" | "assistant"; content: string } =>
          !!m && typeof m === "object" &&
          (( m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
          typeof (m as { content?: unknown }).content === "string",
        )
        .slice(-8)
    : [];

  const rec = await getRequest(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [audit, targetUrl] = await Promise.all([
    listAuditEventsForRequest(id, 30),
    getRequestTargetUrl(id),
  ]);

  try {
    const result = await answerMigrationQuestion({ rec, audit, targetUrl, question, history });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof EuronError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: (e as Error).message || "Copilot failed." }, { status: 500 });
  }
}
