import { NextResponse } from "next/server";
import { Client } from "pg";
import dns from "node:dns/promises";
import net from "node:net";
import { listTargetDatabases, addTargetConnection } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

const PROBE_DEADLINE_MS = 8000;

/** Resolve hostname once and return the IP if it's public, or null if private/unresolvable.
 *  Prevents DNS rebinding: the caller connects to the returned IP, not the hostname. */
async function resolvePublicHost(hostname: string): Promise<string | null> {
  if (net.isIP(hostname)) {
    return isPrivateIp(hostname) ? null : hostname;
  }
  try {
    const { address } = await dns.lookup(hostname);
    return isPrivateIp(address) ? null : address;
  } catch {
    return null;
  }
}

function isPrivateIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    return /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(addr);
  }
  const norm = normalizeIpv6(addr);
  if (norm.startsWith("::ffff:")) {
    const mapped = norm.slice(7);
    if (net.isIPv4(mapped)) return isPrivateIp(mapped);
  }
  return /^(::1$|fc|fd|fe[89ab])/.test(norm) || norm === "::";
}

function normalizeIpv6(addr: string): string {
  const buf = Buffer.alloc(16);
  const parts = addr.split(":");
  let writeIndex = 0;
  let gapIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") { gapIndex = i; break; }
    const v = parseInt(parts[i], 16);
    buf.writeUInt16BE(v, writeIndex);
    writeIndex += 2;
  }
  if (gapIndex >= 0) {
    let tail = 15;
    for (let i = parts.length - 1; i > gapIndex; i--) {
      if (parts[i] === "") continue;
      if (parts[i].includes(".")) {
        const octets = parts[i].split(".").map(Number);
        buf[tail--] = octets[3];
        buf[tail--] = octets[2];
        buf[tail--] = octets[1];
        buf[tail--] = octets[0];
      } else {
        const v = parseInt(parts[i], 16);
        buf.writeUInt16BE(v, tail - 1);
        tail -= 2;
      }
    }
  }
  return Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(i * 2).toString(16)).join(":").replace(/\b0(:0)+\b/, "::").toLowerCase();
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
  if (!alias || alias.length > 64 || !/^[\w .:-]+$/.test(alias)) {
    return NextResponse.json({ error: "A short alias (letters, numbers, . : - _) is required." }, { status: 400 });
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return NextResponse.json({ error: "A postgres:// connection URL is required." }, { status: 400 });
  }

  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return NextResponse.json({ error: "Malformed connection URL." }, { status: 400 });
  }
  const resolvedIp = await resolvePublicHost(parsed.hostname);
  if (!resolvedIp) {
    return NextResponse.json({ error: "Connections to private/internal network addresses are not allowed." }, { status: 422 });
  }

  // Connect to the resolved IP so a DNS rebind between validation and
  // connect cannot redirect the probe to a different (private) host.
  const probeUrl = new URL(url);
  probeUrl.hostname = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
  const probe = await probeConnection(probeUrl.toString(), req.signal);
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
