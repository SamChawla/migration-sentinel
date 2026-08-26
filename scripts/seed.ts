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

  const sql = await readFile(SCHEMA_FILE, "utf8");
  console.log("→ Loading fixtures/target_schema.sql (drops & recreates public schema)…");
  const started = Date.now();
  await client.query(sql);
  const ms = Date.now() - started;

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
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

main().catch((err) => {
  console.error("✗ Seed failed:", err.message);
  process.exit(1);
});
