"use client";
import { useEffect, useState } from "react";

interface BrowserColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}
interface BrowserTable {
  name: string;
  columns: BrowserColumn[];
}
interface BrowserSchema {
  tables: BrowserTable[];
  fks: { fromTable: string; fromCol: string; toTable: string; toCol: string }[];
  truncated: boolean;
}

/**
 * Live schema browser for the New Migration flow (PR2): pick a DB, see its
 * REAL tables and columns before writing SQL. Fetches the session-gated
 * schema API (the URL never reaches the client); loading and error states are
 * honest — a failure never renders placeholder tables.
 */
export function SchemaBrowser({ alias }: { alias: string }) {
  const [schema, setSchema] = useState<BrowserSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!alias) {
      setSchema(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSchema(null);
    fetch(`/api/connections/${encodeURIComponent(alias)}/schema`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Server returned ${r.status}`);
        return data as BrowserSchema;
      })
      .then((d) => {
        if (cancelled) return;
        setSchema(d);
        setOpen(new Set(d.tables.slice(0, 1).map((t) => t.name))); // first table open
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the schema.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [alias]);

  if (!alias) return null;

  const fkCols = new Set(schema?.fks.map((e) => `${e.fromTable}.${e.fromCol}`) ?? []);

  function toggle(name: string) {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="glass" style={{ padding: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="hud-label" style={{ margin: 0 }}>Live schema · {alias}</span>
        {schema && (
          <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
            {schema.tables.length} {schema.tables.length === 1 ? "table" : "tables"}
            {schema.truncated ? " · list truncated" : ""}
          </span>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 12, color: "var(--faint)", padding: "6px 0" }}>Introspecting…</div>
      )}
      {error && (
        <div className="inline-error" role="alert">{error}</div>
      )}
      {schema && schema.tables.length === 0 && !loading && (
        <div style={{ fontSize: 12, color: "var(--faint)", padding: "6px 0" }}>
          The database has no user tables.
        </div>
      )}

      {schema && schema.tables.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
          {schema.tables.map((t) => {
            const expanded = open.has(t.name);
            return (
              <div key={t.name} style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(t.name)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
                    background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 10, color: "var(--faint)" }}>{expanded ? "▾" : "▸"}</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{t.name}</span>
                  <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>
                    {t.columns.length} cols
                  </span>
                </button>
                {expanded && (
                  <div style={{ borderTop: "1px solid var(--line)" }}>
                    {t.columns.map((c) => {
                      const isFk = fkCols.has(`${t.name}.${c.name}`);
                      return (
                        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px 4px 28px", fontSize: 11.5 }}>
                          <span className="mono" style={{ fontSize: 8.5, width: 20, color: c.pk ? "var(--warn)" : isFk ? "var(--cyan)" : "var(--faint)" }}>
                            {c.pk ? "PK" : isFk ? "FK" : ""}
                          </span>
                          <span className="mono" style={{ color: "var(--text-dim)" }}>{c.name}</span>
                          <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>
                            {c.type}{c.notNull ? " · not null" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
