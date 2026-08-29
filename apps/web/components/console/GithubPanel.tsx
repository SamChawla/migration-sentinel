"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export interface GithubLinkView {
  repo: string;
  prNumber: number;
  commitSha: string;
  filePath: string;
  prTitle: string | null;
  prState: string | null;
  headSha: string | null;
  checksState: string | null;
  htmlUrl: string | null;
  lastSyncedAt: string | null;
  commentId: number | null;
  exportBranch: string | null;
  exportPrNumber: number | null;
  exportPrUrl: string | null;
  exportPrState: string | null;
  exportMergedAt: string | null;
}

const CHECK_COLOR: Record<string, string> = {
  success: "var(--safe)",
  failure: "var(--danger)",
  pending: "var(--warn)",
  none: "var(--faint)",
};

/**
 * The request's tie to its source-of-truth PR (PR3): chips for title / state /
 * head SHA / checks, a live Refresh, and "Post verdict" which writes (or
 * idempotently updates) the Sentinel safety comment on the PR.
 */
export function GithubPanel({
  requestId,
  link: initial,
  status,
  requiresTypedConfirm = false,
  expectedConfirm,
}: {
  requestId: string;
  link: GithubLinkView;
  /** The request's status — drives the export/apply view (awaiting_merge). */
  status?: string;
  /** Whether the gate demands a typed confirmation to release the apply. */
  requiresTypedConfirm?: boolean;
  expectedConfirm?: string | null;
}) {
  const router = useRouter();
  const [link, setLink] = useState(initial);
  const [busy, setBusy] = useState<"refresh" | "comment" | "apply" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");

  async function refresh() {
    setBusy("refresh");
    setNotice(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/github/refresh`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setLink(data.link);
      setNotice({ tone: "ok", text: "PR metadata refreshed." });
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "Refresh failed." });
    } finally {
      setBusy(null);
    }
  }

  async function postVerdict() {
    setBusy("comment");
    setNotice(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/github/comment`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setLink((cur) => ({ ...cur, commentId: data.commentId }));
      setNotice({ tone: "ok", text: `Verdict ${link.commentId ? "updated" : "posted"} on the PR (comment ${data.commentId}).` });
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "Posting the verdict failed." });
    } finally {
      setBusy(null);
    }
  }

  async function applyNow() {
    setBusy("apply");
    setNotice(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requiresTypedConfirm ? { typedConfirm: confirm } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setNotice({ tone: "ok", text: "Merge verified live — migration applied." });
      router.refresh();
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "Apply failed." });
    } finally {
      setBusy(null);
    }
  }

  const state = link.prState ?? "unknown";
  const checks = link.checksState ?? "none";
  const hasExport = link.exportPrNumber != null;
  const exportMerged = link.exportPrState === "merged";
  const awaitingMerge = status === "awaiting_merge";

  return (
    <div className="glass" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h3 className="section-title" style={{ margin: 0 }}>GitHub PR</h3>
        <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>
          {link.lastSyncedAt ? `synced ${new Date(link.lastSyncedAt).toLocaleTimeString()}` : "not synced"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {link.htmlUrl ? (
            <a href={link.htmlUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
              {link.repo}#{link.prNumber}
            </a>
          ) : (
            <span className="mono" style={{ fontWeight: 600 }}>{link.repo}#{link.prNumber}</span>
          )}
          <span className={`sev-chip ${state === "merged" ? "sev-green" : state === "closed" ? "sev-red" : "sev-amber"}`} style={{ fontSize: 10 }}>
            {state}
          </span>
        </div>
        {link.prTitle && <div style={{ color: "var(--text-dim)" }}>{link.prTitle}</div>}
        <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span>{link.filePath}</span>
          <span>@ {(link.headSha ?? link.commitSha).slice(0, 8)}</span>
          <span style={{ color: CHECK_COLOR[checks] ?? "var(--faint)" }}>checks: {checks}</span>
        </div>
      </div>

      {/* Export gate view (PR4) — the gate-2 PR Sentinel opened on approval. */}
      {hasExport && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
            <span className="hud-label" style={{ margin: 0 }}>Export PR</span>
            {link.exportPrUrl ? (
              <a href={link.exportPrUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                #{link.exportPrNumber}
              </a>
            ) : (
              <span className="mono">#{link.exportPrNumber}</span>
            )}
            <span className={`sev-chip ${exportMerged ? "sev-green" : "sev-amber"}`} style={{ fontSize: 10 }}>
              {link.exportPrState ?? "open"}
            </span>
            {link.exportBranch && (
              <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{link.exportBranch}</span>
            )}
          </div>
          {awaitingMerge && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {!exportMerged && (
                <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>
                  A human merges this PR on GitHub (gate 2) — then Refresh, and Apply unlocks.
                  The server re-verifies the merge live before anything runs.
                </p>
              )}
              {requiresTypedConfirm && exportMerged && (
                <input
                  className="field field-mono"
                  aria-label="Typed confirmation"
                  placeholder={expectedConfirm ? `Type "${expectedConfirm}" to confirm` : "Typed confirmation"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
              <div>
                <button
                  type="button"
                  className="btn btn-cyan btn-sm"
                  disabled={busy !== null || !exportMerged || (requiresTypedConfirm && !confirm.trim())}
                  title={exportMerged ? undefined : "Unlocks once the export PR is merged (use Refresh after merging)"}
                  onClick={applyNow}
                >
                  {busy === "apply" ? "Verifying merge…" : "Apply now"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={refresh}>
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" className="btn btn-cyan btn-sm" disabled={busy !== null} onClick={postVerdict}>
          {busy === "comment" ? "Posting…" : link.commentId ? "Update verdict on PR" : "Post verdict to PR"}
        </button>
      </div>
      {notice && (
        <div
          role={notice.tone === "err" ? "alert" : "status"}
          className={notice.tone === "err" ? "inline-error" : undefined}
          style={{ marginTop: 8, fontSize: 12, ...(notice.tone === "ok" ? { color: "var(--safe)" } : {}) }}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
