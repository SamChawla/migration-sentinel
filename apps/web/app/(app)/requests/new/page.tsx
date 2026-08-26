"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewRequest() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [targetDb, setTargetDb] = useState("prod-orders-db");
  const [upSql, setUpSql] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, targetDb, upSql, downSql: "" }),
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
        Describe the change or paste SQL. The agent writes a safe up/down pair, dry-runs on a shadow, and pauses for your approval.
      </p>

      <form className="glass" onSubmit={submit}>
        <label className="lbl" htmlFor="mig-title">Title</label>
        <input id="mig-title" className="field" style={{ marginBottom: 14 }} value={title}
          onChange={(e) => setTitle(e.target.value)} placeholder="Drop legacy_notes from users" required />

        <label className="lbl" htmlFor="mig-target">Target database</label>
        <input id="mig-target" className="field" style={{ marginBottom: 14 }} value={targetDb}
          onChange={(e) => setTargetDb(e.target.value)} required />

        <label className="lbl" htmlFor="mig-sql">Migration SQL (or describe the intent)</label>
        <textarea id="mig-sql" className="field field-mono" style={{ minHeight: 140, marginBottom: 14 }} value={upSql}
          onChange={(e) => setUpSql(e.target.value)}
          placeholder="ALTER TABLE public.users DROP COLUMN legacy_notes;" required />

        {error && <div className="inline-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <button className="btn btn-cyan" type="submit" disabled={busy || !title || !upSql}>
          {busy ? "Submitting..." : "Submit to agent"}
        </button>
      </form>
    </>
  );
}
