/**
 * Guarded apply executor (Phase 4.2 / ADR-004).
 *
 * The ONLY code path that writes the migration to the real target. It is
 * defense-in-depth: even though the API gate already checked the approval, this
 * function INDEPENDENTLY re-asserts it against the database of record and
 * re-derives `blocked` from the SQL itself — the agent cannot self-approve and a
 * blocked migration cannot be pushed through even with a human decision.
 *
 * The write runs inside a single transaction with `lock_timeout` and
 * `statement_timeout` set, so a migration that would block on a lock or run long
 * aborts and rolls back automatically instead of freezing the target.
 */
import { Client } from "pg";
import { assertApproved } from "@sentinel/core";
import { classifyMigration } from "@sentinel/shadow";
import {
  getRequest,
  getLatestArtifact,
  getRequestTargetUrl,
  insertApplyRun,
  finishApplyRun,
  setRequestStatus,
  insertAuditEvent,
} from "@sentinel/db/queries";

export interface ApplyOptions {
  targetUrl?: string;
  typedConfirm?: string | null;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface ApplyResult {
  status: "applied" | "failed";
  error?: string;
  logs: string;
}

export async function applyMigration(requestId: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const rec = await getRequest(requestId);
  if (!rec) throw new Error(`applyMigration: request ${requestId} not found`);
  const artifact = await getLatestArtifact(requestId);
  if (!artifact) throw new Error(`applyMigration: no artifact for request ${requestId}`);

  // Independent gate — throws GateError if not truly approved / blocked / unconfirmed.
  const blocked = classifyMigration(artifact.upSql).hasBlockingStatement;
  assertApproved({
    decision: rec.approval.decision,
    requiresTypedConfirm: rec.approval.requiresTypedConfirm,
    typedConfirmValue: opts.typedConfirm ?? null,
    expectedConfirmValue: rec.approval.expectedConfirm ?? null,
    blocked,
  });

  const targetUrl = opts.targetUrl ?? (await getRequestTargetUrl(requestId));
  if (!targetUrl) throw new Error("applyMigration: no target URL");

  const lockTimeoutMs = opts.lockTimeoutMs ?? Number(process.env.APPLY_LOCK_TIMEOUT_MS ?? 3000);
  const statementTimeoutMs = opts.statementTimeoutMs ?? Number(process.env.APPLY_STATEMENT_TIMEOUT_MS ?? 30000);

  await setRequestStatus(requestId, "applying");
  const runId = await insertApplyRun({
    requestId,
    lockTimeoutMs,
    statementTimeoutMs,
    rollbackAvailable: rec.reversibility !== "irreversible",
  });

  const logs: string[] = [];
  const log = (m: string) => logs.push(`[${new Date().toISOString()}] ${m}`);
  log(`apply start — lock_timeout=${lockTimeoutMs}ms statement_timeout=${statementTimeoutMs}ms`);

  const client = new Client({ connectionString: targetUrl });
  try {
    await client.connect();
    await client.query(`SET lock_timeout = ${Number(lockTimeoutMs)}`);
    await client.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);
    await client.query("BEGIN");
    log("BEGIN");
    try {
      const res = await client.query(artifact.upSql);
      const rows = Array.isArray(res) ? res.reduce((n, r) => n + (r.rowCount ?? 0), 0) : res.rowCount ?? 0;
      await client.query("COMMIT");
      log(`COMMIT — migration applied${rows ? ` (${rows} rows affected)` : ""}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log(`ERROR — ${(e as Error).message}. ROLLBACK issued; target unchanged.`);
      throw e;
    }
  } catch (e) {
    await finishApplyRun(runId, { status: "failed", logs: logs.join("\n"), rolledBackAt: new Date() });
    await setRequestStatus(requestId, "failed");
    await insertAuditEvent({
      migrationRequestId: requestId,
      actor: "sentinel.apply",
      action: "apply.failed",
      detail: `Apply failed and rolled back — ${(e as Error).message}`,
      tone: "red",
    });
    return { status: "failed", error: (e as Error).message, logs: logs.join("\n") };
  } finally {
    await client.end().catch(() => {});
  }

  await finishApplyRun(runId, { status: "succeeded", logs: logs.join("\n"), appliedAt: new Date() });
  await setRequestStatus(requestId, "applied");
  await insertAuditEvent({
    migrationRequestId: requestId,
    actor: "sentinel.apply",
    action: "apply.succeeded",
    detail: `Applied to target — "${rec.title}".`,
    tone: "green",
  });
  return { status: "applied", logs: logs.join("\n") };
}
