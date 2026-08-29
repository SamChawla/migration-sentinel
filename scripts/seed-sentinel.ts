/**
 * Seed the SENTINEL control-plane database with demo migration records.
 *
 *   pnpm tsx scripts/seed-sentinel.ts
 *
 * Uses DATABASE_URL from .env (default: postgres://postgres:postgres@localhost:5435/sentinel).
 * Runs AFTER drizzle-kit migrate has applied the schema.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import {
  targetDatabase,
  migrationRequest,
  generatedArtifact,
  qodoReview,
  shadowRun,
  blastReport,
  blastFinding,
  preflightResult,
  approval,
  applyRun,
  auditEvent,
  githubLink,
} from "../packages/db/src/schema.js";
import { loadDotenv } from "./load-env.js";

loadDotenv();

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5435/sentinel";

/** Thrown INSIDE the seed transaction when the control plane already has data and
 *  --reset was not passed. Throwing rolls the transaction back (nothing wiped). */
class SeedGuardError extends Error {
  constructor(public readonly count: number) {
    super(`sentinel-db already has ${count} control-plane row(s); pass --reset to wipe.`);
    this.name = "SeedGuardError";
  }
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  console.log(`→ Connected to sentinel-db: ${redact(DATABASE_URL)}`);

  // Guard: this seeder WIPES the control plane. Refuse to run against a DB that
  // already has data unless --reset is passed explicitly.
  const RESET = process.argv.includes("--reset");

  // Everything below runs in ONE transaction — a mid-seed failure never leaves
  // the control plane half-cleared or half-populated.
  await db.transaction(async (tx) => {
  // The occupancy check runs INSIDE this transaction, AFTER locking every table
  // it may wipe. Otherwise (a) checking only migration_request would let it
  // silently delete independent target/audit rows, and (b) a request committed
  // between an outside-the-tx count and the deletes would be destroyed even
  // without --reset. The ACCESS EXCLUSIVE lock blocks concurrent intake until we
  // commit or roll back, so the check + deletes are atomic and race-free.
  await tx.execute(sql`LOCK TABLE migration_request, target_database, audit_event IN ACCESS EXCLUSIVE MODE`);
  const occ = await tx.execute(
    sql`SELECT (SELECT count(*) FROM migration_request)
             + (SELECT count(*) FROM target_database)
             + (SELECT count(*) FROM audit_event) AS n`,
  );
  const existingRows = Number((occ.rows?.[0] as { n?: number | string } | undefined)?.n ?? 0);
  if (existingRows > 0 && !RESET) {
    // Throwing rolls the transaction back (no deletes) and releases the lock.
    throw new SeedGuardError(existingRows);
  }

  // Clear existing data (idempotent re-seed)
  console.log("→ Clearing existing demo data…");
  await tx.delete(githubLink);
  await tx.delete(auditEvent);
  await tx.delete(approval);
  await tx.delete(preflightResult);
  await tx.delete(blastFinding);
  await tx.delete(blastReport);
  await tx.delete(qodoReview);
  await tx.delete(shadowRun);
  await tx.delete(generatedArtifact);
  await tx.delete(migrationRequest);
  await tx.delete(targetDatabase);

  // ── Target databases ──────────────────────────────────────────────────
  console.log("→ Inserting target databases…");
  const [prodTarget] = await tx.insert(targetDatabase).values({
    name: "Production Orders DB",
    engine: "postgres",
    connectionAlias: "prod-orders-db",
    environment: "prod",
    connectionUrl: process.env.TARGET_DB_URL ?? "postgres://postgres:postgres@localhost:5433/prod",
  }).returning();

  const [stagingTarget] = await tx.insert(targetDatabase).values({
    name: "Staging Orders DB",
    engine: "postgres",
    connectionAlias: "staging-orders-db",
    environment: "staging",
    // Give staging its OWN URL — without it, resolution falls back to
    // TARGET_DB_URL (production), so a "staging" migration could hit prod.
    connectionUrl: process.env.STAGING_DB_URL ?? "postgres://postgres:postgres@localhost:5436/staging",
  }).returning();

  // ── Helper to make timestamps ─────────────────────────────────────────
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  // ── Migration 1: Drop legacy_notes (RED, awaiting_approval) ───────────
  console.log("→ Seeding migration: Drop legacy_notes…");
  const [req1] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "ALTER TABLE public.users DROP COLUMN legacy_notes;" },
    title: "Drop legacy_notes from users",
    status: "awaiting_approval",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  }).returning();

  const [art1] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req1.id,
    version: 1,
    upSql: "ALTER TABLE public.users DROP COLUMN legacy_notes;",
    downSql: "-- NO CLEAN ROLLBACK\nALTER TABLE public.users ADD COLUMN legacy_notes text;\n-- data NOT restored",
    reversibility: "irreversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(1),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art1.id,
    verdict: "passed_with_warnings",
    summary: "Migration syntax is valid. Consider a two-phase drop.",
    findings: ["Consider a two-phase drop (stop writing, then drop next release)."],
  });

  const [shadow1] = await tx.insert(shadowRun).values({
    migrationRequestId: req1.id,
    generatedArtifactId: art1.id,
    status: "succeeded",
    rollbackVerified: false,
    startedAt: hoursAgo(1),
    finishedAt: hoursAgo(0.95),
    createdAt: hoursAgo(1),
  }).returning();

  const [blast1] = await tx.insert(blastReport).values({
    shadowRunId: shadow1.id,
    overallSeverity: "red",
    totalRowsAffected: 1204338,
    estLockMs: 14000,
    tablesTouched: ["public.users"],
    createdAt: hoursAgo(1),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast1.id,
    statementIndex: 0,
    statementSql: "ALTER TABLE users DROP COLUMN legacy_notes",
    severity: "red",
    lockType: "AccessExclusiveLock",
    note: "Drops a column — data unrecoverable.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req1.id,
    decision: "pending",
    requiresTypedConfirm: true,
    expectedConfirmValue: "users",
    createdAt: hoursAgo(1),
  });

  // ── Migration 2: Add last_login_at — a full promotion group ───────────
  // Staging sibling APPLIED first, then the prod run awaiting approval with
  // the SAME SQL in the SAME promotion group → the prod rail is UNLOCKED
  // (promotionEligible passes). Migration 1 above has no lower-env sibling,
  // so its prod rail stays LOCKED — the demo shows both states side by side.
  console.log("→ Seeding migration: Add last_login_at (staging applied → prod awaiting)…");
  const promoGroup2 = crypto.randomUUID();
  const LOGIN_UP = "ALTER TABLE public.users ADD COLUMN last_login_at timestamptz;";
  const LOGIN_DOWN = "ALTER TABLE public.users DROP COLUMN last_login_at;";

  const [req2s] = await tx.insert(migrationRequest).values({
    targetDatabaseId: stagingTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: LOGIN_UP },
    title: "Add last_login_at to users",
    status: "applied",
    requestedBy: "dev@acme.io",
    promotionGroupId: promoGroup2,
    createdAt: hoursAgo(6),
    updatedAt: hoursAgo(5.5),
  }).returning();

  const [art2s] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req2s.id,
    version: 1,
    upSql: LOGIN_UP,
    downSql: LOGIN_DOWN,
    reversibility: "reversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(6),
  }).returning();

  const [shadow2s] = await tx.insert(shadowRun).values({
    migrationRequestId: req2s.id,
    generatedArtifactId: art2s.id,
    status: "succeeded",
    rollbackVerified: true,
    createdAt: hoursAgo(6),
  }).returning();

  const [blast2s] = await tx.insert(blastReport).values({
    shadowRunId: shadow2s.id,
    overallSeverity: "green",
    totalRowsAffected: 0,
    estLockMs: 4,
    tablesTouched: ["public.users"],
    createdAt: hoursAgo(6),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast2s.id,
    statementIndex: 0,
    statementSql: "ALTER TABLE users ADD COLUMN last_login_at timestamptz",
    severity: "green",
    note: "Metadata-only in Postgres 11+.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req2s.id,
    decision: "approved",
    approver: "sam.chawla26@gmail.com",
    decidedAt: hoursAgo(5.5),
    createdAt: hoursAgo(6),
  });

  await tx.insert(applyRun).values({
    migrationRequestId: req2s.id,
    status: "succeeded",
    lockTimeoutMs: 3000,
    statementTimeoutMs: 30000,
    rollbackAvailable: true,
    appliedAt: hoursAgo(5.5),
    logs: "SET lock_timeout=3000ms statement_timeout=30000ms | BEGIN | COMMIT — migration applied.",
    createdAt: hoursAgo(5.5),
  });

  const [req2] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: LOGIN_UP },
    title: "Add last_login_at to users",
    status: "awaiting_approval",
    requestedBy: "dev@acme.io",
    promotionGroupId: promoGroup2,
    promotedFromRequestId: req2s.id,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
  }).returning();

  const [art2] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req2.id,
    version: 1,
    upSql: "ALTER TABLE public.users ADD COLUMN last_login_at timestamptz;",
    downSql: "ALTER TABLE public.users DROP COLUMN last_login_at;",
    reversibility: "reversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(2),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art2.id,
    verdict: "passed",
    findings: [],
  });

  const [shadow2] = await tx.insert(shadowRun).values({
    migrationRequestId: req2.id,
    generatedArtifactId: art2.id,
    status: "succeeded",
    rollbackVerified: true,
    startedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.95),
    createdAt: hoursAgo(2),
  }).returning();

  const [blast2] = await tx.insert(blastReport).values({
    shadowRunId: shadow2.id,
    overallSeverity: "green",
    totalRowsAffected: 0,
    estLockMs: 5,
    tablesTouched: ["public.users"],
    createdAt: hoursAgo(2),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast2.id,
    statementIndex: 0,
    statementSql: "ALTER TABLE users ADD COLUMN last_login_at timestamptz",
    severity: "green",
    note: "Metadata-only in Postgres 11+.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req2.id,
    decision: "pending",
    requiresTypedConfirm: false,
    createdAt: hoursAgo(2),
  });

  // ── Migration 3: Index orders(created_at) — APPLIED ───────────────────
  console.log("→ Seeding migration: Index orders(created_at)…");
  const [req3] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "CREATE INDEX CONCURRENTLY idx_orders_created_at ON public.orders (created_at);" },
    title: "Index orders(created_at) CONCURRENTLY",
    status: "applied",
    requestedBy: "priya@acme.io",
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(25.5),
  }).returning();

  const [art3] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req3.id,
    version: 1,
    upSql: "CREATE INDEX CONCURRENTLY idx_orders_created_at ON public.orders (created_at);",
    downSql: "DROP INDEX CONCURRENTLY IF EXISTS idx_orders_created_at;",
    reversibility: "reversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(26),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art3.id,
    verdict: "passed",
    findings: [],
  });

  const [shadow3] = await tx.insert(shadowRun).values({
    migrationRequestId: req3.id,
    generatedArtifactId: art3.id,
    status: "succeeded",
    rollbackVerified: true,
    createdAt: hoursAgo(26),
  }).returning();

  const [blast3] = await tx.insert(blastReport).values({
    shadowRunId: shadow3.id,
    overallSeverity: "green",
    totalRowsAffected: 0,
    estLockMs: 12,
    tablesTouched: ["public.orders"],
    createdAt: hoursAgo(26),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast3.id,
    statementIndex: 0,
    statementSql: "CREATE INDEX CONCURRENTLY",
    severity: "green",
    note: "Non-blocking index build.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req3.id,
    decision: "approved",
    approver: "sam.chawla26@gmail.com",
    decidedAt: hoursAgo(25.5),
    createdAt: hoursAgo(26),
  });

  // An APPLIED request has an apply_run — the execution record the guarded
  // executor writes (status, timeouts, logs, applied_at). Seeding 'applied'
  // without it misrepresents a completed apply.
  await tx.insert(applyRun).values({
    migrationRequestId: req3.id,
    status: "succeeded",
    lockTimeoutMs: 3000,
    statementTimeoutMs: 30000,
    rollbackAvailable: true,
    appliedAt: hoursAgo(25.5),
    logs: "SET lock_timeout=3000ms statement_timeout=30000ms | APPLIED (autocommit) — 1/1 statement(s) committed individually (CREATE INDEX CONCURRENTLY).",
    createdAt: hoursAgo(25.5),
  });

  // ── Migration 4: SET NOT NULL — APPLIED ───────────────────────────────
  console.log("→ Seeding migration: Backfill + SET NOT NULL…");
  const [req4] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "UPDATE public.users SET full_name = 'unknown' WHERE full_name IS NULL;\nALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;" },
    title: "Backfill full_name and SET NOT NULL",
    status: "applied",
    requestedBy: "wei@acme.io",
    createdAt: hoursAgo(49),
    updatedAt: hoursAgo(48),
  }).returning();

  const [art4] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req4.id,
    version: 1,
    upSql: "UPDATE public.users SET full_name = 'unknown' WHERE full_name IS NULL;\nALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;",
    downSql: "ALTER TABLE public.users ALTER COLUMN full_name DROP NOT NULL;",
    // LOSSY, not reversible: the down restores the SCHEMA (drops NOT NULL) but the
    // backfill overwrote every NULL full_name with 'unknown' and no down can
    // recover which rows were originally NULL. Seeding it 'reversible' would make
    // the approval UI claim a data-rollback guarantee this artifact can't honour.
    reversibility: "lossy",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(49),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art4.id,
    verdict: "passed_with_warnings",
    findings: ["Prefer NOT VALID → VALIDATE for very large tables."],
  });

  const [shadow4] = await tx.insert(shadowRun).values({
    migrationRequestId: req4.id,
    generatedArtifactId: art4.id,
    status: "succeeded",
    // Schema rolled back on the shadow, but the migration is data-mutating, so the
    // honest verdict is rollbackVerified=false (schemaRestored AND !dataMutating).
    rollbackVerified: false,
    createdAt: hoursAgo(49),
  }).returning();

  const [blast4] = await tx.insert(blastReport).values({
    shadowRunId: shadow4.id,
    overallSeverity: "amber",
    totalRowsAffected: 33121,
    estLockMs: 800,
    tablesTouched: ["public.users"],
    createdAt: hoursAgo(49),
  }).returning();

  await tx.insert(blastFinding).values([
    {
      blastReportId: blast4.id,
      statementIndex: 0,
      statementSql: "UPDATE … WHERE full_name IS NULL",
      severity: "amber",
      note: "Bounded backfill of 33k rows before constraint.",
    },
    {
      blastReportId: blast4.id,
      statementIndex: 1,
      statementSql: "SET NOT NULL",
      severity: "amber",
      lockType: "AccessExclusiveLock",
      note: "Brief exclusive lock; pre-flight verified 0 violations.",
    },
  ]);

  await tx.insert(preflightResult).values({
    shadowRunId: shadow4.id,
    kind: "not_null",
    tableName: "public.users",
    probeSql: "SELECT count(*) AS violations FROM public.users WHERE full_name IS NULL",
    violations: 0,
    willFail: false,
    description: "Rows where full_name IS NULL will block SET NOT NULL — backfill completed.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req4.id,
    decision: "approved",
    approver: "sam.chawla26@gmail.com",
    decidedAt: hoursAgo(48),
    createdAt: hoursAgo(49),
  });

  // Execution record for the applied backfill (data-mutating → rollback not
  // available, matching the artifact's lossy reversibility).
  await tx.insert(applyRun).values({
    migrationRequestId: req4.id,
    status: "succeeded",
    lockTimeoutMs: 3000,
    statementTimeoutMs: 30000,
    rollbackAvailable: false,
    appliedAt: hoursAgo(48),
    logs: "SET lock_timeout=3000ms statement_timeout=30000ms | BEGIN | COMMIT — migration applied (33,121 rows affected).",
    createdAt: hoursAgo(48),
  });

  // ── Migration 5: Unbounded UPDATE — REJECTED ──────────────────────────
  console.log("→ Seeding migration: Deactivate all users (rejected)…");
  const [req5] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "UPDATE public.users SET is_active = false;" },
    title: "Deactivate all users (unbounded UPDATE)",
    status: "rejected",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(72),
    updatedAt: hoursAgo(71),
  }).returning();

  const [art5] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req5.id,
    version: 1,
    upSql: "UPDATE public.users SET is_active = false;",
    downSql: "-- cannot restore previous per-row values",
    reversibility: "irreversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(72),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art5.id,
    verdict: "failed",
    findings: ["Unbounded UPDATE with no WHERE clause.", "No reversible down migration possible."],
  });

  const [shadow5] = await tx.insert(shadowRun).values({
    migrationRequestId: req5.id,
    generatedArtifactId: art5.id,
    status: "succeeded",
    rollbackVerified: false,
    createdAt: hoursAgo(72),
  }).returning();

  const [blast5] = await tx.insert(blastReport).values({
    shadowRunId: shadow5.id,
    overallSeverity: "red",
    totalRowsAffected: 50000,
    estLockMs: 22000,
    tablesTouched: ["public.users"],
    createdAt: hoursAgo(72),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast5.id,
    statementIndex: 0,
    statementSql: "UPDATE public.users SET is_active = false",
    severity: "red",
    note: "Unbounded UPDATE — no WHERE clause; prior values unrecoverable.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req5.id,
    decision: "rejected",
    approver: "sam.chawla26@gmail.com",
    requiresTypedConfirm: true,
    expectedConfirmValue: "users",
    decidedAt: hoursAgo(71),
    createdAt: hoursAgo(72),
  });

  // ── Migration 6: Widen amount — DRY_RUNNING ───────────────────────────
  console.log("→ Seeding migration: Widen orders.amount…");
  const [req6] = await tx.insert(migrationRequest).values({
    targetDatabaseId: stagingTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "ALTER TABLE public.orders ALTER COLUMN amount_cents TYPE bigint;" },
    title: "Widen orders.amount_cents to bigint",
    status: "dry_running",
    requestedBy: "priya@acme.io",
    createdAt: hoursAgo(0.4),
    updatedAt: hoursAgo(0.4),
  }).returning();

  const [art6] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req6.id,
    version: 1,
    upSql: "ALTER TABLE public.orders ALTER COLUMN amount_cents TYPE bigint;",
    downSql: "ALTER TABLE public.orders ALTER COLUMN amount_cents TYPE integer;",
    // A column type change is LOSSY per the classifier (a narrowing down migration
    // can truncate/round). Seed it 'lossy' to match — 'reversible' would mislead.
    reversibility: "lossy",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(0.4),
  }).returning();

  // A dry_running request has a shadow_run in progress (started, not finished) —
  // otherwise hydration renders fabricated green/rollbackVerified=false defaults.
  await tx.insert(shadowRun).values({
    migrationRequestId: req6.id,
    generatedArtifactId: art6.id,
    status: "running",
    startedAt: hoursAgo(0.4),
    createdAt: hoursAgo(0.4),
  });

  await tx.insert(approval).values({
    migrationRequestId: req6.id,
    decision: "pending",
    requiresTypedConfirm: false,
    createdAt: hoursAgo(0.4),
  });

  // ── Migration 7: Unbounded DELETE — BLOCKED (Sentinel refuses) ────────
  console.log("→ Seeding migration: Purge all orders (blocked)…");
  const [req7] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: "DELETE FROM public.orders;" },
    title: "Purge all orders (unbounded DELETE)",
    status: "blocked",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(0.2),
    updatedAt: hoursAgo(0.2),
  }).returning();

  const [art7] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req7.id,
    version: 1,
    upSql: "DELETE FROM public.orders;",
    downSql: "-- NO ROLLBACK: every row is destroyed; prior values are unrecoverable.",
    reversibility: "irreversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(0.2),
  }).returning();

  await tx.insert(qodoReview).values({
    generatedArtifactId: art7.id,
    verdict: "failed",
    summary: "Whole-table DELETE with no WHERE clause and no recoverable rollback.",
    findings: ["Unbounded DELETE — every row destroyed.", "No reversible down migration is possible."],
  });

  const [shadow7] = await tx.insert(shadowRun).values({
    migrationRequestId: req7.id,
    generatedArtifactId: art7.id,
    status: "succeeded",
    rollbackVerified: false,
    createdAt: hoursAgo(0.2),
  }).returning();

  const [blast7] = await tx.insert(blastReport).values({
    shadowRunId: shadow7.id,
    overallSeverity: "red",
    totalRowsAffected: 842197,
    estLockMs: 61000,
    tablesTouched: ["public.orders"],
    createdAt: hoursAgo(0.2),
  }).returning();

  await tx.insert(blastFinding).values({
    blastReportId: blast7.id,
    statementIndex: 0,
    statementSql: "DELETE FROM public.orders",
    severity: "red",
    lockType: "RowExclusiveLock",
    note: "Unbounded DELETE — whole-dataset destruction with no recovery path. BLOCKED.",
  });

  await tx.insert(approval).values({
    migrationRequestId: req7.id,
    decision: "pending",
    requiresTypedConfirm: false,
    createdAt: hoursAgo(0.2),
  });

  // ── Migration 8: exported prod request — AWAITING_MERGE (PR4 demo) ────
  // The two-gate flow frozen at gate 2: staging applied (rail unlocked), prod
  // approved, export PR open on the scratch repo. Demoable with GitHub down —
  // Apply stays locked on the cached "open" state, and the live re-verify in
  // the apply route honestly refuses.
  console.log("→ Seeding migration: Index orders(status) (awaiting_merge)…");
  const promoGroup8 = crypto.randomUUID();
  const STATUS_UP = "CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status);";
  const STATUS_DOWN = "DROP INDEX CONCURRENTLY IF EXISTS idx_orders_status;";

  const [req8s] = await tx.insert(migrationRequest).values({
    targetDatabaseId: stagingTarget.id,
    intakeKind: "raw_sql",
    intakePayload: { sql: STATUS_UP },
    title: "Index orders(status) CONCURRENTLY",
    status: "applied",
    requestedBy: "priya@acme.io",
    promotionGroupId: promoGroup8,
    createdAt: hoursAgo(9),
    updatedAt: hoursAgo(8.5),
  }).returning();

  const [art8s] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req8s.id,
    version: 1,
    upSql: STATUS_UP,
    downSql: STATUS_DOWN,
    reversibility: "reversible",
    model: "claude-sonnet-4-20250514",
    createdAt: hoursAgo(9),
  }).returning();

  await tx.insert(shadowRun).values({
    migrationRequestId: req8s.id,
    generatedArtifactId: art8s.id,
    status: "succeeded",
    rollbackVerified: true,
    createdAt: hoursAgo(9),
  });
  await tx.insert(approval).values({
    migrationRequestId: req8s.id,
    decision: "approved",
    approver: "sam.chawla26@gmail.com",
    decidedAt: hoursAgo(8.5),
    createdAt: hoursAgo(9),
  });
  await tx.insert(applyRun).values({
    migrationRequestId: req8s.id,
    status: "succeeded",
    lockTimeoutMs: 3000,
    statementTimeoutMs: 30000,
    rollbackAvailable: true,
    appliedAt: hoursAgo(8.5),
    logs: "SET lock_timeout=3000ms statement_timeout=30000ms | APPLIED (autocommit) — 1/1 statement(s).",
    createdAt: hoursAgo(8.5),
  });

  const [req8] = await tx.insert(migrationRequest).values({
    targetDatabaseId: prodTarget.id,
    intakeKind: "github_pr",
    intakePayload: {
      sql: STATUS_UP,
      pr: {
        url: "https://github.com/SamChawla/sentinel-demo-app/pull/3",
        repo: "SamChawla/sentinel-demo-app",
        file: "migrations/0004_idx_orders_status.sql",
        prNumber: 3,
        headSha: "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed",
      },
    },
    title: "Index orders(status) CONCURRENTLY",
    status: "awaiting_merge",
    requestedBy: "priya@acme.io",
    promotionGroupId: promoGroup8,
    promotedFromRequestId: req8s.id,
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(2.5),
  }).returning();

  const [art8] = await tx.insert(generatedArtifact).values({
    migrationRequestId: req8.id,
    version: 1,
    upSql: STATUS_UP,
    downSql: STATUS_DOWN,
    reversibility: "reversible",
    model: "github-pr",
    createdAt: hoursAgo(3),
  }).returning();

  const [shadow8] = await tx.insert(shadowRun).values({
    migrationRequestId: req8.id,
    generatedArtifactId: art8.id,
    status: "succeeded",
    rollbackVerified: true,
    createdAt: hoursAgo(3),
  }).returning();
  const [blast8] = await tx.insert(blastReport).values({
    shadowRunId: shadow8.id,
    overallSeverity: "green",
    totalRowsAffected: 0,
    estLockMs: 10,
    tablesTouched: ["public.orders"],
    createdAt: hoursAgo(3),
  }).returning();
  await tx.insert(blastFinding).values({
    blastReportId: blast8.id,
    statementIndex: 0,
    statementSql: "CREATE INDEX CONCURRENTLY",
    severity: "green",
    note: "Non-blocking index build.",
  });
  await tx.insert(qodoReview).values({
    generatedArtifactId: art8.id,
    verdict: "passed",
    findings: [],
  });
  await tx.insert(approval).values({
    migrationRequestId: req8.id,
    decision: "approved",
    approver: "sam.chawla26@gmail.com",
    decidedAt: hoursAgo(2.5),
    createdAt: hoursAgo(3),
  });
  await tx.insert(githubLink).values({
    migrationRequestId: req8.id,
    repo: "SamChawla/sentinel-demo-app",
    prNumber: 3,
    commitSha: "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed",
    filePath: "migrations/0004_idx_orders_status.sql",
    prTitle: "Add status index for order dashboards",
    prState: "open",
    headSha: "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed",
    checksState: "success",
    htmlUrl: "https://github.com/SamChawla/sentinel-demo-app/pull/3",
    lastSyncedAt: hoursAgo(2.5),
    exportBranch: "sentinel/migration-" + req8.id.replace(/-/g, "").slice(0, 8),
    exportPrNumber: 4,
    exportPrUrl: "https://github.com/SamChawla/sentinel-demo-app/pull/4",
    exportPrState: "open",
    createdAt: hoursAgo(3),
  });

  // ── Audit events ──────────────────────────────────────────────────────
  console.log("→ Seeding audit events…");
  await tx.insert(auditEvent).values([
    { migrationRequestId: req6.id, actor: "agent", action: "shadow.dry_run.started", detail: "Shadow provisioned; running up→down on schema-only clone.", tone: "info" as const, createdAt: hoursAgo(0.4) },
    { migrationRequestId: req1.id, actor: "agent", action: "gate.paused", detail: "RED verdict — irreversible DROP COLUMN. Awaiting human approval (typed confirm required).", tone: "red" as const, createdAt: hoursAgo(1) },
    { migrationRequestId: req2.id, actor: "agent", action: "gate.paused", detail: "GREEN verdict — rollback proven on shadow. Awaiting approval.", tone: "info" as const, createdAt: hoursAgo(2) },
    { migrationRequestId: req2.id, actor: "dev@acme.io", action: "request.promoted", detail: "Promoted from staging (staging-orders-db) to prod (prod-orders-db) — staging run applied, prod rail unlocked.", tone: "info" as const, createdAt: hoursAgo(2) },
    { migrationRequestId: req2s.id, actor: "sam.chawla26@gmail.com", action: "apply.succeeded", detail: "Applied on staging — metadata-only column add.", tone: "green" as const, createdAt: hoursAgo(5.5) },
    { migrationRequestId: req3.id, actor: "sam.chawla26@gmail.com", action: "apply.succeeded", detail: "Applied with lock_timeout=2s in 480 ms. Audit row written.", tone: "green" as const, createdAt: hoursAgo(25.5) },
    { migrationRequestId: req3.id, actor: "sam.chawla26@gmail.com", action: "approval.approved", detail: "Approved — non-blocking CONCURRENTLY build.", tone: "green" as const, createdAt: hoursAgo(26) },
    { migrationRequestId: req4.id, actor: "sam.chawla26@gmail.com", action: "apply.succeeded", detail: "Backfill (33,121 rows) + SET NOT NULL applied; pre-flight re-probe showed 0 violations.", tone: "green" as const, createdAt: hoursAgo(48) },
    { migrationRequestId: req4.id, actor: "agent", action: "preflight.blocked_then_fixed", detail: "33,121 NULL rows would fail SET NOT NULL — backfill value requested and two-phase migration regenerated.", tone: "info" as const, createdAt: hoursAgo(49) },
    { migrationRequestId: req5.id, actor: "sam.chawla26@gmail.com", action: "approval.rejected", detail: "Rejected — unbounded UPDATE, prior values unrecoverable.", tone: "red" as const, createdAt: hoursAgo(71) },
    { migrationRequestId: req5.id, actor: "agent", action: "gate.paused", detail: "RED verdict — data-mutating statement with no rollback.", tone: "red" as const, createdAt: hoursAgo(72) },
    { migrationRequestId: req7.id, actor: "agent", action: "gate.blocked", detail: "BLOCKED — unbounded DELETE destroys the whole table with no recovery path. Sentinel refuses to apply; approval cannot override.", tone: "red" as const, createdAt: hoursAgo(0.2) },
    { migrationRequestId: req8.id, actor: "sam.chawla26@gmail.com", action: "approval.approved", detail: "Approved — handing to the export gate (prod + linked repo).", tone: "green" as const, createdAt: hoursAgo(2.5) },
    { migrationRequestId: req8.id, actor: "sentinel.gate", action: "export.pr_opened", detail: "Exported to SamChawla/sentinel-demo-app#4 — awaiting the source-of-truth merge (gate 2). No apply has run.", tone: "info" as const, createdAt: hoursAgo(2.5) },
  ]);

  // ── Summary ───────────────────────────────────────────────────────────
  const reqCount = await tx.select({ count: sql<number>`count(*)::int` }).from(migrationRequest);
  const evCount = await tx.select({ count: sql<number>`count(*)::int` }).from(auditEvent);

  console.log(`\n✓ Sentinel DB seeded successfully`);
  console.log(`  migration_request: ${reqCount[0].count}`);
  console.log(`  audit_event:       ${evCount[0].count}`);
  });

  await pool.end();
}

function redact(url: string): string {
  // Mask BOTH forms a password can take: the userinfo (user:pass@) AND a
  // password carried as a query parameter (?password=... / ?sslpassword=...).
  return url
    .replace(/(:\/\/[^:/@]+):[^@]*@/, "$1:***@")
    .replace(/([?&](?:password|sslpassword|passfile)=)[^&\s]*/gi, "$1***");
}

main().catch((err) => {
  if (err instanceof SeedGuardError) {
    console.error(
      `✗ Refusing to seed: sentinel-db already holds ${err.count} control-plane row(s) ` +
        `(migration requests / target registrations / audit events). ` +
        `Re-run with --reset to wipe and reseed the demo data.`,
    );
    process.exit(1);
  }
  console.error("✗ Seed failed:", err.message);
  process.exit(1);
});
