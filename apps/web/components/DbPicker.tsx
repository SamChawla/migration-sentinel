"use client";
import { useEffect, useRef, useState } from "react";

interface Conn {
  id: string;
  name: string;
  alias: string;
  hasUrl: boolean;
}

/** Searchable target-database picker with inline "add a connection" (which
 *  live-tests the URL before saving). Replaces the old free-text field. */
export function DbPicker({ value, onChange }: { value: string; onChange: (alias: string) => void }) {
  const [conns, setConns] = useState<Conn[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/connections")
      .then((r) => (r.ok ? r.json() : { connections: [] }))
      .then((d) => setConns(d.connections ?? []))
      .catch(() => setConns([]));
  }, []);

  useEffect(() => {
    function away(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const filtered = conns.filter(
    (c) => c.alias.toLowerCase().includes(q.toLowerCase()) || c.name.toLowerCase().includes(q.toLowerCase()),
  );

  async function testAndAdd() {
    setError(null);
    setTesting(true);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: alias.trim(), url: url.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      const conn: Conn = data.connection;
      setConns((cur) => [...cur.filter((c) => c.alias !== conn.alias), conn].sort((a, b) => a.alias.localeCompare(b.alias)));
      onChange(conn.alias);
      setAdding(false);
      setOpen(false);
      setAlias("");
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the connection.");
    } finally {
      setTesting(false);
    }
  }

  const selected = conns.find((c) => c.alias === value);

  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 14 }}>
      <button
        type="button"
        className="field"
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: selected?.hasUrl ? "var(--safe)" : "var(--faint)", flexShrink: 0 }} />
        <span style={{ color: value ? "var(--text)" : "var(--faint)" }}>{value || "Select a target database…"}</span>
        <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 12 }}>▾</span>
      </button>

      {open && (
        <div
          className="glass"
          style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 50, padding: 8, boxShadow: "var(--shadow-md)" }}
        >
          {!adding ? (
            <>
              <input
                autoFocus
                className="field"
                placeholder="Search databases…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { onChange(c.alias); setOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8,
                      background: c.alias === value ? "rgba(124,58,237,.1)" : "transparent", border: "none",
                      color: "var(--text-dim)", cursor: "pointer", textAlign: "left", fontSize: 13,
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.hasUrl ? "var(--safe)" : "var(--faint)" }} />
                    <span className="mono">{c.alias}</span>
                    {!c.hasUrl && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>seeded</span>}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div style={{ padding: "10px", fontSize: 12, color: "var(--faint)" }}>No matches.</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setAdding(true); setError(null); setAlias(q); }}
                className="btn btn-sm"
                style={{ width: "100%", marginTop: 8 }}
              >
                + Add a database
              </button>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="hud-label" style={{ margin: 0 }}>New connection</div>
              <input className="field" placeholder="Alias (e.g. staging-db)" value={alias} onChange={(e) => setAlias(e.target.value)} />
              <input className="field field-mono" placeholder="postgres://user:pass@host:5432/db" value={url} onChange={(e) => setUrl(e.target.value)} />
              {error && <div className="inline-error" role="alert">{error}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn btn-sm" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-cyan btn-sm"
                  style={{ marginLeft: "auto" }}
                  disabled={testing || !alias.trim() || !url.trim()}
                  onClick={testAndAdd}
                >
                  {testing ? "Testing…" : "Test & add"}
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--faint)", margin: 0 }}>
                We run a read-only <span className="mono">SELECT 1</span> to verify the connection before saving.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
