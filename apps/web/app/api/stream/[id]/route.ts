/**
 * SSE live-status endpoint. Streams the REAL request status + audit events from
 * the control-plane database as the pipeline advances, and closes when the
 * request reaches a terminal state (or a safety timeout).
 */
import { getRequest, listAuditEvents } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["applied", "failed", "rejected", "rolled_back"]);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let lastStatus: string | null = null;
      const seenAudit = new Set<string>();
      const startedAt = Date.now();
      const MAX_MS = 5 * 60 * 1000;

      const tick = async () => {
        try {
          const rec = await getRequest(id);
          if (!rec) {
            send("error", { message: "request not found" });
            clearInterval(timer);
            controller.close();
            return;
          }
          if (rec.status !== lastStatus) {
            lastStatus = rec.status;
            send("status", { status: rec.status });
          }
          const events = (await listAuditEvents()).filter((e) => e.requestId === id);
          for (const e of events.reverse()) {
            if (!seenAudit.has(e.id)) {
              seenAudit.add(e.id);
              send("audit", { at: e.at, action: e.action, detail: e.detail, tone: e.tone });
            }
          }
          if (TERMINAL.has(rec.status) || rec.status === "blocked" || Date.now() - startedAt > MAX_MS) {
            clearInterval(timer);
            controller.close();
          }
        } catch (e) {
          send("error", { message: (e as Error).message });
          clearInterval(timer);
          controller.close();
        }
      };

      const timer = setInterval(tick, 1000);
      await tick();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
