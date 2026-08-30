/**
 * A migration cannot be deleted while a background worker is actively running
 * against it: the analysis pipeline (received → generating → reviewing →
 * dry_running) and the guarded apply (applying) both keep executing and writing
 * after the request row would be cascaded away. Deleting mid-flight orphans that
 * work. Every OTHER state is at rest (paused at the gate, awaiting a merge, or
 * terminal) and is safe to delete.
 *
 * The server re-checks this authoritatively under a row lock; this shared set
 * also drives the UI so a delete affordance never appears for an unsafe state.
 */
export const UNDELETABLE_STATUSES: readonly string[] = [
  "received",
  "generating",
  "reviewing",
  "dry_running",
  "applying",
];

export function isDeletableStatus(status: string): boolean {
  return !UNDELETABLE_STATUSES.includes(status);
}
