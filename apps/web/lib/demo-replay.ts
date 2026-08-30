/**
 * Pre-recorded migration run for Demo mode (/demo).
 *
 * Replays the v2 pipeline end-to-end: GitHub PR intake → staging dry-run →
 * staging apply → promotion to prod → prod dry-run → approval gate →
 * export PR → merge-verified release.
 *
 * Each step is one stage of the pipeline. The /demo page advances through them
 * (auto-play or manual). NO live agent / model / database needed.
 */
export interface DemoStep {
  phase: string;
  status: string;
  title: string;
  detail: string;
  env?: "staging" | "prod";
  up?: string;
  down?: string;
  qodo?: { verdict: string; findings: string[] };
  blast?: { overallSeverity: "green" | "amber" | "red"; rowsAffected: number; estLockMs: number; rollbackVerified: boolean; findings: { severity: "green" | "amber" | "red"; note: string; lockType?: string }[] };
  gate?: { requiresTypedConfirm: boolean; confirmWord?: string };
  prInfo?: { repo: string; prNumber: number; file: string; title: string };
  promotion?: { from: string; to: string };
  exportPr?: { repo: string; branch: string; prNumber: number; state: string };
}

export const DEMO_STEPS: DemoStep[] = [
  // ── Phase 1: GitHub PR Intake ──────────────────────────────────────────
  {
    phase: "PR Intake",
    status: "received",
    title: "Migration arrives via GitHub PR",
    detail: "A developer opens a pull request adding a migration file. Sentinel detects it, extracts the SQL, and starts the pipeline — no manual submission needed.",
    prInfo: { repo: "acme/orders-api", prNumber: 42, file: "migrations/0005_idx_orders_status.sql", title: "Add status index for order dashboards" },
    up: "CREATE INDEX CONCURRENTLY idx_orders_status\n  ON public.orders (status);",
    down: "DROP INDEX CONCURRENTLY IF EXISTS idx_orders_status;",
  },
  // ── Phase 2: Staging Dry-run ───────────────────────────────────────────
  {
    phase: "Staging Dry-run",
    status: "dry_running",
    title: "Shadow dry-run on staging",
    detail: "Sentinel provisions a schema-only shadow of the staging database, applies up → down, and verifies the rollback restores the schema. Blast radius is computed from the planner statistics.",
    env: "staging",
    blast: {
      overallSeverity: "green",
      rowsAffected: 0,
      estLockMs: 8,
      rollbackVerified: true,
      findings: [
        { severity: "green", note: "Non-blocking CONCURRENTLY build — no table lock." },
      ],
    },
  },
  // ── Phase 3: Qodo Review ───────────────────────────────────────────────
  {
    phase: "Code Review",
    status: "reviewing",
    title: "Qodo reviews the migration SQL",
    detail: "Automated code review validates syntax, patterns, and risks. Findings travel with the migration through the promotion ladder.",
    qodo: { verdict: "passed", findings: [] },
  },
  // ── Phase 4: Staging Gate + Apply ──────────────────────────────────────
  {
    phase: "Staging Apply",
    status: "applied",
    title: "GREEN verdict — auto-applied on staging",
    detail: "Green severity + rollback proven → the staging gate opens automatically. Applied with lock_timeout=3s, statement_timeout=30s. Audit event recorded.",
    env: "staging",
  },
  // ── Phase 5: Promotion ─────────────────────────────────────────────────
  {
    phase: "Promote",
    status: "promoted",
    title: "Promoted: staging → prod",
    detail: "Staging run succeeded and rollback was proven. The migration is promoted to the production environment — same SQL, higher gate. The promotion rail is now unlocked.",
    env: "prod",
    promotion: { from: "staging", to: "prod" },
  },
  // ── Phase 6: Prod Dry-run ──────────────────────────────────────────────
  {
    phase: "Prod Dry-run",
    status: "dry_running",
    title: "Shadow dry-run on prod schema",
    detail: "A fresh shadow of the production schema is provisioned. The same up → down cycle runs. Blast radius is re-computed against prod statistics — row counts and locks may differ from staging.",
    env: "prod",
    blast: {
      overallSeverity: "green",
      rowsAffected: 0,
      estLockMs: 12,
      rollbackVerified: true,
      findings: [
        { severity: "green", note: "Non-blocking CONCURRENTLY build — no table lock." },
      ],
    },
  },
  // ── Phase 7: Prod Approval Gate ────────────────────────────────────────
  {
    phase: "Approval Gate",
    status: "awaiting_approval",
    title: "Gate 1 — human approval required for prod",
    detail: "Even GREEN migrations pause at the prod gate. The agent is paused — no production changes have been made. An operator reviews the blast report, findings, and promotion history before deciding.",
    env: "prod",
  },
  // ── Phase 8: Approved ──────────────────────────────────────────────────
  {
    phase: "Approved",
    status: "approved",
    title: "Operator approves the prod migration",
    detail: "The approval is audited. For production targets with a linked repository, the migration flows to the export gate instead of applying directly — no out-of-band changes to the source of truth.",
    env: "prod",
  },
  // ── Phase 9: Export PR ─────────────────────────────────────────────────
  {
    phase: "Export Gate",
    status: "awaiting_merge",
    title: "Gate 2 — export PR opened on the source repo",
    detail: "Sentinel opens a pull request on acme/orders-api with the approved migration SQL. The migration is NOT applied yet — it waits for the PR to be merged, keeping the repository as the source of truth.",
    env: "prod",
    exportPr: { repo: "acme/orders-api", branch: "sentinel/migration-0005", prNumber: 43, state: "open" },
  },
  // ── Phase 10: Merge-verified Apply ─────────────────────────────────────
  {
    phase: "Apply",
    status: "applied",
    title: "PR merged → guarded apply on prod",
    detail: "The export PR is merged. Sentinel verifies the merge, applies the migration with lock_timeout=3s and statement_timeout=30s, and writes the audit trail. The full provenance chain is preserved: PR intake → staging → promotion → approval → export PR → merge → apply.",
    env: "prod",
  },
];
