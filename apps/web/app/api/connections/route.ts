import { NextResponse } from "next/server";
import { Client } from "pg";
import { listTargetDatabases, addTargetConnection } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

const PROBE_DEADLINE_MS = 8000;

/** Reachability probe bounded end-to-end: pg query/statement timeouts AND a
 *  wall-clock race honouring the request's abort signal, so a server that stalls
 *  after connect can't hold the POST (or its socket) open indefinitely. */
async function probeConnection(url: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 4000,
    query_timeout: 4000,
    statement_timeout: 4000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancel = new Promise<never>((_, reject) => {
    const kill = (m: string) => { client.end().catch(() => {}); reject(new Error(m)); };
    timer = setTimeout(() => kill(`Connection test exceeded ${PROBE_DEADLINE_MS} ms.`), PROBE_DEADLINE_MS);
    if (signal.aborted) kill("Request aborted.");
    else { onAbort = () => kill("Request aborted."); signal.addEventListener("abort", onAbort, { once: true }); }
  });
  const work = (async () => {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT 1");
    await client.query("ROLLBACK").catch(() => {});
  })();
  try {
    await Promise.race([work, cancel]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    work.catch(() => {}); // swallow the abandoned probe's later rejection
    await client.end().catch(() => {});
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List the configured target databases (the selectable connections). */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ connections: await listTargetDatabases() });
}

/** Add a connection: verify it's reachable with a read-only SELECT 1, then store
 *  it. The connectivity test never writes; the guarded apply is the only path
 *  that writes the target, and only after approval. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!alias || alias.length > 64 || !/^[\w .:-]+$/.test(alias)) {
    return NextResponse.json({ error: "A short alias (letters, numbers, . : - _) is required." }, { status: 400 });
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return NextResponse.json({ error: "A postgres:// connection URL is required." }, { status: 400 });
  }

  // Read-only reachability probe (bounded end-to-end) — proves we can reach the
  // DB without touching it.
  const probe = await probeConnection(url, req.signal);
  if (!probe.ok) {
    return NextResponse.json({ error: `Could not connect: ${probe.error}` }, { status: 400 });
  }

  // Insert-only: refuse to reuse an alias so an "add" never reroutes existing
  // requests that reference that target row.
  const added = await addTargetConnection({ alias, url });
  if (!added.ok) {
    return NextResponse.json({ error: `A connection named "${alias}" already exists — select it from the list.` }, { status: 409 });
  }
  return NextResponse.json({ connection: added.row });
}
