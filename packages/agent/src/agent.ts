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
  setTrueforgeSession,
} from "@sentinel/db/queries";
import { dumpTargetSchema, splitStatements } from "@sentinel/shadow";
import { runSafetyPipeline, type SafetyReport } from "./pipeline";
import { generateMigration } from "./generate";
import { openApplyGateSession } from "./apply-session";

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

  try {
    // Resolve required configuration INSIDE the failure handler — the request is
    // already claimed ('generating'), so a missing target/shadow URL (or a lookup
    // failure) must land it in 'failed' with an audit event, not strand it in
    // 'generating' forever where no retry can re-claim a non-'received' request.
    const targetUrl = opts.targetUrl ?? (await getRequestTargetUrl(requestId));
    if (!targetUrl) throw new Error("runAgentPipeline: the request's target database has no stored connection URL — add one via the connections picker (POST /api/connections) or set target_database.connection_url");
    const shadowAdminUrl = opts.shadowAdminUrl ?? process.env.SHADOW_ADMIN_URL;
    if (!shadowAdminUrl) throw new Error("runAgentPipeline: SHADOW_ADMIN_URL not set");

    // 1 ── ensure we have a {up, down} to analyze.
    let artifact = await getLatestArtifact(requestId);
    if (!artifact || !artifact.upSql.trim()) {
      const intake = await getRequestIntake(requestId);
      // Keep raw SQL and NL intent DISTINCT: raw SQL must drive the generator's
      // correction/repair prompt (rawSql), not be fed as a natural-language intent
      // — otherwise a submitted migration is regenerated from scratch instead of
      // corrected.
      const rawSql = (intake?.payload.sql as string | undefined)?.trim() || undefined;
      const intent = (intake?.payload.intent as string | undefined)?.trim() || undefined;
      if (!rawSql && !intent) throw new Error("No SQL and no intent to generate from.");

      await setRequestStatus(requestId, "generating");
      await insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.agent",
        action: "generate.started",
        detail: rawSql
          ? "TrueForge correcting the submitted SQL into a paired {up, down} migration."
          : "TrueForge generating a paired {up, down} migration from the intent.",
        tone: "info",
      });
      const schemaContext = await dumpTargetSchema(targetUrl);
      const gen = await generateMigration({ intent, rawSql, schemaContext });
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
    // Bound the connect — a stalled DNS/TCP/TLS handshake would otherwise strand
    // the claimed pipeline in dry_running before the finally/failure handler runs.
    const targetReadOnly = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 10_000 });
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

    // persistSafetyReport has ATOMICALLY armed the gate and set the request to
    // awaiting_approval/blocked — that is the authoritative outcome. The gate
    // audit event below is cosmetic, so it is BEST-EFFORT: a failure writing it
    // must NOT fall into the outer catch and overwrite the armed status with
    // 'failed', stranding a complete safety report under a terminal state.
    try {
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
    } catch (auditErr) {
      console.error(`[agent] gate audit write failed for ${requestId} (report already persisted):`, auditErr);
    }

    // Phase A — arm the TrueForge leg of the gate: open the apply session so
    // the agent's apply_migration call is ALREADY paused on
    // tool.approval_required while the human reviews. Strictly best-effort and
    // ADDITIVE: a failure here (server down, tool unconfigured) leaves the
    // deterministic core gate governing alone, exactly as before this phase.
    if (!report.blocked) {
      try {
        const gateSession = await openApplyGateSession({
          requestId,
          title: req.title,
          upSql: artifact.upSql,
        });
        if (gateSession) {
          await setTrueforgeSession(requestId, gateSession);
          await insertAuditEvent({
            migrationRequestId: requestId,
            actor: "sentinel.agent",
            action: "gate.trueforge_armed",
            detail: "TrueForge apply session paused on tool.approval_required — the console decision will resolve it.",
            tone: "info",
            payload: { sessionId: gateSession.sessionId },
          });
        } else {
          await insertAuditEvent({
            migrationRequestId: requestId,
            actor: "sentinel.agent",
            action: "gate.trueforge_unavailable",
            detail: "TrueForge apply session could not be armed — the deterministic core gate governs alone.",
            tone: "neutral",
          });
        }
      } catch (tfErr) {
        console.error(`[agent] TrueForge gate arming failed for ${requestId} (non-fatal):`, tfErr);
      }
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
