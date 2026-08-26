"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface CommitConsoleProps {
  requestId: string;
  requiresTypedConfirm: boolean;
  expectedConfirm?: string;
  /** Sentinel refuses to apply — whole-dataset destruction, no recovery path. */
  blocked?: boolean;
}

export function CommitConsole({ requestId, requiresTypedConfirm, expectedConfirm, blocked }: CommitConsoleProps) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canApprove = !blocked && (!requiresTypedConfirm || typed === expectedConfirm);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, decision, typedConfirm: typed }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Server returned ${res.status}`);
      }
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Decision failed.");
      return;
    }
    setBusy(false);
    router.refresh();
  }

  // ── BLOCKED: Sentinel will not apply. The operator can only close it out. ──
  if (blocked) {
    return (
      <div className="glass glass-danger" style={{ marginTop: 16 }}>
        <div className="hud-label">Commit console</div>
        <div className="sev-tag" style={{ marginTop: 10, marginBottom: 8, background: "var(--danger)", color: "#fff" }}>
          ⛔ BLOCKED — Sentinel will not apply this
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.5, margin: "0 0 4px" }}>
          This migration destroys the entire dataset with no recovery path. Approval cannot override it —
          the gate refuses the apply regardless of decision. The remedy is a <b>bounded or reversible
          replacement migration</b> (add a <code>WHERE</code>, soft-delete, or a two-phase change).
        </p>
        {error && <div className="inline-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
          <button className="btn btn-metal" disabled={busy} onClick={() => decide("rejected")} style={{ flex: 1 }}>
            {busy ? "CLOSING..." : "CLOSE OUT (REJECT)"}
          </button>
          <button className="btn btn-apply" disabled title="A blocked migration cannot be applied." style={{ flex: 1, opacity: 0.4, cursor: "not-allowed" }}>
            APPLY DISABLED
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass" style={{ marginTop: 16 }}>
      <div className="hud-label">Commit console</div>

      {requiresTypedConfirm && (
        <div style={{ marginTop: 10 }}>
          <div className="sev-tag" style={{ marginBottom: 10 }}>
            IRREVERSIBLE — type &ldquo;{expectedConfirm}&rdquo; to unlock
          </div>
          <label className="lbl" htmlFor="typed-confirm">
            Confirmation token
          </label>
          <input
            id="typed-confirm"
            className={`confirm-input ${typed ? (typed === expectedConfirm ? "valid" : "invalid") : ""}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={expectedConfirm}
            autoComplete="off"
          />
        </div>
      )}

      {error && <div className="inline-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}

      <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
        <button className="btn btn-metal" disabled={busy} onClick={() => decide("rejected")}>
          ABORT
        </button>
        <button className="btn btn-apply" disabled={busy || !canApprove} onClick={() => decide("approved")} style={{ flex: 1 }}>
          {busy ? "APPLYING..." : "ARM & APPLY"}
        </button>
      </div>
    </div>
  );
}
