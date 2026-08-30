"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Retry a failed or stranded migration request — resets it to 'received' and
 * re-runs the full analysis pipeline. Rendered only for statuses the server will
 * accept (failed, or a stuck pre-apply state); the server re-checks eligibility.
 */
export function RetryButton({
  requestId,
  size = "md",
  label = "Retry analysis",
}: {
  requestId: string;
  size?: "sm" | "md";
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/requests/${requestId}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className={`btn btn-cyan ${size === "sm" ? "btn-sm" : ""}`}
        disabled={busy}
        onClick={retry}
        title="Reset to received and re-run the full analysis pipeline"
      >
        {busy ? "Retrying…" : `↻ ${label}`}
      </button>
      {error && <span className="inline-error" role="alert" style={{ fontSize: 11 }}>{error}</span>}
    </span>
  );
}
