/**
 * Real query layer — replaces the in-memory store.ts scaffold.
 *
 * Every function here returns the flat shapes the UI already expects
 * (RequestRecord, AuditEventRow) by JOINing across the normalized tables.
 */
import { eq, asc, desc, sql, and, or, inArray, ilike } from "drizzle-orm";
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
  githubLink,
} from "./schema";
import type {
  RequestStatus,
  Severity,
  Reversibility,
  QodoVerdict,
  ApprovalDecision,
  DbEnvironment,
} from "@sentinel/core";
import { nextEnv } from "@sentinel/core";
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
  environment: DbEnvironment;
  promotionGroupId: string;
  promotedFromRequestId: string | null;
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
  in_flight: ["received", "generating", "reviewing", "dry_running", "approved", "awaiting_merge", "applying"],
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

// Whitelisted sortable columns (server-side, so a sort spans ALL pages). Only
// columns present in the main list query — derived fields (severity, rollback)
// are hydrated per row and are not sortable here.
export const REQUEST_SORTS = {
  created_at: migrationRequest.createdAt,
  title: migrationRequest.title,
  target: targetDatabase.connectionAlias,
  status: migrationRequest.status,
} as const;
export type RequestSort = keyof typeof REQUEST_SORTS;

export async function listRequests(
  opts: { limit?: number; offset?: number; q?: string; status?: string; sort?: string; dir?: "asc" | "desc" } = {},
): Promise<RequestRecord[]> {
  // Bounded by default so the list path can't grow unbounded with history.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const conds = requestFilterConditions(opts);
  const sortCol = REQUEST_SORTS[(opts.sort ?? "") as RequestSort] ?? migrationRequest.createdAt;
  const dirFn = opts.dir === "asc" ? asc : desc;
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .leftJoin(approval, eq(approval.migrationRequestId, migrationRequest.id))
    .where(conds.length ? and(...conds) : undefined)
    // Tiebreak by id so (sort, id) is a TOTAL order — a non-unique sort column
    // alone would let offset paging duplicate/skip rows between page requests.
    .orderBy(dirFn(sortCol), desc(migrationRequest.id))
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
      environment: (target?.environment as DbEnvironment) ?? "dev",
      promotionGroupId: req.promotionGroupId,
      promotedFromRequestId: req.promotedFromRequestId,
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
    environment: (target?.environment as DbEnvironment) ?? "dev",
    promotionGroupId: req.promotionGroupId,
    promotedFromRequestId: req.promotedFromRequestId,
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
  /** GitHub-PR intake — when set the request is a github_pr whose upSql the
   *  SERVER read from the PR at this head SHA (never client-supplied). */
  pr?: { url: string; repo: string; file: string; prNumber: number; headSha: string };
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
    const isPr = Boolean(input.pr);
    const [req] = await tx
      .insert(migrationRequest)
      .values({
        targetDatabaseId: targetId,
        intakeKind: isPr ? "github_pr" : isIntent ? "nl_intent" : "raw_sql",
        intakePayload: isPr
          ? { sql: input.upSql, pr: input.pr }
          : isIntent
            ? { intent: input.intent }
            : { sql: input.upSql },
        title: input.title,
        status: "received",
        requestedBy: input.requestedBy ?? "unknown",
      })
      .returning();

    // Raw SQL / PR-sourced SQL → persist it as the v1 artifact immediately. An
    // nl_intent gets NO artifact here, so runAgentPipeline generates {up,down}.
    if (!isIntent && input.upSql) {
      await tx.insert(generatedArtifact).values({
        migrationRequestId: req.id,
        version: 1,
        upSql: input.upSql,
        downSql: input.downSql,
        reversibility: "reversible",
        model: isPr ? "github-pr" : "user-supplied",
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
  environment: DbEnvironment;
  /** whether a real connection URL is stored (vs. a seeded alias only) */
  hasUrl: boolean;
}

/** All configured target databases — the selectable connections. */
export async function listTargetDatabases(): Promise<TargetDbRow[]> {
  const rows = await db.select().from(targetDatabase).orderBy(targetDatabase.connectionAlias);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    alias: r.connectionAlias,
    environment: r.environment as DbEnvironment,
    hasUrl: Boolean(r.connectionUrl),
  }));
}

/** Add a NEW connection. Refuses to reuse an existing alias — overwriting a
 *  shared target row's URL would retroactively reroute every request that
 *  already references it (including pending/approved migrations). Returns
 *  { ok:false } on a duplicate alias so the caller can 409. The caller is
 *  responsible for having tested connectivity first. */
export async function addTargetConnection(
  input: { alias: string; url: string; environment?: DbEnvironment },
): Promise<{ ok: true; row: TargetDbRow } | { ok: false; reason: "duplicate" }> {
  const existing = await db
    .select({ id: targetDatabase.id })
    .from(targetDatabase)
    .where(eq(targetDatabase.connectionAlias, input.alias))
    .limit(1);
  if (existing.length > 0) return { ok: false, reason: "duplicate" };
  const [row] = await db
    .insert(targetDatabase)
    .values({
      name: input.alias,
      connectionAlias: input.alias,
      connectionUrl: encryptUrl(input.url),
      environment: input.environment ?? "dev",
    })
    .returning();
  return {
    ok: true,
    row: {
      id: row.id,
      name: row.name,
      alias: row.connectionAlias,
      environment: row.environment as DbEnvironment,
      hasUrl: true,
    },
  };
}

/** Resolve a registered connection's stored URL by alias. Distinguishes an
 *  unknown alias (undefined) from a registered-but-URL-less row (null) so the
 *  schema API can answer 404 vs 409 honestly. The URL itself must never be
 *  serialized into any response. */
export async function getTargetUrlByAlias(alias: string): Promise<string | null | undefined> {
  const rows = await db
    .select({ url: targetDatabase.connectionUrl })
    .from(targetDatabase)
    .where(eq(targetDatabase.connectionAlias, alias))
    .limit(1);
  if (rows.length === 0) return undefined;
  return rows[0].url ?? null;
}


/** Update the environment tag on an existing connection. Safe to call on
 *  connections with in-flight requests — the environment only affects NEW
 *  requests' gating rules (typed-confirm, promotion lock). */
export async function updateTargetEnvironment(
  alias: string,
  environment: DbEnvironment,
): Promise<{ ok: true; row: TargetDbRow } | { ok: false; reason: "not_found" }> {
  const rows = await db
    .update(targetDatabase)
    .set({ environment })
    .where(eq(targetDatabase.connectionAlias, alias))
    .returning();
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  const r = rows[0];
  return {
    ok: true,
    row: {
      id: r.id,
      name: r.name,
      alias: r.connectionAlias,
      environment: r.environment as DbEnvironment,
      hasUrl: !!r.connectionUrl,
    },
  };
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

// ── TrueForge apply-gate session (Phase A) ────────────────────────────────

export interface TrueforgeSessionRef {
  sessionId: string;
  threadId: string;
  toolCallId: string;
}

/** Persist the paused tool.approval_required coordinates on the request so the
 *  human decision can resolve the turn later (possibly much later). */
export async function setTrueforgeSession(
  requestId: string,
  ref: TrueforgeSessionRef,
): Promise<void> {
  await db
    .update(migrationRequest)
    .set({
      trueforgeSessionId: ref.sessionId,
      trueforgeThreadId: ref.threadId,
      trueforgeToolCallId: ref.toolCallId,
      updatedAt: new Date(),
    })
    .where(eq(migrationRequest.id, requestId));
}

/** The persisted pause coordinates, or null when no TrueForge session was
 *  opened for this request (deterministic-gate-only fallback). */
export async function getTrueforgeSession(requestId: string): Promise<TrueforgeSessionRef | null> {
  const rows = await db
    .select({
      sessionId: migrationRequest.trueforgeSessionId,
      threadId: migrationRequest.trueforgeThreadId,
      toolCallId: migrationRequest.trueforgeToolCallId,
    })
    .from(migrationRequest)
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  const r = rows[0];
  if (!r?.sessionId || !r.threadId || !r.toolCallId) return null;
  return { sessionId: r.sessionId, threadId: r.threadId, toolCallId: r.toolCallId };
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

/** States a stranded pipeline can sit in — a crash/restart between claim and the
 *  failure handler can leave a request here with no running worker. */
const RETRYABLE_STUCK: RequestStatus[] = ["received", "generating", "reviewing", "dry_running"];

export type RetryOutcome =
  | { ok: true; from: RequestStatus }
  | { ok: false; reason: "not_found" | "not_retryable" | "in_progress" | "apply_stage" };

/**
 * Reset a request so the analysis pipeline can re-run from scratch, then leave it
 * in 'received' for the caller to re-enqueue via runAgentPipeline.
 *
 * Eligibility:
 *  - `failed` → yes, UNLESS the failure happened at the apply stage. A failure
 *    with an apply_run row may have PARTIALLY committed the target (an autocommit
 *    CREATE INDEX CONCURRENTLY, or a lost COMMIT response — apply.ts records both
 *    as 'failed' + "reconciliation required" and does NOT prove a rollback).
 *    Re-analyzing such a request as if the target is untouched is unsafe, so it
 *    needs manual reconciliation, not an auto-retry → `apply_stage`.
 *  - a stuck pre-apply state (received/generating/reviewing/dry_running) → only
 *    when there has been NO activity for `staleMs` (default 5 min), so a genuinely
 *    running pipeline is never yanked out from under itself. "Activity" is the
 *    most recent of the row's updatedAt AND its latest audit event — the pipeline
 *    emits audit events as it works, so they act as a heartbeat that updatedAt
 *    alone (set once at the dry_running transition) misses during the long
 *    shadow/qodo phase. This is still a heuristic; a durable per-run lease is the
 *    robust fix (tracked separately).
 *
 * The reset disarms the approval gate (decision→pending, typed-confirm cleared)
 * AND clears the previous run's TrueForge pause coordinates, so a later
 * approve/reject can never resolve the obsolete pre-retry tool call.
 */
export async function retryRequest(
  requestId: string,
  opts: { staleMs?: number; actor?: string } = {},
): Promise<RetryOutcome> {
  const staleMs = opts.staleMs ?? 5 * 60_000;
  return await db.transaction(async (tx) => {
    const [cur] = await tx
      .select({ status: migrationRequest.status, updatedAt: migrationRequest.updatedAt })
      .from(migrationRequest)
      .where(eq(migrationRequest.id, requestId))
      .for("update")
      .limit(1);
    if (!cur) return { ok: false, reason: "not_found" } as const;

    const status = cur.status as RequestStatus;
    const isFailed = status === "failed";
    const isStuck = RETRYABLE_STUCK.includes(status);
    if (!isFailed && !isStuck) return { ok: false, reason: "not_retryable" } as const;

    // A failure that reached the apply stage (has an apply_run) may have changed
    // the target — refuse the auto-retry; it needs manual reconciliation.
    if (isFailed) {
      const [ar] = await tx
        .select({ id: applyRun.id })
        .from(applyRun)
        .where(eq(applyRun.migrationRequestId, requestId))
        .limit(1);
      if (ar) return { ok: false, reason: "apply_stage" } as const;
    }

    if (isStuck) {
      const [lastEv] = await tx
        .select({ at: auditEvent.createdAt })
        .from(auditEvent)
        .where(eq(auditEvent.migrationRequestId, requestId))
        .orderBy(desc(auditEvent.createdAt))
        .limit(1);
      const lastActivity = Math.max(cur.updatedAt?.getTime() ?? 0, lastEv?.at?.getTime() ?? 0);
      if (Date.now() - lastActivity < staleMs) return { ok: false, reason: "in_progress" } as const;
    }

    // Conditional flip guarded on the OBSERVED status (the FOR UPDATE lock holds
    // it, but keep the guard so the intent is explicit and the UPDATE is a no-op
    // if anything slipped past). Also drop the stale TrueForge coordinates.
    const moved = await tx
      .update(migrationRequest)
      .set({
        status: "received",
        updatedAt: new Date(),
        trueforgeSessionId: null,
        trueforgeThreadId: null,
        trueforgeToolCallId: null,
      })
      .where(and(eq(migrationRequest.id, requestId), eq(migrationRequest.status, status)))
      .returning({ id: migrationRequest.id });
    if (moved.length !== 1) return { ok: false, reason: "in_progress" } as const;

    await tx
      .update(approval)
      .set({ decision: "pending", approver: null, decidedAt: null, requiresTypedConfirm: false, expectedConfirmValue: null })
      .where(eq(approval.migrationRequestId, requestId));

    await tx.insert(auditEvent).values({
      migrationRequestId: requestId,
      actor: opts.actor ?? "unknown",
      action: "request.retried",
      detail: `Retry requested from '${status}' — re-running the full analysis pipeline.`,
      tone: "info",
      payload: { fromStatus: status },
    });

    return { ok: true, from: status } as const;
  });
}

// ── Promotion (environment ladder) ───────────────────────────────────────

export interface PromotionGroupRow {
  requestId: string;
  environment: DbEnvironment;
  status: RequestStatus;
  targetAlias: string;
  upSql: string | null;
  createdAt: string;
}

/** Every request in a promotion group, with its target env and latest upSql —
 *  feeds both the PromotionRail UI and `promotionEligible`. */
export async function getPromotionGroup(promotionGroupId: string): Promise<PromotionGroupRow[]> {
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.promotionGroupId, promotionGroupId))
    .orderBy(asc(migrationRequest.createdAt), asc(migrationRequest.id));
  return Promise.all(
    rows.map(async (row) => {
      const artifact = await getLatestArtifact(row.migration_request.id);
      return {
        requestId: row.migration_request.id,
        environment: (row.target_database?.environment as DbEnvironment) ?? "dev",
        status: row.migration_request.status as RequestStatus,
        targetAlias:
          row.target_database?.connectionAlias ?? row.target_database?.name ?? "unknown",
        upSql: artifact?.upSql ?? null,
        createdAt: toIso(row.migration_request.createdAt),
      };
    }),
  );
}

/** The environment of a request's target connection (null for unknown request). */
export async function getRequestEnvironment(requestId: string): Promise<DbEnvironment | null> {
  const rows = await db
    .select({ environment: targetDatabase.environment })
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  if (rows.length === 0) return null;
  return (rows[0].environment as DbEnvironment) ?? "dev";
}

export interface ApplyGuardContext {
  environment: DbEnvironment;
  upSql: string | null;
  siblings: { environment: DbEnvironment; status: RequestStatus; upSql: string | null }[];
}

/** Everything `promotionEligible` needs, from the DB only (no network): the
 *  request's env + latest upSql, and its promotion-group siblings. */
export async function getApplyGuardContext(requestId: string): Promise<ApplyGuardContext | null> {
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const [artifact, group] = await Promise.all([
    getLatestArtifact(requestId),
    getPromotionGroup(row.migration_request.promotionGroupId),
  ]);
  return {
    environment: (row.target_database?.environment as DbEnvironment) ?? "dev",
    upSql: artifact?.upSql ?? null,
    siblings: group
      .filter((g) => g.requestId !== requestId)
      .map((g) => ({ environment: g.environment, status: g.status, upSql: g.upSql })),
  };
}

export type PromoteFailure =
  | "not_found"
  | "no_artifact"
  | "at_top"
  | "no_connection"
  | "already_promoted";

/**
 * Clone a request one rung up the environment ladder: same promotion_group_id,
 * the source's LATEST artifact SQL as the new v1 artifact, targeting a
 * registered next-env connection (a specific alias, or the first next-env
 * connection with a stored URL). The clone starts at 'received' with a fresh
 * pending approval — the full pipeline re-runs against the new target.
 */
export async function createPromotedRequest(input: {
  sourceRequestId: string;
  requestedBy: string;
  targetAlias?: string;
}): Promise<{ ok: true; id: string; environment: DbEnvironment } | { ok: false; reason: PromoteFailure }> {
  const sourceRows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.id, input.sourceRequestId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) return { ok: false, reason: "not_found" };

  const artifact = await getLatestArtifact(input.sourceRequestId);
  if (!artifact || !artifact.upSql.trim()) return { ok: false, reason: "no_artifact" };

  const sourceEnv = (source.target_database?.environment as DbEnvironment) ?? "dev";
  const targetEnv = nextEnv(sourceEnv);
  if (!targetEnv) return { ok: false, reason: "at_top" };

  // Resolve the next-env connection. A URL-less row is not eligible — the
  // clone would be un-runnable (same footgun as the intake alias check).
  const candidates = await db
    .select()
    .from(targetDatabase)
    .where(eq(targetDatabase.environment, targetEnv))
    .orderBy(targetDatabase.connectionAlias);
  const target = input.targetAlias
    ? candidates.find((c) => c.connectionAlias === input.targetAlias && c.connectionUrl)
    : candidates.find((c) => c.connectionUrl);
  if (!target) return { ok: false, reason: "no_connection" };

  const newId = await db.transaction(async (tx) => {
    // Lock the source row to serialize concurrent promotions of the same request.
    await tx.execute(sql`SELECT id FROM migration_request WHERE id = ${source.migration_request.id} FOR UPDATE`);

    const existing = await tx
      .select({ id: migrationRequest.id })
      .from(migrationRequest)
      .where(
        and(
          eq(migrationRequest.promotedFromRequestId, source.migration_request.id),
          eq(migrationRequest.targetDatabaseId, target.id),
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;

    const [req] = await tx
      .insert(migrationRequest)
      .values({
        targetDatabaseId: target.id,
        intakeKind: "raw_sql",
        intakePayload: { sql: artifact.upSql },
        title: source.migration_request.title,
        status: "received",
        requestedBy: input.requestedBy,
        promotionGroupId: source.migration_request.promotionGroupId,
        promotedFromRequestId: source.migration_request.id,
      })
      .returning();

    await tx.insert(generatedArtifact).values({
      migrationRequestId: req.id,
      version: 1,
      upSql: artifact.upSql,
      downSql: artifact.downSql,
      reversibility: "reversible",
      model: "promotion",
    });

    await tx.insert(approval).values({
      migrationRequestId: req.id,
      decision: "pending",
      requiresTypedConfirm: false,
    });

    await tx.insert(auditEvent).values({
      migrationRequestId: req.id,
      actor: input.requestedBy,
      action: "request.promoted",
      detail: `Promoted from ${sourceEnv} (${source.target_database?.connectionAlias ?? "?"}) to ${targetEnv} (${target.connectionAlias}).`,
      tone: "info",
      payload: { sourceRequestId: input.sourceRequestId, fromEnv: sourceEnv, toEnv: targetEnv },
    });

    return req.id;
  });

  if (!newId) return { ok: false, reason: "already_promoted" };
  return { ok: true, id: newId, environment: targetEnv };
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

// ── GitHub link (PR3) ────────────────────────────────────────────────────

export interface GithubLinkRow {
  id: string;
  migrationRequestId: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  filePath: string;
  prTitle: string | null;
  prState: string | null;
  headSha: string | null;
  checksState: string | null;
  htmlUrl: string | null;
  lastSyncedAt: string | null;
  commentId: number | null;
  // export gate (PR4)
  exportBranch: string | null;
  exportPrNumber: number | null;
  exportPrUrl: string | null;
  exportPrState: string | null;
  exportMergedAt: string | null;
}

function toGithubLinkRow(r: typeof githubLink.$inferSelect): GithubLinkRow {
  return {
    id: r.id,
    migrationRequestId: r.migrationRequestId,
    repo: r.repo,
    prNumber: r.prNumber,
    commitSha: r.commitSha,
    filePath: r.filePath,
    prTitle: r.prTitle,
    prState: r.prState,
    headSha: r.headSha,
    checksState: r.checksState,
    htmlUrl: r.htmlUrl,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    commentId: r.commentId,
    exportBranch: r.exportBranch,
    exportPrNumber: r.exportPrNumber,
    exportPrUrl: r.exportPrUrl,
    exportPrState: r.exportPrState,
    exportMergedAt: r.exportMergedAt ? r.exportMergedAt.toISOString() : null,
  };
}

/** Record the opened export PR (gate 2) on the link. */
export async function recordExportPr(
  requestId: string,
  input: { branch: string; prNumber: number; prUrl: string },
): Promise<void> {
  await db
    .update(githubLink)
    .set({
      exportBranch: input.branch,
      exportPrNumber: input.prNumber,
      exportPrUrl: input.prUrl,
      exportPrState: "open",
    })
    .where(eq(githubLink.migrationRequestId, requestId));
}

/** Persist a LIVE-verified merge of the export PR. */
export async function markExportMerged(requestId: string): Promise<void> {
  await db
    .update(githubLink)
    .set({ exportPrState: "merged", exportMergedAt: new Date() })
    .where(eq(githubLink.migrationRequestId, requestId));
}

/**
 * Guarded status transition used by the export gate: flip `from` → `to` only
 * when the request is still in `from` (single conditional UPDATE, same
 * one-shot discipline as claimRequestForApply). Returns whether it moved.
 */
export async function transitionRequestStatus(
  requestId: string,
  from: RequestStatus,
  to: RequestStatus,
): Promise<boolean> {
  const rows = await db
    .update(migrationRequest)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(migrationRequest.id, requestId), eq(migrationRequest.status, from)))
    .returning({ id: migrationRequest.id });
  return rows.length === 1;
}

export async function createGithubLink(input: {
  migrationRequestId: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  filePath: string;
  prTitle?: string | null;
  prState?: string | null;
  headSha?: string | null;
  checksState?: string | null;
  htmlUrl?: string | null;
}): Promise<GithubLinkRow> {
  const [row] = await db
    .insert(githubLink)
    .values({
      migrationRequestId: input.migrationRequestId,
      repo: input.repo,
      prNumber: input.prNumber,
      commitSha: input.commitSha,
      filePath: input.filePath,
      prTitle: input.prTitle ?? null,
      prState: input.prState ?? null,
      headSha: input.headSha ?? null,
      checksState: input.checksState ?? null,
      htmlUrl: input.htmlUrl ?? null,
      lastSyncedAt: new Date(),
    })
    .returning();
  return toGithubLinkRow(row);
}

export async function getGithubLink(requestId: string): Promise<GithubLinkRow | null> {
  const rows = await db
    .select()
    .from(githubLink)
    .where(eq(githubLink.migrationRequestId, requestId))
    .limit(1);
  return rows[0] ? toGithubLinkRow(rows[0]) : null;
}

/** Refresh the cached PR metadata after a live GitHub read. */
export async function updateGithubLinkSync(
  requestId: string,
  sync: {
    prTitle?: string | null;
    prState?: string | null;
    headSha?: string | null;
    checksState?: string | null;
    htmlUrl?: string | null;
  },
): Promise<void> {
  await db
    .update(githubLink)
    .set({ ...sync, lastSyncedAt: new Date() })
    .where(eq(githubLink.migrationRequestId, requestId));
}

export async function setGithubLinkCommentId(requestId: string, commentId: number): Promise<void> {
  await db
    .update(githubLink)
    .set({ commentId })
    .where(eq(githubLink.migrationRequestId, requestId));
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

/** The most recent failure detail for a request — surfaced on the failed banner so
 *  the operator sees WHY the pipeline failed (pg_dump/shadow connectivity, the SQL,
 *  the model, …), not just that it did. Matches the *.failed audit actions the
 *  pipeline/apply write (pipeline.failed, apply.failed, github.link_failed). */
export async function getLatestFailureDetail(requestId: string): Promise<string | null> {
  const rows = await db
    .select({ detail: auditEvent.detail })
    .from(auditEvent)
    .where(and(eq(auditEvent.migrationRequestId, requestId), ilike(auditEvent.action, "%failed%")))
    .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
    .limit(1);
  return rows[0]?.detail ?? null;
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
