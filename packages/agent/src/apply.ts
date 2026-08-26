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
import { classifyMigration, splitStatements, codeOnly } from "@sentinel/shadow";
import {
  getRequest,
  getLatestArtifact,
  getRequestTargetUrl,
  insertApplyRun,
  finishApplyRun,
  setRequestStatus,
  claimRequestForApply,
  insertAuditEvent,
} from "@sentinel/db/queries";

export interface ApplyOptions {
  /** @deprecated Ignored — the apply always binds to the request's analyzed
   *  target (getRequestTargetUrl). A caller cannot redirect the write. */
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

  // SECURITY: bind the apply to the SAME target the pipeline analyzed — the one
  // resolved from the request, never a caller-supplied override. opts.targetUrl
  // is ignored for the connection (a substituted DB would invalidate all the
  // shadow/rollback/preflight evidence the human approved).
  const targetUrl = await getRequestTargetUrl(requestId);
  if (!targetUrl) throw new Error("applyMigration: no target URL for this request");

  const lockTimeoutMs = opts.lockTimeoutMs ?? Number(process.env.APPLY_LOCK_TIMEOUT_MS ?? 3000);
  const statementTimeoutMs = opts.statementTimeoutMs ?? Number(process.env.APPLY_STATEMENT_TIMEOUT_MS ?? 30000);

  // One-shot: atomically flip approved → applying. If we don't win the claim,
  // the request was already applied (or isn't approved) — never reapply.
  const claimed = await claimRequestForApply(requestId);
  if (!claimed) {
    return {
      status: "failed",
      error: `Request is not in an applicable state (already applied or not approved).`,
      logs: "",
    };
  }

  const logs: string[] = [];
  const log = (m: string) => logs.push(`[${new Date().toISOString()}] ${m}`);
  const bestEffort = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      log(`WARN — control-plane write failed: ${(e as Error).message}`);
    }
  };

  // CREATE INDEX CONCURRENTLY (and a few others) cannot run inside a transaction
  // block. Those run in autocommit — there is no atomic rollback for them, by
  // PostgreSQL's own design, so a later failure can leave earlier DDL committed.
  const nonTransactional = /\b(CONCURRENTLY|VACUUM|REINDEX\s+DATABASE|CREATE\s+DATABASE|DROP\s+DATABASE)\b/i.test(
    codeOnly(artifact.upSql),
  );

  // Everything after the claim is guarded: ANY failure (run-row insert, connect,
  // execution, or bookkeeping) lands the request in a definite 'failed' state
  // rather than stranding it in 'applying' where it can never be re-claimed.
  let runId: string | null = null;
  let committed = false;
  let committedCount = 0;
  try {
    runId = await insertApplyRun({
      requestId,
      lockTimeoutMs,
      statementTimeoutMs,
      rollbackAvailable: rec.reversibility !== "irreversible",
    });
    log(
      `apply start — lock_timeout=${lockTimeoutMs}ms statement_timeout=${statementTimeoutMs}ms` +
        (nonTransactional ? " (autocommit — non-transactional statement present)" : ""),
    );

    const client = new Client({ connectionString: targetUrl });
    try {
      await client.connect();
      await client.query(`SET lock_timeout = ${Number(lockTimeoutMs)}`);
      await client.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);

      if (nonTransactional) {
        const stmts = splitStatements(artifact.upSql);
        for (const stmt of stmts) {
          await client.query(stmt);
          committedCount++;
        }
        committed = true;
        log(`APPLIED (autocommit) — ${committedCount}/${stmts.length} statement(s) committed individually`);
      } else {
        await client.query("BEGIN");
        log("BEGIN");
        try {
          const res = await client.query(artifact.upSql);
          const rows = Array.isArray(res) ? res.reduce((n, r) => n + (r.rowCount ?? 0), 0) : res.rowCount ?? 0;
          await client.query("COMMIT");
          committed = true;
          log(`COMMIT — migration applied${rows ? ` (${rows} rows affected)` : ""}`);
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          log(`ERROR — ${(e as Error).message}. ROLLBACK issued; target unchanged.`);
          throw e;
        }
      }
    } finally {
      await client.end().catch(() => {});
    }

    // Target is committed. Success bookkeeping is best-effort — a control-plane
    // hiccup here must not report the (already done) apply as failed.
    await bestEffort(() => finishApplyRun(runId!, { status: "succeeded", logs: logs.join("\n"), appliedAt: new Date() }));
    await bestEffort(() => setRequestStatus(requestId, "applied"));
    await bestEffort(() =>
      insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.apply",
        action: "apply.succeeded",
        detail: `Applied to target — "${rec.title}".`,
        tone: "green",
      }),
    );
    return { status: "applied", logs: logs.join("\n") };
  } catch (e) {
    const partial = nonTransactional && committedCount > 0;
    log(`FAILED — ${(e as Error).message}${partial ? ` (autocommit — ${committedCount} statement(s) already committed; manual reconciliation required)` : ""}`);
    // Best-effort each write so a single control-plane failure can't strand the
    // request in 'applying'. rolledBackAt is null for a partial autocommit.
    if (runId)
      await bestEffort(() =>
        finishApplyRun(runId!, {
          status: "failed",
          logs: logs.join("\n"),
          rolledBackAt: committed || partial ? null : new Date(),
        }),
      );
    await bestEffort(() => setRequestStatus(requestId, "failed"));
    await bestEffort(() =>
      insertAuditEvent({
        migrationRequestId: requestId,
        actor: "sentinel.apply",
        action: "apply.failed",
        detail: `Apply failed — ${(e as Error).message}${partial ? ` (autocommit left ${committedCount} statement(s) committed)` : ""}`,
        tone: "red",
      }),
    );
    return { status: "failed", error: (e as Error).message, logs: logs.join("\n") };
  }
}
