/**
 * Live end-to-end smoke test of the integrated pipeline against the REAL DBs.
 *
 *   DATABASE_URL=... TARGET_DB_URL=... SHADOW_ADMIN_URL=... tsx scripts/smoke_live.ts
 *
 * Exercises: intake -> runAgentPipeline (dump target schema, shadow dry-run,
 * rollback proof, data pre-flight, Qodo, gate) -> guarded apply, for a safe,
 * a dangerous (DROP COLUMN), and a blocked (unbounded DELETE) migration.
 */
import { Client } from "pg";
import { createRequest, getRequest, getRequestTargetUrl } from "@sentinel/db/queries";
import { runAgentPipeline, applyMigration } from "@sentinel/agent";

// A fresh target alias with NO stored URL, so the SAME resolution
// (getRequestTargetUrl → TARGET_DB_URL) is used for analysis, apply, and
// cleanup — the analyzed database and the mutated database are provably one.
const SMOKE_TARGET = `smoke-target-${Date.now()}`;
// A unique column name per run keeps the smoke idempotent — the applied column
// never collides with a prior run, and it is dropped again in cleanup.
const SAFE_COL = `smoke_col_${Date.now()}`;

interface Expect {
  status?: string;
  severity?: string;
  typedConfirm?: boolean;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED — ${msg}`);
}

async function scenario(name: string, up: string, down: string, expect: Expect) {
  console.log(`\n=== ${name} ===`);
  const rec = await createRequest({ title: name, targetDb: SMOKE_TARGET, upSql: up, downSql: down });
  await runAgentPipeline(rec.id);
  const r = await getRequest(rec.id);
  console.log(
    `status=${r?.status} severity=${r?.overallSeverity} reversibility=${r?.reversibility} ` +
      `rollbackVerified=${r?.rollbackVerified} typedConfirm=${r?.approval.requiresTypedConfirm} ` +
      `expect="${r?.approval.expectedConfirm ?? ""}" qodo=${r?.qodoVerdict} preflight=${r?.preflight.length}`,
  );
  assert(r != null, `${name}: request not found after pipeline`);
  if (expect.status) assert(r!.status === expect.status, `${name}: status ${r!.status} !== ${expect.status}`);
  if (expect.severity)
    assert(r!.overallSeverity === expect.severity, `${name}: severity ${r!.overallSeverity} !== ${expect.severity}`);
  if (expect.typedConfirm !== undefined)
    assert(
      r!.approval.requiresTypedConfirm === expect.typedConfirm,
      `${name}: typedConfirm ${r!.approval.requiresTypedConfirm} !== ${expect.typedConfirm}`,
    );
  return rec.id;
}

async function main() {
  // 1) SAFE — additive nullable column (green, reversible) → should apply live.
  const safeId = await scenario(
    "smoke: add nullable column",
    `ALTER TABLE public.users ADD COLUMN ${SAFE_COL} text;`,
    `ALTER TABLE public.users DROP COLUMN ${SAFE_COL};`,
    { status: "awaiting_approval", severity: "green" },
  );

  // 2) DANGEROUS — drop a column (red, irreversible) → typed_confirm.
  await scenario(
    "smoke: drop legacy_notes",
    "ALTER TABLE public.users DROP COLUMN legacy_notes;",
    "ALTER TABLE public.users ADD COLUMN legacy_notes text;",
    { status: "awaiting_approval", severity: "red", typedConfirm: true },
  );

  // 3) BLOCKED — unbounded delete (whole-dataset destruction).
  await scenario(
    "smoke: unbounded delete",
    "DELETE FROM public.orders;",
    "-- no rollback",
    { status: "blocked", severity: "red" },
  );

  // Apply the safe one through the guarded executor (requires approval first).
  console.log("\n=== guarded apply (safe) ===");
  const { recordApproval } = await import("@sentinel/db/queries");
  await recordApproval({ requestId: safeId, decision: "approved", approver: "smoke" });
  const result = await applyMigration(safeId);
  console.log(`apply result: ${result.status}`);
  console.log(result.logs);
  assert(result.status === "applied", `guarded apply expected 'applied', got '${result.status}'`);

  // Cleanup — connect to the SAME target the apply resolved (not a separate env
  // read), so we drop the column from the database that was actually mutated.
  const cleanupUrl = await getRequestTargetUrl(safeId);
  const t = new Client({ connectionString: cleanupUrl! });
  await t.connect();
  await t.query(`ALTER TABLE public.users DROP COLUMN IF EXISTS ${SAFE_COL}`);
  await t.end();
  console.log(`cleanup — dropped ${SAFE_COL}`);

  console.log("\n✓ All smoke assertions passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
