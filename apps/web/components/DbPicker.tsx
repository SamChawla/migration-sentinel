"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ENV_ORDER, type DbEnvironment } from "@sentinel/core";
import { EnvBadge } from "./EnvBadge";

interface Conn {
  id: string;
  name: string;
  alias: string;
  environment: DbEnvironment;
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
  const [env, setEnv] = useState<DbEnvironment>("dev");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Track load + error state separately from the array so a failed fetch is not
  // silently shown as an empty configuration ("No matches").
  const loadConns = useCallback(() => {
    setLoadError(null);
    fetch("/api/connections")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Server returned ${r.status}`);
        return r.json();
      })
      .then((d) => { setConns(d.connections ?? []); setLoaded(true); })
      .catch((e) => { setLoadError(e instanceof Error ? e.message : "Could not load connections."); setLoaded(true); });
  }, []);

  useEffect(() => { loadConns(); }, [loadConns]);

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
        body: JSON.stringify({ alias: alias.trim(), url: url.trim(), environment: env }),
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
      setEnv("dev");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the connection.");
    } finally {
      setTesting(false);
    }
  }

  // Enter inside the add-connection fields must NOT bubble to the enclosing
  // migration <form> (implicit submit) — it runs the test-and-add flow instead.
  function onAddKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!testing && alias.trim() && url.trim()) void testAndAdd();
  }

  const selected = conns.find((c) => c.alias === value);

  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 14 }}>
      <button
        type="button"
        id="db-picker-trigger"
        className="field"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "db-picker-listbox" : undefined}
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
      >
        <span aria-hidden="true" title={selected?.hasUrl ? "Connection configured (URL stored)" : "No stored URL"} style={{ width: 7, height: 7, borderRadius: "50%", background: selected?.hasUrl ? "var(--cyan)" : "var(--faint)", flexShrink: 0 }} />
        <span style={{ color: value ? "var(--text)" : "var(--faint)" }}>{value || "Select a target database…"}</span>
        {selected && <EnvBadge env={selected.environment} />}
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
                aria-label="Search databases"
                placeholder="Search databases…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                // This picker lives inside the New Migration <form>; Enter here
                // would otherwise submit that form and start a migration.
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                style={{ marginBottom: 8 }}
              />
              <div id="db-picker-listbox" role="listbox" aria-label="Databases" style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={c.alias === value}
                    aria-disabled={!c.hasUrl}
                    disabled={!c.hasUrl}
                    onClick={() => { if (c.hasUrl) { onChange(c.alias); setOpen(false); } }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8,
                      background: c.alias === value ? "rgba(124,58,237,.1)" : "transparent", border: "none",
                      color: c.hasUrl ? "var(--text-dim)" : "var(--faint)", cursor: c.hasUrl ? "pointer" : "not-allowed",
                      textAlign: "left", fontSize: 13, opacity: c.hasUrl ? 1 : 0.6,
                    }}
                  >
                    {/* Dot = whether a URL is CONFIGURED (not a live reachability check). */}
                    <span
                      aria-hidden="true"
                      title={c.hasUrl ? "Connection configured (URL stored)" : "Seeded alias — no stored URL"}
                      style={{ width: 7, height: 7, borderRadius: "50%", background: c.hasUrl ? "var(--cyan)" : "var(--faint)" }}
                    />
                    <span className="mono">{c.alias}</span>
                    <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {!c.hasUrl && <span style={{ fontSize: 10, color: "var(--faint)" }}>no url</span>}
                      <EnvBadge env={c.environment} />
                    </span>
                  </button>
                ))}
                {loadError ? (
                  <div style={{ padding: "10px", fontSize: 12 }}>
                    <div className="inline-error" role="alert" style={{ marginBottom: 6 }}>Couldn&apos;t load connections: {loadError}</div>
                    <button type="button" className="btn btn-sm" onClick={loadConns}>Retry</button>
                  </div>
                ) : !loaded ? (
                  <div style={{ padding: "10px", fontSize: 12, color: "var(--faint)" }}>Loading…</div>
                ) : filtered.length === 0 ? (
                  <div style={{ padding: "10px", fontSize: 12, color: "var(--faint)" }}>No matches.</div>
                ) : null}
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
              {/* Enter runs the add-connection flow (never the outer migration
                  form): submit implicitly reaches the enclosing New Migration
                  <form> and would start a migration against the old target. */}
              <input className="field" placeholder="Alias (e.g. staging-db)" value={alias} onChange={(e) => setAlias(e.target.value)} onKeyDown={onAddKeyDown} />
              <input className="field field-mono" placeholder="postgres://user:pass@host:5432/db" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={onAddKeyDown} />
              <select
                className="field"
                aria-label="Environment"
                value={env}
                onChange={(e) => setEnv(e.target.value as DbEnvironment)}
                style={{ cursor: "pointer" }}
              >
                {ENV_ORDER.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
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
