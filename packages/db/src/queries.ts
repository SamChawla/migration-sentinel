/**
 * Real query layer — replaces the in-memory store.ts scaffold.
 *
 * Every function here returns the flat shapes the UI already expects
 * (RequestRecord, AuditEventRow) by JOINing across the normalized tables.
 */
import { eq, desc, sql, and, or, inArray, ilike } from "drizzle-orm";
import { db } from "./client";
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
} from "./schema";
import type {
  RequestStatus,
  Severity,
  Reversibility,
  QodoVerdict,
  ApprovalDecision,
} from "@sentinel/core";
import { encryptUrl, decryptUrl } from "./crypt";

// ── Flat shapes the UI consumes ──────────────────────────────────────────

export interface FindingRow {
  statement: string;
  severity: Severity;
  lockType?: string | null;
  note: string | null;
}

export interface RequestRecord {
  id: string;
  title: string;
  targetDb: string;
  status: RequestStatus;
  requestedBy: string;
  createdAt: string;
  decidedBy?: string | null;
  upSql: string;
  downSql: string;
  overallSeverity: Severity;
  reversibility: Reversibility;
  rollbackVerified: boolean;
  rowsAffected: number | null;
  estLockMs: number | null;
  findings: FindingRow[];
  qodoVerdict: QodoVerdict;
  qodoFindings: string[];
  preflight: PreflightRow[];
  approval: {
    decision: ApprovalDecision;
    requiresTypedConfirm: boolean;
    expectedConfirm?: string | null;
  };
}

export interface PreflightRow {
  kind: string;
  table: string;
  violations: number | null;
  willFail: boolean | null;
  description: string;
}

export interface AuditEventRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  requestId?: string | null;
  detail: string;
  tone: "green" | "red" | "info" | "neutral";
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toIso(d: Date | null | undefined): string {
  return d ? d.toISOString() : new Date().toISOString();
}

// ── Queries ──────────────────────────────────────────────────────────────

/**
 * List all migration requests, hydrated with the latest artifact, blast
 * report, approval, and shadow run. Ordered by created_at DESC.
 */
/** Server-side status groups for the requests list — MUST match the UI chips so
 *  a filter reflects EVERY matching request, not only those on the current page. */
const REQUEST_STATUS_GROUPS: Record<string, RequestStatus[]> = {
  awaiting_approval: ["awaiting_approval"],
  in_flight: ["received", "generating", "reviewing", "dry_running", "approved", "applying"],
  applied: ["applied"],
  blocked: ["blocked"],
  rejected: ["rejected"],
  failed: ["failed", "rolled_back"],
};

/** Build the shared WHERE for listRequests + countRequests so the filtered list
 *  and its total count always agree. Applied in SQL, across all pages. */
function requestFilterConditions(opts: { q?: string; status?: string }) {
  const conds = [];
  const group = opts.status && opts.status !== "all" ? REQUEST_STATUS_GROUPS[opts.status] : undefined;
  if (group) conds.push(inArray(migrationRequest.status, group));
  const q = opts.q?.trim();
  if (q) {
    // Escape LIKE wildcards so user text is matched LITERALLY — otherwise a search
    // for "%" or "_" is interpreted as pattern syntax and matches nearly every
    // row. Backslash is Postgres's default LIKE escape char.
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    conds.push(
      or(
        ilike(migrationRequest.title, like),
        ilike(migrationRequest.requestedBy, like),
        ilike(targetDatabase.connectionAlias, like),
        ilike(targetDatabase.name, like),
      ),
    );
  }
  return conds;
}

export async function listRequests(
  opts: { limit?: number; offset?: number; q?: string; status?: string } = {},
): Promise<RequestRecord[]> {
  // Bounded by default so the list path can't grow unbounded with history.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const conds = requestFilterConditions(opts);
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .leftJoin(approval, eq(approval.migrationRequestId, migrationRequest.id))
    .where(conds.length ? and(...conds) : undefined)
    // (created_at, id) is a TOTAL order — created_at alone is non-unique, so
    // offset paging over ties would duplicate/skip rows between page requests.
    .orderBy(desc(migrationRequest.createdAt), desc(migrationRequest.id))
    .limit(limit)
    .offset(offset);

  // Hydrate rows CONCURRENTLY (Promise.all over rows), and within each row run
  // the independent lookups in parallel — otherwise 50 rows × ~5 sequential
  // queries was ~250 serialized round trips. Depth is now O(3) regardless of page
  // size: {artifact, shadow} ‖ then {qodo, blast, preflight} ‖ then findings.
  const records: RequestRecord[] = await Promise.all(
    rows.map(async (row): Promise<RequestRecord> => {
    const req = row.migration_request;
    const target = row.target_database;
    const appr = row.approval;

    const [artifact, shadow] = await Promise.all([
      db
        .select()
        .from(generatedArtifact)
        .where(eq(generatedArtifact.migrationRequestId, req.id))
        .orderBy(desc(generatedArtifact.version))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select()
        .from(shadowRun)
        .where(eq(shadowRun.migrationRequestId, req.id))
        .orderBy(desc(shadowRun.createdAt))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

    const [qodoRow, blast, preflights] = await Promise.all([
      artifact
        ? db
            .select()
            .from(qodoReview)
            .where(eq(qodoReview.generatedArtifactId, artifact.id))
            .orderBy(desc(qodoReview.createdAt))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      shadow
        ? db
            .select()
            .from(blastReport)
            .where(eq(blastReport.shadowRunId, shadow.id))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      shadow
        ? db.select().from(preflightResult).where(eq(preflightResult.shadowRunId, shadow.id))
        : Promise.resolve([] as (typeof preflightResult.$inferSelect)[]),
    ]);

    let findings: FindingRow[] = [];
    if (blast) {
      const rawFindings = await db
        .select()
        .from(blastFinding)
        .where(eq(blastFinding.blastReportId, blast.id))
        .orderBy(blastFinding.statementIndex);
      findings = rawFindings.map((f) => ({
        statement: f.statementSql,
        severity: f.severity as Severity,
        lockType: f.lockType,
        note: f.note,
      }));
    }

    return {
      id: req.id,
      title: req.title,
      targetDb: target?.connectionAlias ?? target?.name ?? "unknown",
      status: req.status as RequestStatus,
      requestedBy: req.requestedBy,
      createdAt: toIso(req.createdAt),
      decidedBy: appr?.approver ?? null,
      upSql: artifact?.upSql ?? "",
      downSql: artifact?.downSql ?? "",
      overallSeverity: (blast?.overallSeverity as Severity) ?? "green",
      reversibility: (artifact?.reversibility as Reversibility) ?? "reversible",
      rollbackVerified: shadow?.rollbackVerified ?? false,
      rowsAffected: blast?.totalRowsAffected ?? null,
      estLockMs: blast?.estLockMs ?? null,
      findings,
      qodoVerdict: (qodoRow?.verdict as QodoVerdict) ?? "skipped",
      qodoFindings: Array.isArray(qodoRow?.findings)
        ? (qodoRow.findings as string[])
        : [],
      preflight: preflights.map((p) => ({
        kind: p.kind,
        table: p.tableName,
        violations: p.violations,
        willFail: p.willFail,
        description: p.description,
      })),
      approval: {
        decision: (appr?.decision as ApprovalDecision) ?? "pending",
        requiresTypedConfirm: appr?.requiresTypedConfirm ?? false,
        expectedConfirm: appr?.expectedConfirmValue ?? null,
      },
    };
    }),
  );

  return records;
}

/**
 * Get a single migration request by ID, fully hydrated.
 */
export async function getRequest(id: string): Promise<RequestRecord | null> {
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .leftJoin(approval, eq(approval.migrationRequestId, migrationRequest.id))
    .where(eq(migrationRequest.id, id))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  const req = row.migration_request;
  const target = row.target_database;
  const appr = row.approval;

  const artifact = await db
    .select()
    .from(generatedArtifact)
    .where(eq(generatedArtifact.migrationRequestId, req.id))
    .orderBy(desc(generatedArtifact.version))
    .limit(1)
    .then((r) => r[0] ?? null);

  let qodoRow2: typeof qodoReview.$inferSelect | null = null;
  if (artifact) {
    qodoRow2 = await db
      .select()
      .from(qodoReview)
      .where(eq(qodoReview.generatedArtifactId, artifact.id))
      .limit(1)
      .then((r) => r[0] ?? null);
  }

  const shadow = await db
    .select()
    .from(shadowRun)
    .where(eq(shadowRun.migrationRequestId, req.id))
    .orderBy(desc(shadowRun.createdAt))
    .limit(1)
    .then((r) => r[0] ?? null);

  let blast: typeof blastReport.$inferSelect | null = null;
  let findings: FindingRow[] = [];
  if (shadow) {
    blast = await db
      .select()
      .from(blastReport)
      .where(eq(blastReport.shadowRunId, shadow.id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (blast) {
      const rawFindings = await db
        .select()
        .from(blastFinding)
        .where(eq(blastFinding.blastReportId, blast.id))
        .orderBy(blastFinding.statementIndex);

      findings = rawFindings.map((f) => ({
        statement: f.statementSql,
        severity: f.severity as Severity,
        lockType: f.lockType,
        note: f.note,
      }));
    }
  }

  const preflights = shadow
    ? await db
        .select()
        .from(preflightResult)
        .where(eq(preflightResult.shadowRunId, shadow.id))
    : [];

  return {
    id: req.id,
    title: req.title,
    targetDb: target?.connectionAlias ?? target?.name ?? "unknown",
    status: req.status as RequestStatus,
    requestedBy: req.requestedBy,
    createdAt: toIso(req.createdAt),
    decidedBy: appr?.approver ?? null,
    upSql: artifact?.upSql ?? "",
    downSql: artifact?.downSql ?? "",
    overallSeverity: (blast?.overallSeverity as Severity) ?? "green",
    reversibility: (artifact?.reversibility as Reversibility) ?? "reversible",
    rollbackVerified: shadow?.rollbackVerified ?? false,
    rowsAffected: blast?.totalRowsAffected ?? null,
    estLockMs: blast?.estLockMs ?? null,
    findings,
    qodoVerdict: (qodoRow2?.verdict as QodoVerdict) ?? "skipped",
    qodoFindings: Array.isArray(qodoRow2?.findings)
      ? (qodoRow2.findings as string[])
      : [],
    preflight: preflights.map((p) => ({
      kind: p.kind,
      table: p.tableName,
      violations: p.violations,
      willFail: p.willFail,
      description: p.description,
    })),
    approval: {
      decision: (appr?.decision as ApprovalDecision) ?? "pending",
      requiresTypedConfirm: appr?.requiresTypedConfirm ?? false,
      expectedConfirm: appr?.expectedConfirmValue ?? null,
    },
  };
}

// ── Mutations ────────────────────────────────────────────────────────────

export interface CreateRequestInput {
  title: string;
  targetDb: string;
  upSql: string;
  downSql: string;
  /** Natural-language intent — when set (and upSql is empty) the request is an
   *  nl_intent with NO artifact, so the agent generates the {up,down} pair. */
  intent?: string;
  requestedBy?: string;
}

/**
 * Create a new migration request + initial artifact + pending approval.
 * Returns the hydrated record.
 */
export async function createRequest(input: CreateRequestInput): Promise<RequestRecord> {
  // Atomic: target + request + artifact + approval + audit all commit together
  // or not at all — a mid-way failure never leaves a half-created request.
  const reqId = await db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(targetDatabase)
      .where(eq(targetDatabase.connectionAlias, input.targetDb))
      .limit(1);

    let targetId: string;
    if (targetRows.length > 0) {
      targetId = targetRows[0].id;
    } else {
      const [newTarget] = await tx
        .insert(targetDatabase)
        .values({ name: input.targetDb, connectionAlias: input.targetDb })
        .returning();
      targetId = newTarget.id;
    }

    const isIntent = !input.upSql.trim() && Boolean(input.intent?.trim());
    const [req] = await tx
      .insert(migrationRequest)
      .values({
        targetDatabaseId: targetId,
        intakeKind: isIntent ? "nl_intent" : "raw_sql",
        intakePayload: isIntent ? { intent: input.intent } : { sql: input.upSql },
        title: input.title,
        status: "received",
        requestedBy: input.requestedBy ?? "unknown",
      })
      .returning();

    // Raw SQL → persist it as the v1 artifact immediately. An nl_intent gets NO
    // artifact here, so runAgentPipeline's generation stage produces {up,down}.
    if (!isIntent && input.upSql) {
      await tx.insert(generatedArtifact).values({
        migrationRequestId: req.id,
        version: 1,
        upSql: input.upSql,
        downSql: input.downSql,
        reversibility: "reversible",
        model: "user-supplied",
      });
    }

    await tx.insert(approval).values({
      migrationRequestId: req.id,
      decision: "pending",
      requiresTypedConfirm: false,
    });

    await tx.insert(auditEvent).values({
      migrationRequestId: req.id,
      actor: input.requestedBy ?? "unknown",
      action: "request.created",
      detail: `"${input.title}" submitted to the agent.`,
      tone: "neutral",
    });

    return req.id;
  });

  const record = await getRequest(reqId);
  return record!;
}

/**
 * Record an approval decision. Enforces the gate for approvals.
 */
export async function recordApproval(input: {
  requestId: string;
  decision: "approved" | "rejected";
  approver: string;
}): Promise<boolean> {
  // Typed-confirm is NOT recorded here — it is verified at the gate by
  // assertApproved() (core/gate.ts) before this is ever called. Recording the
  // decision + status is atomic so they can never disagree.
  return await db.transaction(async (tx) => {
    // GUARD: only a request still awaiting a human decision (or blocked) can be
    // decided. If it has already advanced to applying/applied/failed/rejected,
    // the decision is moot and MUST NOT reopen it — resetting an in-flight apply
    // back to 'approved' would let a second executor re-claim and re-run it
    // (defeating the one-shot claim). We flip the request status FIRST, under a
    // state condition; if nothing moved, the request wasn't decidable and we
    // leave the approval row untouched too.
    // A BLOCKED request can only ever be REJECTED (closed out) — never approved.
    // Whole-dataset destruction is not human-overridable, so an 'approved'
    // decision is eligible only from 'awaiting_approval'. Rejecting is allowed
    // from either decidable state.
    const newStatus = input.decision === "approved" ? "approved" : "rejected";
    const eligible =
      input.decision === "approved"
        ? (["awaiting_approval"] as const)
        : (["awaiting_approval", "blocked"] as const);
    const moved = await tx
      .update(migrationRequest)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(
        and(
          eq(migrationRequest.id, input.requestId),
          inArray(migrationRequest.status, [...eligible]),
        ),
      )
      .returning({ id: migrationRequest.id });
    if (moved.length !== 1) return false;

    await tx
      .update(approval)
      .set({
        decision: input.decision,
        approver: input.approver,
        decidedAt: new Date(),
      })
      .where(eq(approval.migrationRequestId, input.requestId));
    return true;
  });
}

/**
 * Reset approval to pending (used when a gate pre-check fails). GUARDED: it only
 * acts when the request is still 'awaiting_approval'. A failing gate check from
 * one caller must NEVER erase a valid approval that another caller has already
 * recorded and CLAIMED for apply — resetting an 'approved'/'applying' request
 * would leave the executor committing while the DB shows the approval as pending.
 * A terminally 'blocked' request also stays blocked (the guard excludes it).
 * Returns whether it actually reset anything.
 */
export async function resetApproval(requestId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const moved = await tx
      .update(migrationRequest)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(
        and(
          eq(migrationRequest.id, requestId),
          eq(migrationRequest.status, "awaiting_approval"),
        ),
      )
      .returning({ id: migrationRequest.id });
    if (moved.length !== 1) return false;
    await tx
      .update(approval)
      .set({ decision: "pending", approver: null, decidedAt: null })
      .where(eq(approval.migrationRequestId, requestId));
    return true;
  });
}

// ── Pipeline persistence (agent orchestrator writes these) ────────────────

/** Resolve the connection URL for a request's target DB.
 *  Returns the target row's stored URL, or null when the target has none —
 *  there is NO environment-variable fallback (see the note below). Read + write
 *  use the same URL here; a production build would hand back distinct
 *  read-only vs write credentials. */
export async function getRequestTargetUrl(requestId: string): Promise<string | null> {
  const rows = await db
    .select({ url: targetDatabase.connectionUrl })
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  // Unknown request → null. A resolved target with NO stored URL also returns
  // null: with a multi-database picker, silently falling back to the global
  // TARGET_DB_URL could run a migration/probe against the default (production)
  // database rather than the alias the user selected.
  if (rows.length === 0) return null;
  const raw = rows[0].url;
  return raw ? decryptUrl(raw) : null;
}

export interface TargetDbRow {
  id: string;
  name: string;
  alias: string;
  /** whether a real connection URL is stored (vs. a seeded alias only) */
  hasUrl: boolean;
}

/** All configured target databases — the selectable connections. */
export async function listTargetDatabases(): Promise<TargetDbRow[]> {
  const rows = await db.select().from(targetDatabase).orderBy(targetDatabase.connectionAlias);
  return rows.map((r) => ({ id: r.id, name: r.name, alias: r.connectionAlias, hasUrl: Boolean(r.connectionUrl) }));
}

/** Add a NEW connection. Refuses to reuse an existing alias — overwriting a
 *  shared target row's URL would retroactively reroute every request that
 *  already references it (including pending/approved migrations). Returns
 *  { ok:false } on a duplicate alias so the caller can 409. The caller is
 *  responsible for having tested connectivity first. */
export async function addTargetConnection(
  input: { alias: string; url: string },
): Promise<{ ok: true; row: TargetDbRow } | { ok: false; reason: "duplicate" }> {
  const existing = await db
    .select({ id: targetDatabase.id })
    .from(targetDatabase)
    .where(eq(targetDatabase.connectionAlias, input.alias))
    .limit(1);
  if (existing.length > 0) return { ok: false, reason: "duplicate" };
  const [row] = await db
    .insert(targetDatabase)
    .values({ name: input.alias, connectionAlias: input.alias, connectionUrl: encryptUrl(input.url) })
    .returning();
  return { ok: true, row: { id: row.id, name: row.name, alias: row.connectionAlias, hasUrl: true } };
}

export interface IntakeRow {
  intakeKind: "nl_intent" | "raw_sql" | "github_pr";
  payload: Record<string, unknown>;
  title: string;
}

export async function getRequestIntake(requestId: string): Promise<IntakeRow | null> {
  const rows = await db
    .select({
      intakeKind: migrationRequest.intakeKind,
      payload: migrationRequest.intakePayload,
      title: migrationRequest.title,
    })
    .from(migrationRequest)
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    intakeKind: r.intakeKind as IntakeRow["intakeKind"],
    payload: (r.payload as Record<string, unknown>) ?? {},
    title: r.title,
  };
}

export interface ArtifactRow {
  id: string;
  version: number;
  upSql: string;
  downSql: string;
}

export async function getLatestArtifact(requestId: string): Promise<ArtifactRow | null> {
  const a = await db
    .select()
    .from(generatedArtifact)
    .where(eq(generatedArtifact.migrationRequestId, requestId))
    .orderBy(desc(generatedArtifact.version))
    .limit(1)
    .then((r) => r[0] ?? null);
  return a ? { id: a.id, version: a.version, upSql: a.upSql, downSql: a.downSql } : null;
}

/** Insert (or replace) the generated artifact for a request — used by the
 *  TrueForge generation step, which produces {up, down, summary} from an intent. */
export async function upsertGeneratedArtifact(input: {
  requestId: string;
  upSql: string;
  downSql: string;
  plainSummary?: string | null;
  reversibility?: Reversibility;
  model: string;
}): Promise<ArtifactRow> {
  // Read-max-then-insert in one transaction. The unique index on
  // (migration_request_id, version) is the ultimate guard: a concurrent writer
  // that computed the same version fails the insert rather than duplicating.
  const a = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: generatedArtifact.version })
      .from(generatedArtifact)
      .where(eq(generatedArtifact.migrationRequestId, input.requestId))
      .orderBy(desc(generatedArtifact.version))
      .limit(1);
    const version = (existing?.version ?? 0) + 1;
    const [row] = await tx
      .insert(generatedArtifact)
      .values({
        migrationRequestId: input.requestId,
        version,
        upSql: input.upSql,
        downSql: input.downSql,
        plainSummary: input.plainSummary ?? null,
        reversibility: input.reversibility ?? "reversible",
        model: input.model,
      })
      .returning();
    return row;
  });
  return { id: a.id, version: a.version, upSql: a.upSql, downSql: a.downSql };
}

export async function setRequestStatus(requestId: string, status: RequestStatus): Promise<void> {
  await db
    .update(migrationRequest)
    .set({ status, updatedAt: new Date() })
    .where(eq(migrationRequest.id, requestId));
}

/**
 * Atomically claim a request for apply: flip 'approved' → 'applying' in a single
 * conditional UPDATE. Returns true only for the caller that won the transition;
 * a retry after success or a concurrent second caller sees status !== 'approved'
 * and gets false, making the guarded apply strictly one-shot.
 */
export async function claimRequestForApply(requestId: string): Promise<boolean> {
  const rows = await db
    .update(migrationRequest)
    .set({ status: "applying", updatedAt: new Date() })
    .where(
      and(
        eq(migrationRequest.id, requestId),
        eq(migrationRequest.status, "approved"),
        // Defense in depth: the CURRENT approval decision must still be 'approved'
        // at claim time, not merely the request status. Guards against any window
        // where a concurrent rejection has flipped the decision — the claim then
        // finds no matching approval row and refuses, so the executor never runs.
        sql`EXISTS (SELECT 1 FROM ${approval} WHERE ${approval.migrationRequestId} = ${migrationRequest.id} AND ${approval.decision} = 'approved')`,
      ),
    )
    .returning({ id: migrationRequest.id });
  return rows.length === 1;
}

/**
 * Atomically claim a fresh request for the analysis pipeline: flip 'received' →
 * 'generating' in one conditional UPDATE. Only the caller that wins proceeds, so
 * concurrent runAgentPipeline invocations can't both analyze and clobber state.
 */
export async function claimRequestForPipeline(requestId: string): Promise<boolean> {
  const rows = await db
    .update(migrationRequest)
    .set({ status: "generating", updatedAt: new Date() })
    .where(and(eq(migrationRequest.id, requestId), eq(migrationRequest.status, "received")))
    .returning({ id: migrationRequest.id });
  return rows.length === 1;
}

export interface PersistSafetyInput {
  requestId: string;
  overallSeverity: Severity;
  reversibility: Reversibility;
  rollbackVerified: boolean;
  schemaBeforeHash?: string | null;
  schemaAfterUpHash?: string | null;
  schemaAfterDownHash?: string | null;
  seededWithData?: boolean;
  findings: { statement: string; severity: Severity; lockType?: string | null; note?: string | null }[];
  preflight: {
    kind: string;
    table: string;
    probeSql?: string | null;
    violations: number | null;
    willFail: boolean | null;
    description: string;
  }[];
  qodo: { verdict: QodoVerdict; summary?: string | null; findings: string[]; raw?: unknown };
  requiresTypedConfirm: boolean;
  expectedConfirmValue?: string | null;
  /** final status to land the request in (awaiting_approval | blocked) */
  status: RequestStatus;
  logs?: string | null;
}

/**
 * Persist a full safety-pipeline result: shadow_run + blast_report + findings +
 * preflight + qodo_review, then update the artifact reversibility, arm the
 * approval gate (typed-confirm), and advance the request status. This is the
 * single write that turns a live pipeline run into everything the Approval
 * Console renders.
 */
export async function persistSafetyReport(input: PersistSafetyInput): Promise<void> {
  // The whole report is one transaction: shadow_run, blast_report, findings,
  // preflight, qodo_review, the artifact update, the gate arming, and the status
  // advance all commit together. A partial failure never leaves the Approval
  // Console rendering half a report.
  await db.transaction(async (tx) => {
  const [artifact] = await tx
    .select({ id: generatedArtifact.id })
    .from(generatedArtifact)
    .where(eq(generatedArtifact.migrationRequestId, input.requestId))
    .orderBy(desc(generatedArtifact.version))
    .limit(1);
  if (!artifact) throw new Error(`persistSafetyReport: no artifact for request ${input.requestId}`);

  const now = new Date();
  const [shadow] = await tx
    .insert(shadowRun)
    .values({
      migrationRequestId: input.requestId,
      generatedArtifactId: artifact.id,
      status: "succeeded",
      seededWithData: input.seededWithData ?? false,
      schemaBeforeHash: input.schemaBeforeHash ?? null,
      schemaAfterUpHash: input.schemaAfterUpHash ?? null,
      schemaAfterDownHash: input.schemaAfterDownHash ?? null,
      rollbackVerified: input.rollbackVerified,
      logs: input.logs ?? null,
      startedAt: now,
      finishedAt: now,
    })
    .returning();

  const tablesTouched = Array.from(new Set(input.preflight.map((p) => p.table).filter(Boolean)));
  const [blast] = await tx
    .insert(blastReport)
    .values({
      shadowRunId: shadow.id,
      overallSeverity: input.overallSeverity,
      tablesTouched,
    })
    .returning();

  if (input.findings.length > 0) {
    await tx.insert(blastFinding).values(
      input.findings.map((f, i) => ({
        blastReportId: blast.id,
        statementIndex: i,
        statementSql: f.statement,
        severity: f.severity,
        lockType: f.lockType ?? null,
        note: f.note ?? null,
      })),
    );
  }

  if (input.preflight.length > 0) {
    await tx.insert(preflightResult).values(
      input.preflight.map((p) => ({
        shadowRunId: shadow.id,
        kind: p.kind as
          | "not_null"
          | "add_notnull_no_default"
          | "unique"
          | "check"
          | "foreign_key"
          | "type_change",
        tableName: p.table,
        probeSql: p.probeSql ?? null,
        violations: p.violations,
        willFail: p.willFail,
        description: p.description,
      })),
    );
  }

  await tx.insert(qodoReview).values({
    generatedArtifactId: artifact.id,
    verdict: input.qodo.verdict,
    summary: input.qodo.summary ?? null,
    findings: input.qodo.findings,
    raw: input.qodo.raw ?? null,
  });

  await tx
    .update(generatedArtifact)
    .set({ reversibility: input.reversibility })
    .where(eq(generatedArtifact.id, artifact.id));

  await tx
    .update(approval)
    .set({
      requiresTypedConfirm: input.requiresTypedConfirm,
      expectedConfirmValue: input.expectedConfirmValue ?? null,
    })
    .where(eq(approval.migrationRequestId, input.requestId));

    await tx
      .update(migrationRequest)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(migrationRequest.id, input.requestId));
  });
}

// ── Apply-run persistence (guarded executor writes these) ─────────────────

export async function insertApplyRun(input: {
  requestId: string;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  rollbackAvailable: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(applyRun)
    .values({
      migrationRequestId: input.requestId,
      status: "running",
      lockTimeoutMs: input.lockTimeoutMs,
      statementTimeoutMs: input.statementTimeoutMs,
      rollbackAvailable: input.rollbackAvailable,
    })
    .returning({ id: applyRun.id });
  return row.id;
}

export async function finishApplyRun(
  id: string,
  input: { status: "succeeded" | "failed"; logs?: string | null; appliedAt?: Date | null; rolledBackAt?: Date | null },
): Promise<void> {
  await db
    .update(applyRun)
    .set({
      status: input.status,
      logs: input.logs ?? null,
      appliedAt: input.appliedAt ?? null,
      rolledBackAt: input.rolledBackAt ?? null,
    })
    .where(eq(applyRun.id, id));
}

// ── Audit ────────────────────────────────────────────────────────────────

function toAuditRow(e: typeof auditEvent.$inferSelect): AuditEventRow {
  return {
    id: e.id,
    at: toIso(e.createdAt),
    actor: e.actor,
    action: e.action,
    requestId: e.migrationRequestId,
    detail: e.detail ?? "",
    tone: (e.tone as "green" | "red" | "info" | "neutral") ?? "neutral",
  };
}

export async function listAuditEvents(
  opts: { limit?: number; offset?: number } = {},
): Promise<AuditEventRow[]> {
  // Bounded + PAGINATED — the audit log grows without limit. A single-page fetch
  // presented as the whole append-only history silently drops older events once
  // it exceeds the cap; the Audit Log page pages through it with countAuditEvents.
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select()
    .from(auditEvent)
    // (created_at, id) is a TOTAL, deterministic order — created_at alone is
    // non-unique, so ties would sort arbitrarily between page requests and make
    // the same event appear twice (or vanish) as the operator pages. The id
    // tiebreaker pins the order so paging is stable.
    .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
    .limit(limit)
    .offset(offset);
  return rows.map(toAuditRow);
}

/** Total number of audit events (for accurate pagination totals). */
export async function countAuditEvents(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(auditEvent);
  return row?.count ?? 0;
}

/** Audit events for ONE request, filtered in SQL and bounded — used by the live
 *  SSE poller so a per-second tick never scans the whole audit table. */
export async function listAuditEventsForRequest(requestId: string, limit = 50): Promise<AuditEventRow[]> {
  const rows = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.migrationRequestId, requestId))
    .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toAuditRow);
}

/** Audit events for ONE request STRICTLY AFTER a (created_at, id) cursor, in
 *  ASCENDING order. The SSE poller pages forward through this so a burst of more
 *  than one page between polls is fully drained rather than losing the older
 *  events that fall outside a newest-N window. */
export async function listAuditEventsForRequestSince(
  requestId: string,
  since: { at: string; id: string } | null,
  limit = 100,
): Promise<AuditEventRow[]> {
  // The cursor `at` came back through JS Date.toISOString() (MILLISECOND
  // precision), but created_at is microsecond-precise. Comparing raw would make an
  // event whose sub-ms > 0 satisfy `created_at > cursor.at` on the very next poll —
  // re-sending it, and a full page sharing one millisecond would stall the drain.
  // So compare (and order) on the MILLISECOND-TRUNCATED timestamp, with id as the
  // deterministic tiebreaker within a millisecond.
  const conds = [eq(auditEvent.migrationRequestId, requestId)];
  if (since) {
    conds.push(
      sql`(date_trunc('milliseconds', ${auditEvent.createdAt}), ${auditEvent.id}) > (${since.at}::timestamptz, ${since.id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(auditEvent)
    .where(and(...conds))
    .orderBy(sql`date_trunc('milliseconds', ${auditEvent.createdAt})`, auditEvent.id) // ascending — forward cursor
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toAuditRow);
}

/** Total number of migration requests MATCHING the same filter as listRequests,
 *  so the displayed total and the paginated rows always agree. */
export async function countRequests(opts: { q?: string; status?: string } = {}): Promise<number> {
  const conds = requestFilterConditions(opts);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(conds.length ? and(...conds) : undefined);
  return row?.count ?? 0;
}

export async function insertAuditEvent(input: {
  migrationRequestId?: string | null;
  actor: string;
  action: string;
  detail?: string;
  tone?: "green" | "red" | "info" | "neutral";
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditEvent).values({
    migrationRequestId: input.migrationRequestId ?? null,
    actor: input.actor,
    action: input.action,
    detail: input.detail ?? null,
    tone: input.tone ?? "neutral",
    payload: input.payload ?? {},
  });
}

// ── Dashboard stats ──────────────────────────────────────────────────────

export interface DashboardStats {
  awaiting: number;
  applied: number;
  blocked: number;
  proven: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const statusCounts = await db
    .select({
      status: migrationRequest.status,
      count: sql<number>`count(*)::int`,
    })
    .from(migrationRequest)
    .groupBy(migrationRequest.status);

  const countMap = new Map(statusCounts.map((r) => [r.status, r.count]));

  const [provenResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shadowRun)
    .where(eq(shadowRun.rollbackVerified, true));

  return {
    awaiting: countMap.get("awaiting_approval") ?? 0,
    applied: countMap.get("applied") ?? 0,
    // "Blocked at gate" means exactly status='blocked' (whole-dataset destruction
    // Sentinel refuses). Human rejections and pipeline/apply failures are NOT
    // gate blocks and must not inflate this metric.
    blocked: countMap.get("blocked") ?? 0,
    proven: provenResult?.count ?? 0,
  };
}

/**
 * Severity distribution across all requests (from blast reports).
 */
export async function getSeverityDistribution(): Promise<{ green: number; amber: number; red: number }> {
  const rows = await db
    .select({
      sev: blastReport.overallSeverity,
      count: sql<number>`count(*)::int`,
    })
    .from(blastReport)
    .groupBy(blastReport.overallSeverity);

  const dist = { green: 0, amber: 0, red: 0 };
  for (const r of rows) {
    if (r.sev === "green" || r.sev === "amber" || r.sev === "red") {
      dist[r.sev] = r.count;
    }
  }
  return dist;
}
