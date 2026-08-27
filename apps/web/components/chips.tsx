import type { Severity } from "@sentinel/core";

const ICON: Record<Severity, string> = { green: "✓", amber: "▲", red: "⛔" };
const CLS: Record<Severity, string> = { green: "sev-green", amber: "sev-amber", red: "sev-red" };
const LABEL: Record<Severity, string> = { green: "Reversible", amber: "Caution", red: "Irreversible" };

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <span className={`sev-chip ${CLS[severity]}`}>
      {ICON[severity]} {LABEL[severity]}
    </span>
  );
}

function statusClass(status: string): string {
  if (status === "awaiting_approval") return "s-awaiting";
  if (status === "applied") return "s-applied";
  if (status === "blocked" || status === "rejected" || status === "failed" || status === "rolled_back") return "s-rejected";
  if (["generating", "reviewing", "dry_running", "applying"].includes(status)) return "s-running";
  return "s-pending";
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`status-chip ${statusClass(status)}`}>
      <span className="dot" />
      {status.replace(/_/g, " ")}
    </span>
  );
}
