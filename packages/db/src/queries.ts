/**
 * Real query layer — replaces the in-memory store.ts scaffold.
 *
 * Every function here returns the flat shapes the UI already expects
 * (RequestRecord, AuditEventRow) by JOINing across the normalized tables.
 */
import { eq, desc, sql, and } from "drizzle-orm";
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
export async function listRequests(): Promise<RequestRecord[]> {
  const rows = await db
    .select()
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .leftJoin(approval, eq(approval.migrationRequestId, migrationRequest.id))
    .orderBy(desc(migrationRequest.createdAt));

  const records: RequestRecord[] = [];

  for (const row of rows) {
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

    let qodoRow: typeof qodoReview.$inferSelect | null = null;
    if (artifact) {
      qodoRow = await db
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

    records.push({
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
    });
  }

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

    const [req] = await tx
      .insert(migrationRequest)
      .values({
        targetDatabaseId: targetId,
        intakeKind: "raw_sql",
        intakePayload: { sql: input.upSql },
        title: input.title,
        status: "received",
        requestedBy: input.requestedBy ?? "unknown",
      })
      .returning();

    if (input.upSql) {
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
}): Promise<void> {
  // Typed-confirm is NOT recorded here — it is verified at the gate by
  // assertApproved() (core/gate.ts) before this is ever called. Recording the
  // decision + status is atomic so they can never disagree.
  await db.transaction(async (tx) => {
    await tx
      .update(approval)
      .set({
        decision: input.decision,
        approver: input.approver,
        decidedAt: new Date(),
      })
      .where(eq(approval.migrationRequestId, input.requestId));

    // Approved → 'approved' (NOT 'applied'). The guarded apply executor owns the
    // transition to 'applying'/'applied'/'failed' once it has actually run the UP
    // against the target. Rejected is terminal here.
    const newStatus = input.decision === "approved" ? "approved" : "rejected";
    await tx
      .update(migrationRequest)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(migrationRequest.id, input.requestId));
  });
}

/**
 * Reset approval to pending (used when the gate check fails). Reverts BOTH the
 * approval decision and the request status back to awaiting_approval so a
 * rejected gate check never leaves the request looking approved.
 */
export async function resetApproval(requestId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(approval)
      .set({ decision: "pending", approver: null, decidedAt: null })
      .where(eq(approval.migrationRequestId, requestId));
    await tx
      .update(migrationRequest)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(migrationRequest.id, requestId));
  });
}

// ── Pipeline persistence (agent orchestrator writes these) ────────────────

/** Resolve the connection URL for a request's target DB.
 *  Prefers the stored per-target URL; falls back to $TARGET_DB_URL (single-target
 *  hackathon default). Read + write use the same URL here; a production build
 *  would hand back distinct read-only vs write credentials. */
export async function getRequestTargetUrl(requestId: string): Promise<string | null> {
  const rows = await db
    .select({ url: targetDatabase.connectionUrl })
    .from(migrationRequest)
    .leftJoin(targetDatabase, eq(migrationRequest.targetDatabaseId, targetDatabase.id))
    .where(eq(migrationRequest.id, requestId))
    .limit(1);
  return rows[0]?.url ?? process.env.TARGET_DB_URL ?? null;
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

export async function listAuditEvents(): Promise<AuditEventRow[]> {
  const rows = await db
    .select()
    .from(auditEvent)
    .orderBy(desc(auditEvent.createdAt));

  return rows.map((e) => ({
    id: e.id,
    at: toIso(e.createdAt),
    actor: e.actor,
    action: e.action,
    requestId: e.migrationRequestId,
    detail: e.detail ?? "",
    tone: (e.tone as "green" | "red" | "info" | "neutral") ?? "neutral",
  }));
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
    blocked: (countMap.get("blocked") ?? 0) + (countMap.get("rejected") ?? 0) + (countMap.get("failed") ?? 0),
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
