/**
 * SSE live-log endpoint (scaffold). Streams a few demo lines; Phase 5.4 pipes
 * real shadow/apply logs from the agent here.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const lines = [
        `provisioning shadow for ${id}…`,
        "applying up on shadow…",
        "sampling pg_locks / EXPLAIN…",
        "applying down, diffing schema…",
        "report ready — gate open.",
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= lines.length) {
          clearInterval(timer);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${lines[i++]}\n\n`));
      }, 600);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
