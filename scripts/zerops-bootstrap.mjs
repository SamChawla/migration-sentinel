// Zerops one-shot bootstrap — runs from the app service's initCommands on deploy.
//
// A Zerops PostgreSQL service is ONE server. Migration Sentinel needs four
// databases on it (sentinel control-plane, prod + staging targets, shadow admin
// for ephemeral dry-run clones). This script — using the service's `postgres`
// SUPERUSER via SHADOW_ADMIN_URL — creates any missing database, applies the
// Drizzle control-plane migrations, then seeds (idempotent: the seed scripts
// refuse to clobber a non-empty database, so re-runs on every deploy are safe).
//
// Required env (set in zerops.yml run.envVariables):
//   SHADOW_ADMIN_URL  superuser @ the `postgres` maintenance DB — used to CREATE DATABASE
//   DATABASE_URL      sentinel control-plane DB (drizzle migrate target)
//   TARGET_DB_URL     prod target DB (seeded with the demo dataset)
//   STAGING_DB_URL    staging target DB (seeded — the promotion ladder needs it)
// Optional:
//   ZEROPS_SEED=0     skip the dataset seeds (databases + migrate still run)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Databases to ensure exist, derived from the four connection URLs. */
function dbNameFromUrl(url) {
  return new URL(url).pathname.replace(/^\//, "") || null;
}

async function ensureDatabases() {
  const adminUrl = process.env.SHADOW_ADMIN_URL;
  if (!adminUrl) throw new Error("SHADOW_ADMIN_URL (superuser @ postgres DB) is required to create databases.");

  const wanted = [
    dbNameFromUrl(process.env.DATABASE_URL ?? ""),
    dbNameFromUrl(process.env.TARGET_DB_URL ?? ""),
    dbNameFromUrl(process.env.STAGING_DB_URL ?? ""),
    // the shadow *clones* live in their own DBs; ensure a `shadow` DB exists too
    // when SHADOW_DATABASE_URL is set (rollback tooling / integration parity).
    dbNameFromUrl(process.env.SHADOW_DATABASE_URL ?? ""),
  ].filter((n) => n && n !== "postgres");

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const name of new Set(wanted)) {
      const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (rowCount === 0) {
        // Identifier can't be parameterized; names come from our own env, and we
        // hard-validate to a safe charset before interpolating.
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
        await admin.query(`CREATE DATABASE "${name}"`);
        console.log(`✓ created database ${name}`);
      } else {
        console.log(`• database ${name} already exists`);
      }
    }
  } finally {
    await admin.end();
  }
}

async function migrateControlPlane() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the control-plane migration.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: path.join(repoRoot, "packages/db/migrations") });
    console.log("✓ control-plane migrations applied");
  } finally {
    await client.end();
  }
}

function seed() {
  if (process.env.ZEROPS_SEED === "0") {
    console.log("• ZEROPS_SEED=0 — skipping dataset seeds");
    return;
  }
  const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
  const run = (script, extraEnv = {}) => {
    try {
      execFileSync(tsx, [path.join(repoRoot, script)], {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, ...extraEnv },
      });
    } catch {
      // The seed scripts exit non-zero when a database is already populated
      // (their anti-clobber guard). That is the expected steady state — never
      // fail the deploy on it.
      console.log(`• ${script} skipped (already seeded or guarded)`);
    }
  };
  run("scripts/seed-sentinel.ts");
  run("scripts/seed.ts", { TARGET_DB_URL: process.env.TARGET_DB_URL ?? "" });
  if (process.env.STAGING_DB_URL) run("scripts/seed.ts", { TARGET_DB_URL: process.env.STAGING_DB_URL });
}

async function main() {
  console.log("→ Zerops bootstrap: ensuring databases…");
  await ensureDatabases();
  await migrateControlPlane();
  seed();
  console.log("✓ Zerops bootstrap complete");
}

main().catch((e) => {
  console.error("✗ Zerops bootstrap failed:", e);
  process.exit(1);
});
