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
//                     and to create/own the scoped app role below. Never handed to the
//                     app itself: DATABASE_URL/TARGET_DB_URL/STAGING_DB_URL connect as
//                     `sentinel_app` instead, so migration SQL can't reach past the
//                     three databases it owns (cluster state, other tenants' DBs, and
//                     the shadow admin DB stay out of reach).
//   APP_DB_PASSWORD   password bootstrap sets on the `sentinel_app` role
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

const APP_ROLE = "sentinel_app";

async function ensureDatabases() {
  const adminUrl = process.env.SHADOW_ADMIN_URL;
  if (!adminUrl) throw new Error("SHADOW_ADMIN_URL (superuser @ postgres DB) is required to create databases.");

  // Only sentinel/prod/staging are handed to the scoped `sentinel_app` role
  // (ensureAppRole below). The shadow DB stays superuser-only — clone
  // lifecycle needs cluster-wide CREATE/DROP.
  const scoped = [
    dbNameFromUrl(process.env.DATABASE_URL ?? ""),
    dbNameFromUrl(process.env.TARGET_DB_URL ?? ""),
    dbNameFromUrl(process.env.STAGING_DB_URL ?? ""),
  ].filter((n) => n && n !== "postgres");

  const wanted = [
    ...scoped,
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
    await ensureAppRole(admin, new Set(scoped));
  } finally {
    await admin.end();
  }
}

/**
 * Creates (or re-passwords) the `sentinel_app` login role and makes it owner
 * of sentinel/prod/staging only — never the shadow admin DB or the cluster at
 * large. On PG15+, owning a database also owns its `public` schema (via
 * `pg_database_owner`), so this is enough for drizzle migrate + the agent's
 * apply executor to have full DDL on exactly the three intended databases.
 */
async function ensureAppRole(admin, dbNames) {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) throw new Error("APP_DB_PASSWORD is required to create the scoped app role.");

  const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
  if (rowCount === 0) {
    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD $1`, [password]);
    console.log(`✓ created role ${APP_ROLE}`);
  } else {
    await admin.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD $1`, [password]);
  }

  for (const name of dbNames) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
    await admin.query(`ALTER DATABASE "${name}" OWNER TO ${APP_ROLE}`);
  }
  console.log(`✓ ${APP_ROLE} owns: ${[...dbNames].join(", ")}`);
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
    } catch (e) {
      if (e.status === 2) {
        // Exit code 2 is the seed scripts' dedicated anti-clobber guard
        // (database already populated) — the expected steady state.
        console.log(`• ${script} skipped (already seeded)`);
        return;
      }
      // Any other failure (bad creds, missing file, SQL error, ...) must fail
      // the deploy, not be silently treated as "already seeded".
      throw new Error(`${script} failed (exit ${e.status ?? "unknown"})`);
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
