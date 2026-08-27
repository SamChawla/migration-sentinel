interface StatReadoutProps {
  label: string;
  value: string;
  tone?: "danger" | "safe" | "warn" | "cyan";
  hero?: boolean;
}

export function StatReadout({ label, value, tone, hero }: StatReadoutProps) {
  return (
    <div className={`readout ${hero ? "readout-hero" : "readout-sm"} ${tone ? `readout-${tone}` : ""}`}>
      <div className="hud-label">{label}</div>
      <div className="readout-value">{value}</div>
    </div>
  );
}

interface EnergyProgressBarProps {
  phases: string[];
  currentIndex: number;
  percent: number;
}

export function EnergyProgressBar({ phases, currentIndex, percent }: EnergyProgressBarProps) {
  return (
    <div className="energy-bar">
      <div className="energy-phases">
        {phases.map((p, i) => (
          <span key={p} className={i < currentIndex ? "done" : i === currentIndex ? "current" : ""}>
            {i === currentIndex ? `◆ ${p}` : p}
          </span>
        ))}
      </div>
      <div className="energy-track">
        <div className="energy-fill" style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
      </div>
    </div>
  );
}
