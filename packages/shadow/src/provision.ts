/**
 * Shadow-DB provisioning (ADR-003).
 *
 * Creates a disposable Postgres database, seeds it from the target's schema
 * (schema-only by default), hands back a connection, and tears it down.
 *
 * Uses an admin connection (SHADOW_ADMIN_URL) to CREATE/DROP DATABASE. For the
 * hackathon this points at the `shadow-db` compose service. In production you'd
 * back this with the TrueForge sandbox provider instead.
 */
import { Client } from "pg";
import { randomBytes } from "node:crypto";

export interface ShadowHandle {
  ref: string; // the ephemeral database name
  url: string; // connection string to the shadow DB
  seededWithData: boolean;
  destroy: () => Promise<void>;
}

export interface ProvisionOptions {
  adminUrl: string; // SHADOW_ADMIN_URL — must allow CREATE DATABASE
  /** DDL that recreates the target's schema on the shadow (schema-only). */
  schemaSql: string;
  seededWithData?: boolean;
}

function shadowName(): string {
  return `shadow_${randomBytes(6).toString("hex")}`;
}

function withDbName(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function provisionShadow(opts: ProvisionOptions): Promise<ShadowHandle> {
  const ref = shadowName();
  const admin = new Client({ connectionString: opts.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ref}`);
  } finally {
    await admin.end();
  }

  const url = withDbName(opts.adminUrl, ref);
  const shadow = new Client({ connectionString: url });
  await shadow.connect();
  try {
    await shadow.query(opts.schemaSql);
  } finally {
    await shadow.end();
  }

  return {
    ref,
    url,
    seededWithData: opts.seededWithData ?? false,
    destroy: async () => {
      const a = new Client({ connectionString: opts.adminUrl });
      await a.connect();
      try {
        // terminate any stragglers, then drop
        await a.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [ref],
        );
        await a.query(`DROP DATABASE IF EXISTS ${ref}`);
      } finally {
        await a.end();
      }
    },
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Candidate pg_dump executables, in priority order. Override with $PG_DUMP. */
function pgDumpCandidates(): string[] {
  const list: string[] = [];
  if (process.env.PG_DUMP) list.push(process.env.PG_DUMP);
  list.push("pg_dump");
  if (process.platform === "win32") {
    for (const v of ["18", "17", "16", "15"]) {
      list.push(`C:/Program Files/PostgreSQL/${v}/bin/pg_dump.exe`);
    }
  }
  return list;
}

/**
 * pg_dump (v16+) emits psql meta-commands like `\restrict <token>` and
 * `\unrestrict` that are NOT SQL and fail when sent over the wire protocol
 * (client.query). We replay the DDL through the pg client, not psql, so strip
 * any line that is a psql backslash meta-command before applying.
 */
export function sanitizeDump(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\/.test(line))
    // Drop version-specific GUCs a newer pg_dump writes that an older shadow
    // server rejects (e.g. transaction_timeout is PG17+). These are session
    // no-ops for a schema replay, so stripping them is safe.
    .filter((line) => !/^\s*SET\s+transaction_timeout\b/i.test(line))
    .join("\n");
}

/**
 * Dump the target's schema (schema-only) as DDL to seed a shadow, using the real
 * `pg_dump` binary against the live target. This is what makes the shadow a
 * faithful clone of production structure — the dry-run runs the migration on an
 * exact copy of the target's schema, not a hand-written fixture.
 *
 * `--no-owner --no-privileges` strips role grants so the DDL replays cleanly on a
 * fresh shadow owned by a different user.
 */
export async function dumpTargetSchema(targetUrl: string): Promise<string> {
  const args = [
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--dbname",
    targetUrl,
  ];
  let lastErr: unknown;
  for (const bin of pgDumpCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      if (stdout && stdout.trim().length > 0) return sanitizeDump(stdout);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `dumpTargetSchema failed: could not run pg_dump (tried ${pgDumpCandidates().join(", ")}). ` +
      `Set $PG_DUMP to the pg_dump path. Last error: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}
