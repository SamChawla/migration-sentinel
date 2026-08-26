/**
 * Agent orchestrator (Phase 3.3 / 3.4).
 *
 * Drives one migration request from intake to the paused gate, live and against
 * real databases:
 *
 *   1. ensure SQL exists — if the intake is an intent with no SQL yet, generate
 *      {up, down, summary} via TrueForge from the target's live schema;
 *   2. dry-run — dump the target's real schema with pg_dump, clone it onto an
 *      ephemeral shadow, run the safety pipeline (classifier + shadow rollback
 *      proof + read-only data pre-flight on the REAL target + Qodo review);
 *   3. persist — write shadow_run / blast_report / findings / preflight /
 *      qodo_review, arm the typed-confirm gate, and land the request in
 *      `awaiting_approval` (or `blocked`).
 *
 * The apply itself never happens here — the request stops at the gate. A human
 * decision drives {@link applyMigration}.
 */
import { Client } from "pg";
import {
  getRequest,
  getRequestIntake,
  getLatestArtifact,
  getRequestTargetUrl,
  upsertGeneratedArtifact,
  setRequestStatus,
  claimRequestForPipeline,
  persistSafetyReport,
  insertAuditEvent,
} from "@sentinel/db/queries";
import { dumpTargetSchema, splitStatements } from "@sentinel/shadow";
import { runSafetyPipeline, type SafetyReport } from "./pipeline";
import { generateMigration } from "./generate";

export interface RunPipelineOptions {
  /** Override the target connection URL (else resolved from the request/env). */
  targetUrl?: string;
  /** SHADOW_ADMIN_URL override (else env). */
  shadowAdminUrl?: string;
}

/** Best-effort primary table for the typed-confirm token (matches the UI convention). */
function primaryTable(upSql: string, preflightTables: string[]): string {
  if (preflightTables.length > 0) return stripSchema(preflightTables[0]);
  for (const stmt of splitStatements(upSql)) {
    const m = stmt.match(/\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)/i) ??
      stmt.match(/\bUPDATE\s+(?:ONLY\s+)?([\w."]+)/i) ??
      stmt.match(/\bDELETE\s+FROM\s+(?:ONLY\s+)?([\w."]+)/i) ??
      stmt.match(/\bTRUNCATE\s+(?:TABLE\s+)?([\w."]+)/i) ??
      // Green/metadata-only migrations (e.g. CREATE INDEX CONCURRENTLY) can also
      // reach typed_confirm via the rollback-failure path — derive a token here too.
      stmt.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?([\w."]+)/i) ??
      stmt.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i) ??
      stmt.match(/\bINSERT\s+INTO\s+([\w."]+)/i);
    if (m) return stripSchema(m[1]);
  }
  // Non-empty fallback — the gate always has a token to require.
  return "CONFIRM";
}

function stripSchema(ident: string): string {
  return ident.replace(/"/g, "").split(".").pop() ?? ident;
}

function mapReport(requestId: string, report: SafetyReport) {
  const preflight = report.preflight.map((p) => ({
    kind: p.check.kind,
    table: p.check.table,
    probeSql: p.check.probeSql,
    violations: p.violations,
    willFail: p.willFail,
    description: p.check.description,
  }));
  const findings = report.classification.statements.map((s) => ({
    statement: s.statement,
    severity: s.severity,
    lockType: s.lockHint ?? null,
    note: s.note ?? null,
  }));
  return {
    requestId,
    overallSeverity: report.classification.overallSeverity,
    reversibility: report.classification.reversibility,
    rollbackVerified: report.rollback.rollbackVerified,
    schemaBeforeHash: report.rollback.schemaBefore,
    schemaAfterUpHash: report.rollback.schemaAfterUp,
    schemaAfterDownHash: report.rollback.schemaAfterDown,
    findings,
    preflight,
    qodo: {
      verdict: report.qodo.verdict,
      summary: report.qodo.summary,
      findings: report.qodo.findings.map((f) => `[${f.severity}] ${f.message}`),
      raw: report.qodo.raw ?? report.qodo,
    },
    requiresTypedConfirm: report.requiresTypedConfirm,
    status: (report.blocked ? "blocked" : "awaiting_approval") as "blocked" | "awaiting_approval",
  };
}

export async function runAgentPipeline(requestId: string, opts: RunPipelineOptions = {}): Promise<void> {
  const req = await getRequest(requestId);
  if (!req) throw new Error(`runAgentPipeline: request ${requestId} not found`);

  // Atomically claim the request (received → generating). Only the winner runs,
  // so concurrent invocations can't both analyze and clobber state, and a
  // completed request (status != received) can't be reopened.
  const claimed = await claimRequestForPipeline(requestId);
  if (!claimed) {
    throw new Error(`runAgentPipeline: request ${requestId} not claimable (status=${req.status}); already running or past intake.`);
  }

  const targetUrl = opts.targetUrl ?? (await getRequestTargetUrl(requestId));
  if (!targetUrl) throw new Error("runAgentPipeline: no target URL (set TARGET_DB_URL or target.connection_url)");
  const shadowAdminUrl = opts.shadowAdminUrl ?? process.env.SHADOW_ADMIN_URL;
  if (!shadowAdminUrl) throw new Error("runAgentPipeline: SHADOW_ADMIN_URL not set");

  try {
    // 1 ── ensure we have a {up, down} to analyze.
    let artifact = await getLatestArtifact(requestId);
    if (!artifact || !artifact.upSql.trim()) {
      const intake = await getRequestIntake(requestId);
      const intent =
        (intake?.payload.intent as string | undefined) ?? (intake?.payload.sql as string | undefined);
      if (!intent) throw new Error("No SQL and no intent to generate from.");

      await setRequestStatus(requestId, "generating");
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.agent",
        action: "generate.started",
        detail: "TrueForge generating a paired {up, down} migration from the intent.",
        tone: "info",
      });
      const schemaContext = await dumpTargetSchema(targetUrl);
      const gen = await generateMigration({ intent, schemaContext });
      artifact = await upsertGeneratedArtifact({
        requestId,
        upSql: gen.up,
        downSql: gen.down,
        plainSummary: gen.summary,
        model: gen.model,
      });
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.agent",
        action: "generate.completed",
        detail: `Generated migration v${artifact.version} via ${gen.model}.`,
        tone: "info",
      });
    }

    // 2 ── dry-run the safety pipeline against a faithful shadow + the real target.
    await setRequestStatus(requestId, "dry_running");
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor: "sentinel.agent",
      action: "shadow.started",
      detail: "Cloning target schema onto an ephemeral shadow and running the dry-run.",
      tone: "info",
    });

    const schemaSql = await dumpTargetSchema(targetUrl);
    const targetReadOnly = new Client({ connectionString: targetUrl });
    await targetReadOnly.connect();
    let report: SafetyReport;
    try {
      report = await runSafetyPipeline({
        up: artifact.upSql,
        down: artifact.downSql,
        schemaSql,
        adminUrl: shadowAdminUrl,
        targetReadOnly,
      });
    } finally {
      await targetReadOnly.end().catch(() => {});
    }

    // 3 ── persist everything the Approval Console renders + arm the gate.
    const mapped = mapReport(requestId, report);
    const preflightTables = mapped.preflight.map((p) => p.table);
    const expectedConfirmValue = mapped.requiresTypedConfirm
      ? primaryTable(artifact.upSql, preflightTables)
      : null;

    await persistSafetyReport({
      ...mapped,
      seededWithData: false,
      expectedConfirmValue,
      logs: [
        `severity=${report.classification.overallSeverity}`,
        `rollback_verified=${report.rollback.rollbackVerified}`,
        `qodo=${report.qodo.verdict}`,
        `disposition=${report.disposition}`,
      ].join(" | "),
    });

    if (report.blocked) {
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.agent",
        action: "gate.blocked",
        detail: "BLOCKED — whole-dataset destruction with no recovery path. Sentinel refuses to apply.",
        tone: "red",
      });
    } else {
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.agent",
        action: "gate.awaiting_approval",
        detail: `Analysis complete (${report.classification.overallSeverity.toUpperCase()}). Paused for human approval.`,
        tone: report.classification.overallSeverity === "green" ? "green" : "info",
      });
    }
  } catch (e) {
    await setRequestStatus(requestId, "failed").catch(() => {});
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor: "sentinel.agent",
      action: "pipeline.failed",
      detail: `Pipeline failed: ${(e as Error).message}`,
      tone: "red",
    }).catch(() => {});
    throw e;
  }
}
