import { NextResponse } from "next/server";
import { Client } from "pg";
import dns from "node:dns/promises";
import { listTargetDatabases, addTargetConnection, updateTargetEnvironment } from "@sentinel/db/queries";
import { ENV_ORDER, type DbEnvironment } from "@sentinel/core";
import { getSession } from "@/lib/auth";

const PROBE_DEADLINE_MS = 8000;

/** Block SSRF: reject URLs whose hostname resolves to private/internal IPs. */
async function isPrivateHost(hostname: string): Promise<boolean> {
  try {
    const { address } = await dns.lookup(hostname);
    return /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd|fe80)/.test(address);
  } catch {
    return true;
  }
}

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

  const body = await req.json().catch(() => null);
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object with alias and url." }, { status: 400 });
  }
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const environment = typeof body.environment === "string" ? body.environment.trim() : "dev";
  if (!alias || alias.length > 64 || !/^[\w .:-]+$/.test(alias)) {
    return NextResponse.json({ error: "A short alias (letters, numbers, . : - _) is required." }, { status: 400 });
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return NextResponse.json({ error: "A postgres:// connection URL is required." }, { status: 400 });
  }
  if (!(ENV_ORDER as readonly string[]).includes(environment)) {
    return NextResponse.json(
      { error: `environment must be one of: ${ENV_ORDER.join(", ")}.` },
      { status: 400 },
    );
  }

  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return NextResponse.json({ error: "Malformed connection URL." }, { status: 400 });
  }
  if (await isPrivateHost(parsed.hostname)) {
    return NextResponse.json({ error: "Connections to private/internal network addresses are not allowed." }, { status: 422 });
  }

  const probe = await probeConnection(url, req.signal);
  if (!probe.ok) {
    return NextResponse.json({ error: `Could not connect: ${probe.error}` }, { status: 400 });
  }

  // Insert-only: refuse to reuse an alias so an "add" never reroutes existing
  // requests that reference that target row.
  const added = await addTargetConnection({ alias, url, environment: environment as DbEnvironment });
  if (!added.ok) {
    return NextResponse.json({ error: `A connection named "${alias}" already exists — select it from the list.` }, { status: 409 });
  }
  return NextResponse.json({ connection: added.row });
}

/** Update the environment tag on an existing connection so misclassified
 *  targets (e.g. a prod alias that wasn't heuristically matched during the
 *  migration) can be corrected without re-adding. */
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object with alias and environment." }, { status: 400 });
  }
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const environment = typeof body.environment === "string" ? body.environment.trim() : "";
  if (!alias) {
    return NextResponse.json({ error: "alias is required." }, { status: 400 });
  }
  if (!(ENV_ORDER as readonly string[]).includes(environment)) {
    return NextResponse.json(
      { error: `environment must be one of: ${ENV_ORDER.join(", ")}.` },
      { status: 400 },
    );
  }

  const result = await updateTargetEnvironment(alias, environment as DbEnvironment);
  if (!result.ok) {
    return NextResponse.json({ error: `No connection named "${alias}" found.` }, { status: 404 });
  }
  return NextResponse.json({ connection: result.row });
}
