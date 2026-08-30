"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Permanently delete a migration request and everything hanging off it. Guarded
 * by a confirm; the server refuses while an apply is mid-flight and re-checks
 * the session. `redirectTo` sends the user somewhere after a delete from a
 * detail page; without it (e.g. a list row) the current view just refreshes.
 */
export function DeleteRequestButton({
  requestId,
  title,
  size = "md",
  label = "Delete",
  redirectTo,
}: {
  requestId: string;
  title?: string;
  size?: "sm" | "md";
  label?: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const what = title ? `"${title}"` : "this migration request";
    if (!window.confirm(`Delete ${what}? This removes its analysis, runs, and gate record permanently. The audit trail is kept.`)) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/requests/${requestId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className={`btn btn-danger ${size === "sm" ? "btn-sm" : ""}`}
        disabled={busy}
        onClick={remove}
        title="Permanently delete this migration request (audit trail is kept)"
      >
        {busy ? "Deleting…" : label}
      </button>
      {error && <span className="inline-error" role="alert" style={{ fontSize: 11 }}>{error}</span>}
    </span>
  );
}
