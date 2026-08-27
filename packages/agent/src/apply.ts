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

/**
 * True when the migration contains a statement that CANNOT run inside a
 * transaction block (CREATE INDEX CONCURRENTLY, VACUUM, etc.), forcing the
 * autocommit apply path. Detection runs on CODE only — comments are stripped
 * (splitStatements) and string/dollar literals blanked (codeOnly) — so a keyword
 * that appears only in a `-- CONCURRENTLY` comment or a string literal can't
 * misclassify an otherwise-transactional migration.
 *
 * NOTE: `ALTER TYPE ... ADD VALUE` is deliberately NOT here. Postgres 12+ allows
 * it inside a transaction (as long as the new value isn't USED until after
 * commit), so running it transactionally is correct — a later statement failure
 * then rolls the whole migration back atomically instead of leaving the enum
 * value committed. If the migration misuses the value in the same transaction,
 * Postgres raises "unsafe use of new value" and we roll back, which is the safe
 * outcome.
 */
export function isNonTransactional(upSql: string): boolean {
  // Checked PER STATEMENT (comments stripped, literals blanked) so `[\s\S]*` can't
  // span statements. CONCURRENTLY is matched ONLY in the contexts where it is a
  // keyword — CREATE/DROP INDEX CONCURRENTLY, REINDEX ... CONCURRENTLY, REFRESH
  // MATERIALIZED VIEW ... CONCURRENTLY, DETACH PARTITION ... CONCURRENTLY — not as
  // a bare word, so a column literally named "concurrently" doesn't force the
  // (non-atomic) autocommit path.
  return splitStatements(upSql).some((stmt) => {
    const c = codeOnly(stmt);
    return (
      /\b(VACUUM|REINDEX\s+(?:DATABASE|SCHEMA|SYSTEM)|CREATE\s+DATABASE|DROP\s+DATABASE|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|ALTER\s+SYSTEM|CREATE\s+SUBSCRIPTION|DROP\s+SUBSCRIPTION)\b/i.test(c) ||
      /\bINDEX\s+CONCURRENTLY\b/i.test(c) ||
      /\bREINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(c) ||
      /\bREFRESH\s+MATERIALIZED\s+VIEW\b[\s\S]*\bCONCURRENTLY\b/i.test(c) ||
      /\bDETACH\s+PARTITION\b[\s\S]*\bCONCURRENTLY\b/i.test(c)
    );
  });
}

/**
 * A statement that subverts the guarded-apply contract: the executor OWNS the
 * transaction boundary and the lock/statement timeouts, so a migration must not
 * contain its own transaction control (which would commit earlier statements
 * outside the executor's BEGIN/COMMIT and make a later ROLLBACK ineffective) nor
 * reset the safety timeouts (which would let it wait indefinitely). Checked
 * per-statement on code-only so keywords in comments/strings don't false-positive.
 */
export function findExecutorSubversion(upSql: string): string | null {
  for (const stmt of splitStatements(upSql)) {
    const c = codeOnly(stmt).trim();
    // NOTE: SET CONSTRAINTS is intentionally NOT here — it only changes the
    // timing of deferrable constraint checks WITHIN the executor's transaction;
    // it neither commits nor escapes it, so it's a legitimate migration statement.
    if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|ABORT)\b/i.test(c))
      return `transaction-control statement ("${stmt.slice(0, 40)}") — the executor owns the transaction`;
    if (/^SET\s+(?:SESSION\s+|LOCAL\s+)?(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b/i.test(c))
      return `timeout override ("${stmt.slice(0, 40)}") — would disable the guarded-apply safeguards`;
    if (/^RESET\s+(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|ALL)\b/i.test(c))
      return `RESET of a safety GUC ("${stmt.slice(0, 40)}") — would disable the guarded-apply safeguards`;
  }
  return null;
}

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

  // Refuse any migration that would subvert the executor's transaction/timeout
  // guarantees (embedded COMMIT/BEGIN, or SET/RESET of the safety timeouts). Done
  // BEFORE the claim so a bad artifact fails fast without touching request state.
  const subversion = findExecutorSubversion(artifact.upSql);
  if (subversion) {
    throw new Error(
      `applyMigration: refusing to apply — migration contains a ${subversion}. ` +
        `The guarded apply owns the transaction and timeouts; rewrite the migration without it.`,
    );
  }

  // SECURITY: bind the apply to the SAME target the pipeline analyzed — the one
  // resolved from the request, never a caller-supplied override. opts.targetUrl
  // is ignored for the connection (a substituted DB would invalidate all the
  // shadow/rollback/preflight evidence the human approved).
  const targetUrl = await getRequestTargetUrl(requestId);
  if (!targetUrl) throw new Error("applyMigration: no target URL for this request");

  // Positive integer only — 0 DISABLES the timeout in Postgres, and NaN/negative
  // are invalid, so any of those falls back to the safe default. Validated BEFORE
  // the claim so a bad config fails fast without touching request state.
  const posInt = (v: unknown, def: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  const lockTimeoutMs = posInt(opts.lockTimeoutMs ?? process.env.APPLY_LOCK_TIMEOUT_MS, 3000);
  const statementTimeoutMs = posInt(opts.statementTimeoutMs ?? process.env.APPLY_STATEMENT_TIMEOUT_MS, 30000);
  // Bound the CONNECT itself — lock_timeout/statement_timeout only take effect
  // AFTER a session exists, so a stalled DNS/TCP/TLS handshake would otherwise
  // leave a claimed request 'applying' indefinitely.
  const connectTimeoutMs = posInt(process.env.APPLY_CONNECT_TIMEOUT_MS, 10000);

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
  // Detection (isNonTransactional) ignores comments/strings so a keyword buried
  // in a comment can't force the non-atomic autocommit path.
  const nonTransactional = isNonTransactional(artifact.upSql);

  // Everything after the claim is guarded: ANY failure (run-row insert, connect,
  // execution, or bookkeeping) lands the request in a definite 'failed' state
  // rather than stranding it in 'applying' where it can never be re-claimed.
  let runId: string | null = null;
  let committed = false;
  let committedCount = 0;
  // TRUE once we've sent an autocommit statement to the server. Its COMMIT can
  // happen even if the connection drops before the response arrives — so a
  // failure after this point may have already changed the target, and we must
  // NOT record a clean rollback for it (committedCount alone would read 0).
  let autocommitAttempted = false;
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

    const client = new Client({ connectionString: targetUrl, connectionTimeoutMillis: connectTimeoutMs });
    try {
      await client.connect();
      await client.query(`SET lock_timeout = ${Number(lockTimeoutMs)}`);
      await client.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);

      if (nonTransactional) {
        const stmts = splitStatements(artifact.upSql);
        for (const stmt of stmts) {
          autocommitAttempted = true; // set BEFORE the await — an in-flight commit counts
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
    // Any failure in the autocommit path is potentially-partial: an in-flight
    // statement may have committed even though we never saw its response, so
    // committedCount can under-count. Treat autocommitAttempted as the signal.
    const partial = nonTransactional && autocommitAttempted;
    const partialNote = partial
      ? ` (autocommit — at least ${committedCount} statement(s) committed; the in-flight statement's result is unknown, so the target may have changed — manual reconciliation required)`
      : "";
    log(`FAILED — ${(e as Error).message}${partialNote}`);
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
        detail: `Apply failed — ${(e as Error).message}${partial ? ` (autocommit — target may have partially changed; ≥${committedCount} committed + an in-flight statement of unknown result; manual reconciliation required)` : ""}`,
        tone: "red",
      }),
    );
    return { status: "failed", error: (e as Error).message, logs: logs.join("\n") };
  }
}
