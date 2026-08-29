import { NextResponse } from "next/server";
import { getTargetUrlByAlias } from "@sentinel/db/queries";
import { introspectConnection, type SchemaIntrospection } from "@sentinel/shadow";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live schema of a registered connection (PR2). The connection URL is resolved
 * server-side by alias and NEVER serialized into the response. Honest errors:
 * 404 unknown alias, 409 registered but URL-less, 502 unreachable/timed out.
 *
 * A short in-memory cache absorbs the picker's repeated fetches (the ERD +
 * SchemaBrowser both hit this on render) without hiding real schema changes
 * for more than a few seconds. Per-process only — fine for a single web node.
 */
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: SchemaIntrospection }>();

export async function GET(_req: Request, { params }: { params: Promise<{ alias: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { alias: raw } = await params;
  const alias = decodeURIComponent(raw);

  const url = await getTargetUrlByAlias(alias);
  if (url === undefined) {
    return NextResponse.json({ error: `Unknown connection "${alias}".` }, { status: 404 });
  }
  if (url === null) {
    return NextResponse.json(
      { error: `Connection "${alias}" has no stored URL — re-add it with a URL in Settings.`, code: "no_url" },
      { status: 409 },
    );
  }

  const hit = cache.get(alias);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...hit.value, cached: true });
  }

  try {
    const schema = await introspectConnection(url, { deadlineMs: 8000 });
    cache.set(alias, { at: Date.now(), value: schema });
    return NextResponse.json({ ...schema, cached: false });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not introspect "${alias}": ${(e as Error).message}`, code: "unreachable" },
      { status: 502 },
    );
  }
}
