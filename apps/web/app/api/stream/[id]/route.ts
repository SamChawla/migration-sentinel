/**
 * SSE live-status endpoint. Streams the REAL request status + audit events from
 * the control-plane database as the pipeline advances, and closes when the
 * request reaches a terminal state, on client disconnect, or a safety timeout.
 */
import { getRequest, listAuditEventsForRequestSince } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["applied", "failed", "rejected", "rolled_back"]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clear = () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const stop = () => {
        if (closed) return;
        clear();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client went away mid-write — always tear the poller down.
          stop();
        }
      };
      // Client disconnect → stop polling immediately (don't run for MAX_MS).
      req.signal.addEventListener("abort", stop);

      let lastStatus: string | null = null;
      // Forward cursor over (created_at, id). Paging forward from it DRAINS a
      // burst of >1 page between polls, instead of a newest-N window silently
      // dropping the older events of that burst.
      let cursor: { at: string; id: string } | null = null;
      const startedAt = Date.now();
      const MAX_MS = 5 * 60 * 1000;

      const tick = async () => {
        if (closed) return;
        try {
          const rec = await getRequest(id);
          if (!rec) {
            send("error", { message: "request not found" });
            stop();
            return;
          }
          if (rec.status !== lastStatus) {
            lastStatus = rec.status;
            send("status", { status: rec.status });
          }
          // Drain forward from the cursor in bounded pages until caught up.
          for (;;) {
            const batch = await listAuditEventsForRequestSince(id, cursor, 100);
            if (batch.length === 0) break;
            for (const e of batch) {
              send("audit", { at: e.at, action: e.action, detail: e.detail, tone: e.tone });
              cursor = { at: e.at, id: e.id };
            }
            if (batch.length < 100 || closed) break;
          }
          if (TERMINAL.has(rec.status) || rec.status === "blocked" || Date.now() - startedAt > MAX_MS) {
            stop();
          }
        } catch (e) {
          send("error", { message: (e as Error).message });
          stop();
        }
      };

      // Self-scheduling: wait for each tick to finish before scheduling the next,
      // so a slow control-plane query can't cause ticks to overlap and pile up
      // (setInterval would fire regardless of whether the previous tick returned).
      const loop = async () => {
        await tick();
        if (!closed) timer = setTimeout(loop, 1000);
      };
      await loop();
    },
    // Reader cancelled (client closed the EventSource) — tear down the poller.
    cancel() {
      clear();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
