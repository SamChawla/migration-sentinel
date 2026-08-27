/**
 * The safety pipeline: given a generated {up, down}, produce the full report a
 * human needs at the gate. This part needs NO TrueForge and NO model — it's the
 * deterministic core (classifier + shadow dry-run + rollback proof + Qodo), so
 * it's independently testable and reliable.
 *
 * The agent (agent.ts) calls generate → runSafetyPipeline → open gate.
 */
import { Client } from "pg";
import {
  classifyMigration,
  provisionShadow,
  verifyRollback,
  runPreflight,
  type MigrationClassification,
  type RollbackResult,
  type PreflightResult,
} from "@sentinel/shadow";
import { reviewMigration, type QodoReviewResult } from "@sentinel/qodo";
import { gateDisposition, type GateDisposition } from "@sentinel/core";

export interface SafetyReport {
  classification: MigrationClassification;
  rollback: RollbackResult;
  qodo: QodoReviewResult;
  /** data pre-flight probes run read-only against the target (ADR-011) */
  preflight: PreflightResult[];
  /** any data-dependent check that would fail on current data */
  willFailOnData: boolean;
  /** a required data probe could not be evaluated (no probe / timed out) */
  dataUnknown: boolean;
  /** the deterministic gate policy decision (ADR-004) */
  disposition: GateDisposition;
  /** true when Sentinel refuses to apply this at all (whole-dataset destruction) */
  blocked: boolean;
  /** true when a human must type a confirmation (irreversible but recoverable) */
  requiresTypedConfirm: boolean;
}

export interface SafetyPipelineInput {
  up: string;
  down: string;
  /** DDL that recreates the target schema on the shadow (schema-only). */
  schemaSql: string;
  adminUrl: string; // SHADOW_ADMIN_URL
  /** a READ-ONLY client on the target, for exact data pre-flight probes.
   *  Omit to skip data checks (e.g. no target available in a unit run). */
  targetReadOnly?: Client;
}

export async function runSafetyPipeline(input: SafetyPipelineInput): Promise<SafetyReport> {
  // 1. static classification (fast, no DB)
  const classification = classifyMigration(input.up);

  // 2. Qodo advisory review
  const qodo = await reviewMigration({ upSql: input.up, downSql: input.down }).catch(
    (e): QodoReviewResult => ({
      verdict: "skipped",
      summary: `Qodo unavailable: ${(e as Error).message}`,
      findings: [],
    }),
  );

  // 3. shadow dry-run + rollback proof
  const shadow = await provisionShadow({ adminUrl: input.adminUrl, schemaSql: input.schemaSql });
  let rollback: RollbackResult;
  const client = new Client({ connectionString: shadow.url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    // Bound the DRY-RUN itself — the submitted up/down runs on the shadow here.
    // A migration with a long statement (e.g. SELECT pg_sleep(...)) or an
    // indefinite lock wait would otherwise leave the request stuck in dry_running
    // and block shadow teardown. Env-overridable via SHADOW_STATEMENT_TIMEOUT_MS
    // / SHADOW_LOCK_TIMEOUT_MS.
    const posInt = (v: unknown, def: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
    };
    await client.query(`SET statement_timeout = ${posInt(process.env.SHADOW_STATEMENT_TIMEOUT_MS, 30_000)}`);
    await client.query(`SET lock_timeout = ${posInt(process.env.SHADOW_LOCK_TIMEOUT_MS, 5_000)}`);
    rollback = await verifyRollback(client, input.up, input.down);
  } finally {
    // Guard client.end() so a shutdown rejection can't skip destroy() (leaking
    // the shadow database) or mask the original verification error.
    await client.end().catch(() => {});
    await shadow.destroy().catch(() => {});
  }

  // 4. data pre-flight — exact read-only probes on the target (ADR-011)
  const preflight = input.targetReadOnly ? await runPreflight(input.targetReadOnly, input.up) : [];
  const willFailOnData = preflight.some((p) => p.willFail === true);
  // A probe that could not be evaluated (no auto-probe, or a degraded timeout)
  // means we could NOT prove the data is safe — treat as unknown, not as pass.
  const dataUnknown = preflight.some((p) => p.willFail === null);

  // 5. POLICY — the deterministic gate decision (ADR-004). The model proposes;
  // this disposes. It is computed here, never chosen by the LLM.
  const disposition = gateDisposition({
    severity: classification.overallSeverity,
    hasBlockingStatement: classification.hasBlockingStatement,
    dataWillFail: willFailOnData,
    dataUnknown,
    // A failed rollback proof must affect the gate — a green migration whose
    // down doesn't restore the schema is not recoverable and can't be auto.
    rollbackVerified: rollback.rollbackVerified,
  });

  return {
    classification,
    rollback,
    qodo,
    preflight,
    willFailOnData,
    dataUnknown,
    disposition,
    blocked: disposition === "blocked",
    requiresTypedConfirm: disposition === "typed_confirm",
  };
}
