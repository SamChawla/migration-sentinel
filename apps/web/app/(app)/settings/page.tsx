import { Client } from "pg";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Redact any password (userinfo or query param) before showing a connection URL. */
function redact(url: string | undefined): string {
  if (!url) return "not configured";
  return url
    .replace(/(:\/\/[^:/@]+):[^@]*@/, "$1:***@")
    .replace(/([?&](?:password|sslpassword|passfile)=)[^&\s]*/gi, "$1***");
}

/** Real availability probe — a quick connect + SELECT 1 with a short timeout. */
async function probeDb(url: string | undefined): Promise<"green" | "red" | undefined> {
  if (!url) return undefined;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.query("SELECT 1");
    return "green";
  } catch {
    return "red";
  } finally {
    await c.end().catch(() => {});
  }
}

/** Liveness probe for an HTTP service (the TrueForge harness). Any response —
 *  even a 404 — means reachable; a network error/timeout means down. */
async function probeHttp(url: string | undefined): Promise<"green" | "red" | undefined> {
  if (!url) return undefined;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) });
    return "green";
  } catch {
    return "red";
  }
}

/** Positive-int env read matching the guarded-apply defaults in apply.ts. */
function posIntEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Never render a secret's value — show *** when it is set, "not configured"
 *  otherwise. The env var NAME is not a value and must never be shown as one. */
function secretState(name: string): { value: string; tone?: string } {
  return process.env[name]?.trim()
    ? { value: "***", tone: "green" }
    : { value: "not configured" };
}

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

  // Read the ACTUAL configured databases + probe them, instead of hard-coding
  // localhost strings and an unconditional green.
  const targetUrl = process.env.TARGET_DB_URL;
  const shadowUrl = process.env.SHADOW_ADMIN_URL;
  const sentinelUrl = process.env.DATABASE_URL;
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
  const [targetTone, shadowTone, sentinelTone, trueforgeTone] = await Promise.all([
    probeDb(targetUrl),
    probeDb(shadowUrl),
    probeDb(sentinelUrl),
    probeHttp(trueforgeUrl),
  ]);
  // Secrets are shown as *** (set) / "not configured" — never their raw value.
  const qodo = secretState("QODO_API_KEY");
  const github = secretState("GITHUB_TOKEN");

  // Real apply guards — same env + defaults the executor (apply.ts) uses.
  const lockMs = posIntEnv("APPLY_LOCK_TIMEOUT_MS", 3000);
  const stmtMs = posIntEnv("APPLY_STATEMENT_TIMEOUT_MS", 30000);
  const connMs = posIntEnv("APPLY_CONNECT_TIMEOUT_MS", 10000);
  const applyGuardsTone = targetTone === "red" ? "red" : "green";
  const euronKey = Boolean(process.env.EURON_API_KEY?.trim());
  const euronModel = process.env.EURON_MODEL?.trim() || "gpt-4.1-nano";
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
        <Row label="Target (prod)" value={redact(targetUrl)} tone={targetTone} />
        <Row label="Shadow (ephemeral)" value={redact(shadowUrl)} tone={shadowTone} />
        <Row label="Sentinel (control plane)" value={redact(sentinelUrl)} tone={sentinelTone} />
      </div>

      <div className="glass" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Integrations</h3>
        <Row
          label="TrueForge harness"
          value={trueforgeTone === "green" ? trueforgeUrl : `${trueforgeUrl} · unreachable`}
          tone={trueforgeTone === "green" ? "green" : "amber"}
        />
        <Row
          label="Copilot (Euron · BYOK)"
          value={euronKey ? `${euronModel} · read-only` : "not configured"}
          tone={euronKey ? "green" : undefined}
        />
        <Row label="Qodo review" value={qodo.value} tone={qodo.tone} />
        <Row label="GitHub PR intake" value={github.value} tone={github.tone} />
      </div>

      <div className="glass">
        <h3 className="section-title">Safety policy</h3>
        <Row label="RED severity" value="typed confirmation required" tone="red" />
        <Row
          label="Apply guards"
          value={`lock_timeout=${lockMs / 1000}s · statement_timeout=${stmtMs / 1000}s · connect_timeout=${connMs / 1000}s`}
          tone={applyGuardsTone}
        />
        <Row label="Gate enforcement" value="assertApproved() — independent of agent" tone="green" />
      </div>
    </>
  );
}
