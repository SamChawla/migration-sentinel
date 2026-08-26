/**
 * SCAFFOLD data layer — in-memory store so the UI runs before the DB is wired.
 * Phase 1 replaces this with @sentinel/db (Drizzle). The shapes mirror
 * 04-DB-Schema so the swap is mechanical.
 */
import type { RequestStatus, Severity, Reversibility } from "@sentinel/core";

export interface Finding {
  statement: string;
  severity: Severity;
  lockType?: string;
  note: string;
}
export interface RequestRecord {
  id: string;
  title: string;
  targetDb: string;
  status: RequestStatus;
  requestedBy: string;
  createdAt: string;
  decidedBy?: string;
  upSql: string;
  downSql: string;
  overallSeverity: Severity;
  reversibility: Reversibility;
  rollbackVerified: boolean;
  rowsAffected: number | null;
  estLockMs: number | null;
  findings: Finding[];
  qodoVerdict: "passed" | "passed_with_warnings" | "failed" | "skipped";
  qodoFindings: string[];
  approval: { decision: "pending" | "approved" | "rejected"; requiresTypedConfirm: boolean; expectedConfirm?: string };
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  requestId?: string;
  detail: string;
  tone: "green" | "red" | "info" | "neutral";
}

const now = () => new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const seed: RequestRecord[] = [
  {
    id: "req_demo_drop",
    title: "Drop legacy_notes from users",
    targetDb: "prod-orders-db",
    status: "awaiting_approval",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(1),
    upSql: "ALTER TABLE public.users DROP COLUMN legacy_notes;",
    downSql: "-- NO CLEAN ROLLBACK\nALTER TABLE public.users ADD COLUMN legacy_notes text;\n-- data NOT restored",
    overallSeverity: "red",
    reversibility: "irreversible",
    rollbackVerified: false,
    rowsAffected: 1204338,
    estLockMs: 14000,
    findings: [
      { statement: "ALTER TABLE users DROP COLUMN legacy_notes", severity: "red", lockType: "AccessExclusiveLock", note: "Drops a column — data unrecoverable." },
    ],
    qodoVerdict: "passed_with_warnings",
    qodoFindings: ["Consider a two-phase drop (stop writing, then drop next release)."],
    approval: { decision: "pending", requiresTypedConfirm: true, expectedConfirm: "users" },
  },
  {
    id: "req_demo_add",
    title: "Add last_login_at to users",
    targetDb: "prod-orders-db",
    status: "awaiting_approval",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(2),
    upSql: "ALTER TABLE public.users ADD COLUMN last_login_at timestamptz;",
    downSql: "ALTER TABLE public.users DROP COLUMN last_login_at;",
    overallSeverity: "green",
    reversibility: "reversible",
    rollbackVerified: true,
    rowsAffected: 0,
    estLockMs: 5,
    findings: [
      { statement: "ALTER TABLE users ADD COLUMN last_login_at timestamptz", severity: "green", note: "Metadata-only in Postgres 11+." },
    ],
    qodoVerdict: "passed",
    qodoFindings: [],
    approval: { decision: "pending", requiresTypedConfirm: false },
  },
  {
    id: "req_hist_index",
    title: "Index orders(created_at) CONCURRENTLY",
    targetDb: "prod-orders-db",
    status: "applied",
    requestedBy: "priya@acme.io",
    createdAt: hoursAgo(26),
    decidedBy: "sam.chawla26@gmail.com",
    upSql: "CREATE INDEX CONCURRENTLY idx_orders_created_at ON public.orders (created_at);",
    downSql: "DROP INDEX CONCURRENTLY IF EXISTS idx_orders_created_at;",
    overallSeverity: "green",
    reversibility: "reversible",
    rollbackVerified: true,
    rowsAffected: 0,
    estLockMs: 12,
    findings: [
      { statement: "CREATE INDEX CONCURRENTLY", severity: "green", note: "Non-blocking index build." },
    ],
    qodoVerdict: "passed",
    qodoFindings: [],
    approval: { decision: "approved", requiresTypedConfirm: false },
  },
  {
    id: "req_hist_notnull",
    title: "Backfill full_name and SET NOT NULL",
    targetDb: "prod-orders-db",
    status: "applied",
    requestedBy: "wei@acme.io",
    createdAt: hoursAgo(49),
    decidedBy: "sam.chawla26@gmail.com",
    upSql: "UPDATE public.users SET full_name = 'unknown' WHERE full_name IS NULL;\nALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;",
    downSql: "ALTER TABLE public.users ALTER COLUMN full_name DROP NOT NULL;",
    overallSeverity: "amber",
    reversibility: "reversible",
    rollbackVerified: true,
    rowsAffected: 33121,
    estLockMs: 800,
    findings: [
      { statement: "UPDATE … WHERE full_name IS NULL", severity: "amber", note: "Bounded backfill of 33k rows before constraint." },
      { statement: "SET NOT NULL", severity: "amber", lockType: "AccessExclusiveLock", note: "Brief exclusive lock; pre-flight verified 0 violations." },
    ],
    qodoVerdict: "passed_with_warnings",
    qodoFindings: ["Prefer NOT VALID → VALIDATE for very large tables."],
    approval: { decision: "approved", requiresTypedConfirm: false },
  },
  {
    id: "req_hist_deactivate",
    title: "Deactivate all users (unbounded UPDATE)",
    targetDb: "prod-orders-db",
    status: "rejected",
    requestedBy: "dev@acme.io",
    createdAt: hoursAgo(72),
    decidedBy: "sam.chawla26@gmail.com",
    upSql: "UPDATE public.users SET is_active = false;",
    downSql: "-- cannot restore previous per-row values",
    overallSeverity: "red",
    reversibility: "irreversible",
    rollbackVerified: false,
    rowsAffected: 50000,
    estLockMs: 22000,
    findings: [
      { statement: "UPDATE public.users SET is_active = false", severity: "red", note: "Unbounded UPDATE — no WHERE clause; prior values unrecoverable." },
    ],
    qodoVerdict: "failed",
    qodoFindings: ["Unbounded UPDATE with no WHERE clause.", "No reversible down migration possible."],
    approval: { decision: "rejected", requiresTypedConfirm: true, expectedConfirm: "users" },
  },
  {
    id: "req_hist_widen",
    title: "Widen orders.amount to numeric(12,2)",
    targetDb: "staging-orders-db",
    status: "dry_running",
    requestedBy: "priya@acme.io",
    createdAt: hoursAgo(0.4),
    upSql: "ALTER TABLE public.orders ALTER COLUMN amount TYPE numeric(12,2);",
    downSql: "ALTER TABLE public.orders ALTER COLUMN amount TYPE numeric(10,2);",
    overallSeverity: "amber",
    reversibility: "reversible",
    rollbackVerified: false,
    rowsAffected: null,
    estLockMs: null,
    findings: [],
    qodoVerdict: "skipped",
    qodoFindings: [],
    approval: { decision: "pending", requiresTypedConfirm: false },
  },
];

const auditSeed: AuditEvent[] = [
  { id: "ev_9", at: hoursAgo(0.4), actor: "agent", action: "shadow.dry_run.started", requestId: "req_hist_widen", detail: "Shadow provisioned; running up→down on schema-only clone.", tone: "info" },
  { id: "ev_8", at: hoursAgo(1), actor: "agent", action: "gate.paused", requestId: "req_demo_drop", detail: "RED verdict — irreversible DROP COLUMN. Awaiting human approval (typed confirm required).", tone: "red" },
  { id: "ev_7", at: hoursAgo(2), actor: "agent", action: "gate.paused", requestId: "req_demo_add", detail: "GREEN verdict — rollback proven on shadow. Awaiting approval.", tone: "info" },
  { id: "ev_6", at: hoursAgo(25.5), actor: "sam.chawla26@gmail.com", action: "apply.succeeded", requestId: "req_hist_index", detail: "Applied with lock_timeout=2s in 480 ms. Audit row written.", tone: "green" },
  { id: "ev_5", at: hoursAgo(26), actor: "sam.chawla26@gmail.com", action: "approval.approved", requestId: "req_hist_index", detail: "Approved — non-blocking CONCURRENTLY build.", tone: "green" },
  { id: "ev_4", at: hoursAgo(48), actor: "sam.chawla26@gmail.com", action: "apply.succeeded", requestId: "req_hist_notnull", detail: "Backfill (33,121 rows) + SET NOT NULL applied; pre-flight re-probe showed 0 violations.", tone: "green" },
  { id: "ev_3", at: hoursAgo(49), actor: "agent", action: "preflight.blocked_then_fixed", requestId: "req_hist_notnull", detail: "33,121 NULL rows would fail SET NOT NULL — backfill value requested and two-phase migration regenerated.", tone: "info" },
  { id: "ev_2", at: hoursAgo(71), actor: "sam.chawla26@gmail.com", action: "approval.rejected", requestId: "req_hist_deactivate", detail: "Rejected — unbounded UPDATE, prior values unrecoverable.", tone: "red" },
  { id: "ev_1", at: hoursAgo(72), actor: "agent", action: "gate.paused", requestId: "req_hist_deactivate", detail: "RED verdict — data-mutating statement with no rollback.", tone: "red" },
];

// module-level singleton (fine for scaffold/dev)
const g = globalThis as unknown as { __sentinel?: RequestRecord[]; __sentinelAudit?: AuditEvent[] };
g.__sentinel ??= seed;
g.__sentinelAudit ??= auditSeed;
export const store = g.__sentinel;
export const auditLog = g.__sentinelAudit;

export const listRequests = () => store;
export const listAudit = () => auditLog;
export const getRequest = (id: string) => store.find((r) => r.id === id) ?? null;
export function createRequest(input: { title: string; targetDb: string; upSql: string; downSql: string }): RequestRecord {
  const rec: RequestRecord = {
    id: `req_${Math.floor(Number(process.hrtime.bigint() % 1000000n))}`,
    title: input.title,
    targetDb: input.targetDb,
    status: "received",
    requestedBy: "sam.chawla26@gmail.com",
    createdAt: now(),
    upSql: input.upSql,
    downSql: input.downSql,
    overallSeverity: "amber",
    reversibility: "lossy",
    rollbackVerified: false,
    rowsAffected: null,
    estLockMs: null,
    findings: [],
    qodoVerdict: "skipped",
    qodoFindings: [],
    approval: { decision: "pending", requiresTypedConfirm: false },
  };
  store.unshift(rec);
  auditLog.unshift({ id: `ev_${rec.id}`, at: now(), actor: rec.requestedBy, action: "request.created", requestId: rec.id, detail: `"${rec.title}" submitted to the agent.`, tone: "neutral" });
  return rec;
}
export const _touch = now;
