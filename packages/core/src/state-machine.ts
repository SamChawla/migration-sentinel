import type { RequestStatus } from "./types";

/**
 * Allowed request-status transitions (see 05-App-Flow §3).
 * A single source of truth so no code path can move a request illegally.
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  received: ["generating", "failed"],
  generating: ["reviewing", "failed"],
  reviewing: ["dry_running", "failed"],
  // A dry-run can conclude that the migration is BLOCKED — it never reaches a
  // gate where a human could approve it.
  dry_running: ["awaiting_approval", "blocked", "failed"],
  awaiting_approval: ["approved", "rejected"],
  // Blocked is a dead end for THIS migration: the operator can close it out
  // (rejected), but it can never be approved/applied.
  blocked: ["rejected"],
  // Gate 2 (PR4): a prod + linked-repo approval EXPORTS the migration as a PR
  // instead of applying — approved → awaiting_merge. A live-verified merge
  // moves it back to approved, from where the one-shot claim takes it.
  approved: ["applying", "awaiting_merge"],
  // Export failure lands failed (the unstrand pattern), never a limbo state.
  awaiting_merge: ["approved", "failed"],
  rejected: [],
  applying: ["applied", "failed"],
  applied: ["rolled_back"],
  // `failed` is reachable from pre-apply states (generating/reviewing/dry_running)
  // where nothing was applied, so it must NOT permit rolled_back — an apply that
  // fails already rolls back inside its own transaction; a manual revert of an
  // APPLIED migration uses applied → rolled_back. The ONE forward edge is an
  // explicit operator RETRY (failed → received), which re-enters intake and
  // re-runs the full analysis pipeline from scratch. Nothing was applied, so
  // re-analyzing is always safe.
  failed: ["received"],
  rolled_back: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal status transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: RequestStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
