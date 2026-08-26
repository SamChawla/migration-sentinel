/**
 * Live end-to-end smoke test of the integrated pipeline against the REAL DBs.
 *
 *   DATABASE_URL=... TARGET_DB_URL=... SHADOW_ADMIN_URL=... tsx scripts/smoke_live.ts
 *
 * Exercises: intake -> runAgentPipeline (dump target schema, shadow dry-run,
 * rollback proof, data pre-flight, Qodo, gate) -> guarded apply, for a safe,
 * a dangerous (DROP COLUMN), and a blocked (unbounded DELETE) migration.
 */
import { createRequest, getRequest } from "@sentinel/db/queries";
import { runAgentPipeline, applyMigration } from "@sentinel/agent";

const TARGET = process.env.TARGET_DB_URL!;

async function scenario(name: string, up: string, down: string) {
  console.log(`\n=== ${name} ===`);
  const rec = await createRequest({ title: name, targetDb: "prod-orders-db", upSql: up, downSql: down });
  await runAgentPipeline(rec.id, { targetUrl: TARGET });
  const r = await getRequest(rec.id);
  console.log(
    `status=${r?.status} severity=${r?.overallSeverity} reversibility=${r?.reversibility} ` +
      `rollbackVerified=${r?.rollbackVerified} typedConfirm=${r?.approval.requiresTypedConfirm} ` +
      `expect="${r?.approval.expectedConfirm ?? ""}" qodo=${r?.qodoVerdict} preflight=${r?.preflight.length}`,
  );
  return rec.id;
}

async function main() {
  // 1) SAFE — additive nullable column (green, reversible) → should apply live.
  const safeId = await scenario(
    "smoke: add nullable column",
    "ALTER TABLE public.users ADD COLUMN nickname text;",
    "ALTER TABLE public.users DROP COLUMN nickname;",
  );

  // 2) DANGEROUS — drop a column (red, irreversible) → typed_confirm.
  await scenario(
    "smoke: drop legacy_notes",
    "ALTER TABLE public.users DROP COLUMN legacy_notes;",
    "ALTER TABLE public.users ADD COLUMN legacy_notes text;",
  );

  // 3) BLOCKED — unbounded delete (whole-dataset destruction).
  await scenario(
    "smoke: unbounded delete",
    "DELETE FROM public.orders;",
    "-- no rollback",
  );

  // Apply the safe one through the guarded executor (requires approval first).
  console.log("\n=== guarded apply (safe) ===");
  const { recordApproval } = await import("@sentinel/db/queries");
  await recordApproval({ requestId: safeId, decision: "approved", approver: "smoke" });
  const result = await applyMigration(safeId, { targetUrl: TARGET });
  console.log(`apply result: ${result.status}`);
  console.log(result.logs);

  process.exit(0);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
