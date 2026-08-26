import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="health-row">
      <span style={{ minWidth: 170, color: "var(--muted)", fontSize: 13 }}>{label}</span>
      <span className="mono" style={{ fontSize: 12 }}>{value}</span>
      {tone && <span className={`sev-chip sev-${tone}`} style={{ marginLeft: "auto", fontSize: 11 }}>
        {tone === "green" ? "✓" : tone === "amber" ? "▲" : tone === "red" ? "⛔" : ""} {tone}
      </span>}
    </div>
  );
}

export default async function Settings() {
  const session = await getSession();
  const user = session?.user ?? "approver";
  const initials =
    user
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "A";
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            Workspace configuration. Secrets live in <span className="mono">.env</span>.
          </p>
        </div>
      </div>

      <div className="glass" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Profile</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="rail-user" style={{ width: 44, height: 44, fontSize: 15 }}>{initials}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{user}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Signed in as approver</div>
          </div>
          <span className="sev-chip sev-green" style={{ marginLeft: "auto", fontSize: 12 }}>✓ Approver</span>
        </div>
        <p style={{ fontSize: 12, color: "var(--faint)", margin: "10px 0 0" }}>
          Single-approver mode (hackathon). Approvals recorded in the append-only audit log.
        </p>
      </div>

      <div className="glass" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Database connections</h3>
        <Row label="Target (prod)" value="postgres://…@localhost:5433/prod" tone="green" />
        <Row label="Shadow (ephemeral)" value="postgres://…@localhost:5434" />
        <Row label="Sentinel (control plane)" value="postgres://…@localhost:5435/sentinel" />
      </div>

      <div className="glass" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Integrations</h3>
        <Row label="TrueForge harness" value="http://localhost:8790" tone="amber" />
        <Row label="Qodo review" value="QODO_API_KEY" />
        <Row label="GitHub PR intake" value="GITHUB_TOKEN" />
      </div>

      <div className="glass">
        <h3 className="section-title">Safety policy</h3>
        <Row label="RED severity" value="typed confirmation required" tone="red" />
        <Row label="Apply guards" value="lock_timeout=2s · statement_timeout=30s" tone="green" />
        <Row label="Gate enforcement" value="assertApproved() — independent of agent" tone="green" />
      </div>
    </>
  );
}
