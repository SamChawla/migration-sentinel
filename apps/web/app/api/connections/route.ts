import { NextResponse } from "next/server";
import { Client } from "pg";
import { listTargetDatabases, upsertTargetDatabase } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

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

  // Read-only reachability probe inside a READ ONLY transaction with a short
  // timeout — proves we can reach the DB without touching it.
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 4000");
    await client.query("SELECT 1");
    await client.query("ROLLBACK").catch(() => {});
  } catch (e) {
    return NextResponse.json({ error: `Could not connect: ${(e as Error).message}` }, { status: 400 });
  } finally {
    await client.end().catch(() => {});
  }

  const row = await upsertTargetDatabase({ alias, url });
  return NextResponse.json({ connection: row });
}
