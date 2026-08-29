/**
 * Drizzle schema for the control-plane state store (04-DB-Schema).
 * This is our OWN database — not the target DB being migrated.
 */
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── enums ────────────────────────────────────────────────────────────────
export const requestStatus = pgEnum("request_status", [
  "received", "generating", "reviewing", "dry_running",
  "awaiting_approval", "blocked", "approved", "rejected",
  "applying", "applied", "rolled_back", "failed",
]);
export const intakeKind = pgEnum("intake_kind", ["nl_intent", "raw_sql", "github_pr"]);
export const reversibility = pgEnum("reversibility", ["reversible", "lossy", "irreversible"]);
export const severity = pgEnum("severity", ["green", "amber", "red"]);
export const runStatus = pgEnum("run_status", ["pending", "running", "succeeded", "failed"]);
export const qodoVerdict = pgEnum("qodo_verdict", ["passed", "passed_with_warnings", "failed", "skipped"]);
export const approvalDecision = pgEnum("approval_decision", ["pending", "approved", "rejected"]);
export const auditTone = pgEnum("audit_tone", ["green", "red", "info", "neutral"]);
export const preflightKind = pgEnum("preflight_kind", [
  "not_null", "add_notnull_no_default", "unique", "check", "foreign_key", "type_change",
]);

// ── target_database ──────────────────────────────────────────────────────
export const targetDatabase = pgTable("target_database", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  engine: text("engine").notNull().default("postgres"),
  connectionAlias: text("connection_alias").notNull(),
  connectionUrl: text("connection_url"),
  schemaFingerprint: text("schema_fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── migration_request (spine) ─────────────────────────────────────────────
export const migrationRequest = pgTable(
  "migration_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetDatabaseId: uuid("target_database_id").notNull().references(() => targetDatabase.id),
    intakeKind: intakeKind("intake_kind").notNull(),
    intakePayload: jsonb("intake_payload").notNull(),
    title: text("title").notNull(),
    status: requestStatus("status").notNull().default("received"),
    requestedBy: text("requested_by").notNull(),
    // TrueForge apply-gate leg (Phase A): coordinates of the paused
    // tool.approval_required turn, so the human decision can resolve it across
    // an arbitrarily long approval delay. Null = no session opened (fallback:
    // the deterministic core gate governs alone).
    trueforgeSessionId: text("trueforge_session_id"),
    trueforgeThreadId: text("trueforge_thread_id"),
    trueforgeToolCallId: text("trueforge_tool_call_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("migration_request_status_idx").on(t.status),
    targetIdx: index("migration_request_target_idx").on(t.targetDatabaseId),
    createdAtIdx: index("migration_request_created_at_idx").on(t.createdAt),
  }),
);

// ── generated_artifact ─────────────────────────────────────────────────────
export const generatedArtifact = pgTable(
  "generated_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationRequestId: uuid("migration_request_id").notNull().references(() => migrationRequest.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    upSql: text("up_sql").notNull(),
    downSql: text("down_sql").notNull(),
    reversibility: reversibility("reversibility").notNull(),
    plainSummary: text("plain_summary"),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex("generated_artifact_req_version_uq").on(t.migrationRequestId, t.version),
  }),
);

// ── qodo_review ────────────────────────────────────────────────────────────
export const qodoReview = pgTable(
  "qodo_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generatedArtifactId: uuid("generated_artifact_id").notNull().references(() => generatedArtifact.id, { onDelete: "cascade" }),
    verdict: qodoVerdict("verdict").notNull(),
    summary: text("summary"),
    findings: jsonb("findings").notNull().default([]),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    artifactIdx: index("qodo_review_artifact_idx").on(t.generatedArtifactId),
  }),
);

// ── shadow_run ─────────────────────────────────────────────────────────────
export const shadowRun = pgTable(
  "shadow_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationRequestId: uuid("migration_request_id").notNull().references(() => migrationRequest.id, { onDelete: "cascade" }),
    generatedArtifactId: uuid("generated_artifact_id").notNull().references(() => generatedArtifact.id),
    status: runStatus("status").notNull().default("pending"),
    shadowRef: text("shadow_ref"),
    seededWithData: boolean("seeded_with_data").notNull().default(false),
    schemaBeforeHash: text("schema_before_hash"),
    schemaAfterUpHash: text("schema_after_up_hash"),
    schemaAfterDownHash: text("schema_after_down_hash"),
    rollbackVerified: boolean("rollback_verified"),
    logs: text("logs"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reqIdx: index("shadow_run_request_idx").on(t.migrationRequestId),
    statusIdx: index("shadow_run_status_idx").on(t.status),
  }),
);

// ── blast_report + blast_finding ───────────────────────────────────────────
export const blastReport = pgTable(
  "blast_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowRunId: uuid("shadow_run_id").notNull().references(() => shadowRun.id, { onDelete: "cascade" }),
    overallSeverity: severity("overall_severity").notNull(),
    totalRowsAffected: bigint("total_rows_affected", { mode: "number" }),
    estLockMs: bigint("est_lock_ms", { mode: "number" }),
    estDowntimeMs: bigint("est_downtime_ms", { mode: "number" }),
    tablesTouched: jsonb("tables_touched").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shadowIdx: index("blast_report_shadow_idx").on(t.shadowRunId),
  }),
);

export const blastFinding = pgTable(
  "blast_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blastReportId: uuid("blast_report_id").notNull().references(() => blastReport.id, { onDelete: "cascade" }),
    statementIndex: integer("statement_index").notNull(),
    statementSql: text("statement_sql").notNull(),
    severity: severity("severity").notNull(),
    lockType: text("lock_type"),
    rowsAffected: bigint("rows_affected", { mode: "number" }),
    explainJson: jsonb("explain_json"),
    note: text("note"),
  },
  (t) => ({
    reportIdx: index("blast_finding_report_idx").on(t.blastReportId),
    severityIdx: index("blast_finding_severity_idx").on(t.severity),
  }),
);

// ── preflight_result (ADR-011) ────────────────────────────────────────────
export const preflightResult = pgTable(
  "preflight_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowRunId: uuid("shadow_run_id").notNull().references(() => shadowRun.id, { onDelete: "cascade" }),
    kind: preflightKind("kind").notNull(),
    tableName: text("table_name").notNull(),
    probeSql: text("probe_sql"),
    violations: integer("violations"),
    willFail: boolean("will_fail"),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shadowIdx: index("preflight_result_shadow_idx").on(t.shadowRunId),
  }),
);

// ── approval (the gate record) ─────────────────────────────────────────────
export const approval = pgTable(
  "approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationRequestId: uuid("migration_request_id").notNull().references(() => migrationRequest.id, { onDelete: "cascade" }),
    decision: approvalDecision("decision").notNull().default("pending"),
    approver: text("approver"),
    comment: text("comment"),
    requiresTypedConfirm: boolean("requires_typed_confirm").notNull().default(false),
    expectedConfirmValue: text("expected_confirm_value"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneGate: uniqueIndex("approval_request_uq").on(t.migrationRequestId),
    decisionIdx: index("approval_decision_idx").on(t.decision),
  }),
);

// ── apply_run ──────────────────────────────────────────────────────────────
export const applyRun = pgTable(
  "apply_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationRequestId: uuid("migration_request_id").notNull().references(() => migrationRequest.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("pending"),
    lockTimeoutMs: integer("lock_timeout_ms").notNull().default(3000),
    statementTimeoutMs: integer("statement_timeout_ms").notNull().default(30000),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    rollbackAvailable: boolean("rollback_available").notNull().default(true),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    logs: text("logs"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reqIdx: index("apply_run_request_idx").on(t.migrationRequestId),
    statusIdx: index("apply_run_status_idx").on(t.status),
  }),
);

// ── audit_event (append-only) ──────────────────────────────────────────────
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationRequestId: uuid("migration_request_id").references(() => migrationRequest.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: text("detail"),
    tone: auditTone("tone").notNull().default("neutral"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reqTimeIdx: index("audit_event_req_time_idx").on(t.migrationRequestId, t.createdAt),
    createdAtIdx: index("audit_event_created_at_idx").on(t.createdAt),
  }),
);
