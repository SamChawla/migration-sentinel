import type { RequestStatus } from "@sentinel/core";

export interface FlowStep {
  label: string;
  sub: string;
  tone?: "cyan" | "safe" | "warn" | "gate";
}

export const PIPELINE: FlowStep[] = [
  { label: "Intake", sub: "plain English, SQL, or a PR", tone: "cyan" },
  { label: "Generate", sub: "paired up + down SQL", tone: "cyan" },
  { label: "Qodo review", sub: "advisory code review", tone: "cyan" },
  { label: "Shadow dry-run", sub: "blast radius + rollback proof", tone: "warn" },
  { label: "HUMAN GATE", sub: "you decide — agent cannot", tone: "gate" },
  { label: "Guarded apply", sub: "timeouts, txn, auto-rollback", tone: "safe" },
  { label: "Audit", sub: "append-only record", tone: "safe" },
];

function stageOf(status: RequestStatus): number {
  switch (status) {
    case "received": return 0;
    case "generating": return 1;
    case "reviewing": return 2;
    case "dry_running": return 3;
    case "awaiting_approval": return 4;
    // awaiting_merge is still at the human gate — gate 2 (the GitHub merge)
    // hasn't released the apply yet.
    case "blocked": case "approved": case "rejected": case "awaiting_merge": return 4;
    case "applying": return 5;
    case "applied": case "failed": case "rolled_back": return 6;
  }
}

function toneColor(tone?: string): string {
  if (tone === "gate") return "var(--hold)";
  if (tone === "safe") return "var(--safe)";
  if (tone === "warn") return "var(--warn)";
  return "var(--cyan)";
}

export function PipelineFlow() {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 0, overflowX: "auto", padding: "8px 0" }}>
      {PIPELINE.map((s, i) => (
        <div key={s.label} style={{ flex: 1, minWidth: 92, textAlign: "center", position: "relative" }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%", margin: "0 auto 6px",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: s.tone === "gate" ? "rgba(255,176,32,.12)" : "rgba(124,58,237,.06)",
            border: `2px solid ${toneColor(s.tone)}`,
            boxShadow: s.tone === "gate" ? "0 0 16px rgba(255,176,32,.3)" : undefined,
            animation: s.tone === "gate" ? "pulse 2.2s ease-in-out infinite" : undefined,
            fontSize: 14, color: toneColor(s.tone), fontWeight: 700,
          }}>
            {i + 1}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: s.tone === "gate" ? "var(--hold)" : "var(--text)" }}>{s.label}</div>
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>{s.sub}</div>
          {i < PIPELINE.length - 1 && (
            <div style={{
              position: "absolute", top: 21, left: "calc(50% + 26px)", right: "calc(-50% + 26px)",
              height: 2, background: "var(--line)", zIndex: -1,
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

export function StageTracker({ status }: { status: RequestStatus }) {
  const current = stageOf(status);
  const terminal = ["applied", "rejected", "failed", "rolled_back"].includes(status);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 0, overflowX: "auto" }} aria-label={`Pipeline stage: ${PIPELINE[current].label}`}>
      {PIPELINE.map((s, i) => {
        const done = i < current || (terminal && i <= current);
        const active = !terminal && i === current;
        const color = done ? "var(--safe)" : active ? toneColor(s.tone) : "var(--faint)";
        return (
          <div key={s.label} style={{ flex: 1, minWidth: 68, textAlign: "center", position: "relative" }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", margin: "0 auto 4px",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: done ? "rgba(61,245,160,.1)" : active ? "rgba(124,58,237,.06)" : "transparent",
              border: `2px solid ${color}`, fontSize: 12, fontWeight: 600, color,
              animation: active && s.tone === "gate" ? "pulse 2.2s ease-in-out infinite" : undefined,
              boxShadow: done ? "0 0 8px rgba(61,245,160,.15)" : active && s.tone === "gate" ? "0 0 12px rgba(255,176,32,.2)" : undefined,
            }}>
              {done ? "✓" : i + 1}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 500, color }}>{s.label}</div>
            {i < PIPELINE.length - 1 && (
              <div style={{
                position: "absolute", top: 15, left: "calc(50% + 20px)", right: "calc(-50% + 20px)",
                height: 1.5, background: done ? "var(--safe)" : "var(--line)", zIndex: -1,
                opacity: done ? .5 : 1,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
