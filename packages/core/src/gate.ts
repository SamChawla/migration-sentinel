import type { ApprovalDecision } from "./types";

/**
 * The independent approval gate (ADR-004).
 *
 * This is the second, defense-in-depth check that runs in the control plane
 * BEFORE any prod-affecting apply — regardless of what the agent believes.
 * The apply executor must call `assertApproved()` and it must throw unless a
 * real, approved approval row exists.
 */
export interface ApprovalRecord {
  decision: ApprovalDecision;
  requiresTypedConfirm: boolean;
  typedConfirmValue?: string | null;
  expectedConfirmValue?: string | null;
  /**
   * TRUE when the migration is BLOCKED (whole-dataset destruction with no
   * recovery path). A blocked apply is refused here regardless of the decision
   * — the model cannot self-approve AND a human cannot override it. The remedy
   * is a bounded/reversible replacement migration, not an approval.
   */
  blocked?: boolean;
}

export class GateError extends Error {}

export function assertApproved(approval: ApprovalRecord | null | undefined): void {
  if (!approval) throw new GateError("No approval record exists for this request.");
  if (approval.blocked) {
    throw new GateError(
      "Apply refused: this migration is BLOCKED (irreversible whole-dataset destruction with no recovery path). Approval cannot override it — author a bounded or reversible replacement migration.",
    );
  }
  if (approval.decision !== "approved") {
    throw new GateError(`Apply blocked: approval decision is '${approval?.decision ?? "missing"}'.`);
  }
  if (approval.requiresTypedConfirm) {
    if (
      !approval.expectedConfirmValue ||
      approval.typedConfirmValue !== approval.expectedConfirmValue
    ) {
      throw new GateError("Irreversible action requires an exact typed confirmation.");
    }
  }
}
