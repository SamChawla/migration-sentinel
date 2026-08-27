/**
 * Pre-recorded migration run for Demo mode (/demo).
 *
 * Replays a real end-to-end run of the `drop_legacy_notes` fixture step by step
 * with NO live agent / model / database. This is the fallback for a live demo:
 * if TrueForge, the network, or the model misbehaves, the story still lands.
 *
 * Each step is one stage of the pipeline (05-App-Flow). The /demo page advances
 * through them (auto-play or manual).
 */
export interface DemoStep {
  phase: string;
  status: string;
  title: string;
  detail: string;
  /** optional payload rendered when present */
  up?: string;
  down?: string;
  qodo?: { verdict: string; findings: string[] };
  blast?: { overallSeverity: "green" | "amber" | "red"; rowsAffected: number; estLockMs: number; rollbackVerified: boolean; findings: { severity: "green" | "amber" | "red"; note: string; lockType?: string }[] };
  gate?: { requiresTypedConfirm: boolean; confirmWord?: string };
}

export const DEMO_STEPS: DemoStep[] = [
  {
    phase: "Intake",
    status: "received",
    title: "Developer submits an intent",
    detail: '"Drop the legacy_notes column from the users table — we stopped using it."',
  },
  {
    phase: "Generate",
    status: "generating",
    title: "Agent reads the schema (read-only) and writes up + down",
    detail: "The agent proposes a paired migration. It flags up-front that the down cannot restore data.",
    up: "ALTER TABLE public.users DROP COLUMN legacy_notes;",
    down: "-- NO CLEAN ROLLBACK\nALTER TABLE public.users ADD COLUMN legacy_notes text;\n-- prior values are NOT recoverable",
  },
  {
    phase: "Review",
    status: "reviewing",
    title: "Qodo reviews the generated SQL",
    detail: "Advisory review; findings shown at the gate.",
    qodo: { verdict: "passed_with_warnings", findings: ["Consider a two-phase drop: stop writing this release, drop the next."] },
  },
  {
    phase: "Dry-run",
    status: "dry_running",
    title: "Shadow dry-run + blast radius",
    detail: "Schema-only shadow: the SCHEMA restores, but DROP COLUMN destroys data no down can recover — rollback is NOT proven (irreversible). Row/lock estimates come from the target's planner statistics (no data copied).",
    blast: {
      overallSeverity: "red",
      rowsAffected: 1204338,
      estLockMs: 14000,
      rollbackVerified: false,
      findings: [
        { severity: "red", note: "Drops a column — column data is unrecoverable.", lockType: "AccessExclusiveLock" },
      ],
    },
  },
  {
    phase: "Gate",
    status: "awaiting_approval",
    title: "⏸ Agent paused — human gate open",
    detail: "The apply_migration tool is approval-required. The turn is paused. Nothing has touched production.",
    gate: { requiresTypedConfirm: true, confirmWord: "users" },
  },
  {
    phase: "Decision",
    status: "approved",
    title: "Approver types “users” and approves",
    detail: "The control plane records an approved, audited decision, then resumes the paused turn (user.tool_approval → allow).",
  },
  {
    phase: "Apply",
    status: "applied",
    title: "Guarded apply → done",
    detail: "Applied inside a transaction with lock_timeout + statement_timeout; audit event written. One-click rollback available (schema only).",
  },
];
