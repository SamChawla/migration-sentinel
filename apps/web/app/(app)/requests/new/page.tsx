"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "sql" | "intent";

export default function NewRequest() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [targetDb, setTargetDb] = useState("prod-orders-db");
  const [mode, setMode] = useState<Mode>("sql");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // SQL mode is applied as-is; intent mode is generated into a {up,down}
      // pair by the agent. The two are sent as distinct fields so natural
      // language is never executed as SQL.
      const body =
        mode === "intent"
          ? { title, targetDb, intent: text }
          : { title, targetDb, upSql: text, downSql: "" };
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Server returned ${res.status}`);
      }
      const { id } = await res.json();
      router.push(`/requests/${id}`);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <>
      <h1>New migration</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 20 }}>
        Paste SQL, or describe the change in plain English and let the agent write a safe up/down pair. Either way
        it dry-runs on a shadow and pauses for your approval.
      </p>

      <form className="glass" onSubmit={submit}>
        <label className="lbl" htmlFor="mig-title">Title</label>
        <input id="mig-title" className="field" style={{ marginBottom: 14 }} value={title}
          onChange={(e) => setTitle(e.target.value)} placeholder="Drop legacy_notes from users" required />

        <label className="lbl" htmlFor="mig-target">Target database</label>
        <input id="mig-target" className="field" style={{ marginBottom: 14 }} value={targetDb}
          onChange={(e) => setTargetDb(e.target.value)} required />

        <div className="tabs" role="tablist" style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button type="button" role="tab" aria-selected={mode === "sql"}
            className={`btn btn-sm ${mode === "sql" ? "btn-cyan" : "btn-metal"}`} onClick={() => setMode("sql")}>
            Raw SQL
          </button>
          <button type="button" role="tab" aria-selected={mode === "intent"}
            className={`btn btn-sm ${mode === "intent" ? "btn-cyan" : "btn-metal"}`} onClick={() => setMode("intent")}>
            Natural language
          </button>
        </div>

        <label className="lbl" htmlFor="mig-body">{mode === "sql" ? "Migration SQL" : "Describe the change"}</label>
        <textarea id="mig-body" className={mode === "sql" ? "field field-mono" : "field"}
          style={{ minHeight: 140, marginBottom: 14 }} value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === "sql"
            ? "ALTER TABLE public.users DROP COLUMN legacy_notes;"
            : "Add a nullable last_login_at timestamp to users, backfilled to null."}
          required />

        {error && <div className="inline-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <button className="btn btn-cyan" type="submit" disabled={busy || !title || !text.trim()}>
          {busy ? "Submitting..." : "Submit to agent"}
        </button>
      </form>
    </>
  );
}
