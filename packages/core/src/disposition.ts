import type { Severity } from "./types";

/**
 * Gate disposition — the deterministic POLICY decision (ADR-004).
 *
 * The AI proposes; this function disposes. Given the machine-computed signals
 * (severity, whether a whole-dataset destruction is present, whether a data
 * pre-flight will fail or could not be proven), it decides what the human is
 * ALLOWED to do at the gate. The model never chooses this — it is pure policy.
 *
 *   auto          — green & recoverable; safe to approve normally.
 *   approval      — amber; a human approves, no typed confirmation.
 *   typed_confirm — red-but-recoverable, a scoped irreversible loss, or a data
 *                   check that will/ can't-be-proven — the operator types an
 *                   exact confirmation to assume responsibility.
 *   blocked       — whole-dataset destruction with no recovery path. Sentinel
 *                   REFUSES to apply it. Not even human approval overrides this;
 *                   the remedy is a bounded/reversible replacement migration.
 */
export type GateDisposition = "auto" | "approval" | "typed_confirm" | "blocked";

export interface DispositionInput {
  severity: Severity;
  /** a `blocking` statement is present (see @sentinel/shadow classifier). */
  hasBlockingStatement: boolean;
  /** a data pre-flight probe found existing rows that WILL fail the migration. */
  dataWillFail: boolean;
  /**
   * a required data probe could not be evaluated — no auto-probe could be
   * derived, or the probe timed out on a large table. We could not PROVE the
   * data is safe, so we escalate rather than assume success.
   */
  dataUnknown?: boolean;
}

export function gateDisposition(i: DispositionInput): GateDisposition {
  if (i.hasBlockingStatement) return "blocked";
  if (i.severity === "red" || i.dataWillFail) return "typed_confirm";
  if (i.dataUnknown) return "typed_confirm";
  if (i.severity === "amber") return "approval";
  return "auto";
}

export function dispositionRequiresTypedConfirm(d: GateDisposition): boolean {
  return d === "typed_confirm";
}

export function dispositionBlocks(d: GateDisposition): boolean {
  return d === "blocked";
}

/** Short, human-facing label for the gate UI. */
export function dispositionLabel(d: GateDisposition): string {
  switch (d) {
    case "auto":
      return "SAFE";
    case "approval":
      return "APPROVAL REQUIRED";
    case "typed_confirm":
      return "HIGH RISK — TYPED CONFIRMATION";
    case "blocked":
      return "BLOCKED";
  }
}
