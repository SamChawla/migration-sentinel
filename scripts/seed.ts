/**
 * Seed the demo TARGET database.
 *
 *   TARGET_DB_URL=postgres://user:pass@localhost:5433/prod pnpm tsx scripts/seed.ts
 *
 * Flags:
 *   --reset   Drop and recreate everything (default true; loads fixtures/target_schema.sql)
 *
 * This is the DB the agent will migrate. Keep it separate from the app-state DB.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { loadDotenv } from "./load-env.js";

loadDotenv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, "..", "fixtures", "target_schema.sql");

async function main() {
  const url = process.env.TARGET_DB_URL;
  if (!url) {
    console.error(
      "✗ TARGET_DB_URL is not set. Example:\n" +
        "  TARGET_DB_URL=postgres://postgres:postgres@localhost:5433/prod pnpm tsx scripts/seed.ts",
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`→ Connected to target: ${redact(url)}`);

  // GUARD: this fixture runs `DROP SCHEMA public CASCADE` — it destroys EVERY
  // object (tables, views, sequences, functions, types, …) and all data in the
  // target. Refuse against a non-empty database unless --reset is passed.
  const RESET = process.argv.includes("--reset");
  const sql = await readFile(SCHEMA_FILE, "utf8");
  console.log("→ Loading fixtures/target_schema.sql (drops & recreates public schema)…");
  const started = Date.now();

  // The occupancy check and the destructive fixture run in ONE SERIALIZABLE
  // transaction: (a) it counts EVERY object type, not just tables, so a schema of
  // views/sequences/functions/types isn't treated as empty; (b) if another session
  // commits a public-schema object between the check and the DROP, the
  // serialization conflict aborts this transaction rather than silently wiping it.
  let ms: number;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const existing = await client.query<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','c'))
       + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public')
       + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r'))
       )::int AS n`,
    );
    if (existing.rows[0].n > 0 && !RESET) {
      await client.query("ROLLBACK");
      console.error(
        `✗ Refusing to seed: the target's public schema already holds ${existing.rows[0].n} object(s) ` +
          `(tables / views / sequences / functions / types). This fixture DROPS the public schema. ` +
          `Re-run with --reset to wipe and reseed.`,
      );
      await client.end();
      process.exit(1);
    }
    await client.query(sql);
    await client.query("COMMIT");
    ms = Date.now() - started;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  const users = await client.query<{ count: string }>("SELECT count(*) FROM public.users");
  const orders = await client.query<{ count: string }>("SELECT count(*) FROM public.orders");

  console.log(`✓ Seeded in ${ms} ms`);
  console.log(`  users:  ${Number(users.rows[0].count).toLocaleString()}`);
  console.log(`  orders: ${Number(orders.rows[0].count).toLocaleString()}`);
  console.log(
    "\nTry a dangerous migration against it, e.g.:\n" +
      "  ALTER TABLE public.users DROP COLUMN legacy_notes;   -- should classify RED",
  );

  await client.end();
}

function redact(url: string): string {
  // Mask BOTH forms a password can take: the userinfo (user:pass@) AND a
  // password carried as a query parameter (?password=... / ?sslpassword=...).
  return url
    .replace(/(:\/\/[^:/@]+):[^@]*@/, "$1:***@")
    .replace(/([?&](?:password|sslpassword|passfile)=)[^&\s]*/gi, "$1***");
}

main().catch((err) => {
  console.error("✗ Seed failed:", err.message);
  process.exit(1);
});
