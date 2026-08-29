"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DbPicker } from "@/components/DbPicker";
import { SchemaBrowser } from "@/components/SchemaBrowser";

type Mode = "github" | "sql" | "intent";

interface PrFileRow {
  filename: string;
  status: string;
  sha: string;
}
interface PrLookup {
  pr: { number: number; title: string; state: string; headSha: string; htmlUrl: string; checksState: string };
  sqlFiles: PrFileRow[];
}

export default function NewRequest() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [targetDb, setTargetDb] = useState("");
  const [mode, setMode] = useState<Mode>("github");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── GitHub tab state ──
  const [tokenMissing, setTokenMissing] = useState<boolean | null>(null);
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [lookup, setLookup] = useState<PrLookup | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [filePath, setFilePath] = useState("");

  // Probe whether the PR intake is available (server-side token). A param-less
  // call answers 409 github_token_missing when unset, 400 when configured.
  useEffect(() => {
    fetch("/api/github/pr")
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        setTokenMissing(r.status === 409 && data.code === "github_token_missing");
      })
      .catch(() => setTokenMissing(null));
  }, []);
  useEffect(() => {
    if (tokenMissing && mode === "github") setMode("sql");
  }, [tokenMissing, mode]);

  async function loadPr() {
    setError(null);
    setLookup(null);
    setFilePath("");
    setLookupBusy(true);
    try {
      const res = await fetch(
        `/api/github/pr?repo=${encodeURIComponent(repo.trim())}&number=${encodeURIComponent(prNumber.trim())}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setLookup(data as PrLookup);
      if ((data as PrLookup).sqlFiles.length === 1) setFilePath((data as PrLookup).sqlFiles[0].filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the PR.");
    } finally {
      setLookupBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // The three intakes stay DISTINCT: NL is generated (never executed as
      // SQL); PR SQL is re-read server-side at the head SHA (nothing the
      // client sends is trusted as the migration).
      const body =
        mode === "github"
          ? { intakeKind: "github_pr", title, targetDb, repo: repo.trim(), prNumber: Number(prNumber), filePath }
          : mode === "intent"
            ? { title, targetDb, intent: text }
            : { title, targetDb, upSql: text, downSql: "" };
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `Server returned ${res.status}`);
      }
      const { id } = await res.json();
      router.push(`/requests/${id}`);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const submittable =
    Boolean(targetDb) &&
    (mode === "github" ? Boolean(lookup && filePath) : Boolean(text.trim() && title));

  function TabButton({ m, label }: { m: Mode; label: string }) {
    const disabled = m === "github" && tokenMissing === true;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={mode === m}
        disabled={disabled}
        title={disabled ? "GITHUB_TOKEN is not configured on the server" : undefined}
        className={`btn btn-sm ${mode === m ? "btn-cyan" : "btn-metal"}`}
        style={disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
        onClick={() => setMode(m)}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <h1>New migration</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 20 }}>
        Point Sentinel at the GitHub PR that carries your migration — or paste SQL / describe the change.
        Either way it dry-runs on a shadow and pauses for your approval.
      </p>

      <form className="glass" onSubmit={submit}>
        <div className="tabs" role="tablist" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <TabButton m="github" label="From GitHub PR" />
          <TabButton m="sql" label="Raw SQL" />
          <TabButton m="intent" label="Natural language" />
        </div>
        {tokenMissing === true && (
          <p style={{ fontSize: 12, color: "var(--warn)", margin: "0 0 14px" }}>
            The PR intake needs <span className="mono">GITHUB_TOKEN</span> in the server&apos;s{" "}
            <span className="mono">.env</span> — it is disabled until then.
          </p>
        )}

        {mode === "github" ? (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 2 }}>
                <label className="lbl" htmlFor="gh-repo">Repository</label>
                <input id="gh-repo" className="field field-mono" value={repo}
                  onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
              </div>
              <div style={{ flex: 1 }}>
                <label className="lbl" htmlFor="gh-pr">PR number</label>
                <input id="gh-pr" className="field field-mono" value={prNumber}
                  onChange={(e) => setPrNumber(e.target.value)} placeholder="42" inputMode="numeric" />
              </div>
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-end", marginBottom: 1 }}
                disabled={lookupBusy || !repo.trim() || !/^\d+$/.test(prNumber.trim())} onClick={loadPr}>
                {lookupBusy ? "Loading…" : "Load PR"}
              </button>
            </div>

            {lookup && (
              <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <a href={lookup.pr.htmlUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 13 }}>
                    #{lookup.pr.number} {lookup.pr.title}
                  </a>
                  <span className="sev-chip sev-amber" style={{ fontSize: 10 }}>{lookup.pr.state}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
                    {lookup.pr.headSha.slice(0, 8)} · checks: {lookup.pr.checksState}
                  </span>
                </div>
                <div style={{ marginTop: 8 }}>
                  {lookup.sqlFiles.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--warn)" }}>
                      This PR changes no <span className="mono">.sql</span> files — nothing to analyze.
                    </div>
                  ) : (
                    <div role="radiogroup" aria-label="Migration file" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {lookup.sqlFiles.map((f) => (
                        <label key={f.filename} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                          <input type="radio" name="gh-file" checked={filePath === f.filename}
                            onChange={() => setFilePath(f.filename)} />
                          <span className="mono">{f.filename}</span>
                          <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>{f.status}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <p style={{ fontSize: 11, color: "var(--faint)", margin: "8px 0 0" }}>
                  Sentinel reads the file server-side at the PR&apos;s head commit — what gets analyzed is exactly what&apos;s on GitHub.
                </p>
              </div>
            )}

            <label className="lbl" htmlFor="mig-title">Title <span style={{ color: "var(--faint)", fontWeight: 400 }}>(optional — defaults to the PR title)</span></label>
            <input id="mig-title" className="field" style={{ marginBottom: 14 }} value={title}
              onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the PR title" />
          </>
        ) : (
          <>
            <label className="lbl" htmlFor="mig-title">Title</label>
            <input id="mig-title" className="field" style={{ marginBottom: 14 }} value={title}
              onChange={(e) => setTitle(e.target.value)} placeholder="Drop legacy_notes from users" required />
          </>
        )}

        <label className="lbl" htmlFor="db-picker-trigger">Target database</label>
        <DbPicker value={targetDb} onChange={setTargetDb} />

        {/* Real tables/columns of the picked DB — see the schema before writing SQL. */}
        <SchemaBrowser alias={targetDb} />

        {mode !== "github" && (
          <>
            <label className="lbl" htmlFor="mig-body">{mode === "sql" ? "Migration SQL" : "Describe the change"}</label>
            <textarea id="mig-body" className={mode === "sql" ? "field field-mono" : "field"}
              style={{ minHeight: 140, marginBottom: 14 }} value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={mode === "sql"
                ? "ALTER TABLE public.users DROP COLUMN legacy_notes;"
                : "Add a nullable last_login_at timestamp to users, backfilled to null."}
              required />
          </>
        )}

        {error && <div className="inline-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <button className="btn btn-cyan" type="submit" disabled={busy || !submittable}>
          {busy ? "Submitting..." : mode === "github" ? "Analyze PR migration" : "Submit to agent"}
        </button>
      </form>
    </>
  );
}
