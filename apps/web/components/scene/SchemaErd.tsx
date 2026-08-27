"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type Affected = "none" | "drop" | "add" | "alter" | "row" | "table";
export type Sev = "green" | "amber" | "red";

export interface SceneCol {
  name: string;
  type: string;
  affected: Affected;
  severity?: Sev;
  opLabel?: string;
}

export interface SceneTable {
  name: string; // e.g. "public.users"
  columns: SceneCol[];
  role: "primary" | "related";
}

export interface FkEdge {
  fromTable: string; // referencing table
  fromCol: string;
  toTable: string; // referenced table
  toCol: string;
}

const SEV_ROW_BG: Record<string, string> = {
  red: "rgba(220,38,38,0.14)", amber: "rgba(217,119,6,0.14)", green: "rgba(5,150,105,0.14)",
};
const SEV_TEXT: Record<string, string> = { red: "var(--danger)", amber: "var(--warn)", green: "var(--safe)" };

function short(t: string): string {
  return t.replace(/^public\./, "");
}

export function SchemaErd({ tables, edges }: { tables: SceneTable[]; edges: FkEdge[] }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Map<string, HTMLElement>>(new Map());
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [paths, setPaths] = useState<{ d: string; mx: number; my: number; key: number }[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const register = (map: React.MutableRefObject<Map<string, HTMLElement>>) => (key: string, el: HTMLElement | null) => {
    if (el) map.current.set(key, el);
    else map.current.delete(key);
  };
  const setCell = useCallback(register(cellRefs), []);
  const setCard = useCallback(register(cardRefs), []);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cb = canvas.getBoundingClientRect();
    // Size the SVG to the full CONTENT (scrollWidth/Height), not the clipped
    // viewport, so connectors stay aligned while the box scrolls.
    setDims({ w: Math.max(canvas.scrollWidth, cb.width), h: Math.max(canvas.scrollHeight, cb.height) });
    const anchor = (table: string, col: string) =>
      cellRefs.current.get(`${table}.${col}`) ?? cardRefs.current.get(table) ?? null;
    const next = edges
      .map((e, i) => {
        const from = anchor(e.fromTable, e.fromCol);
        const to = anchor(e.toTable, e.toCol);
        if (!from || !to) return null;
        const fr = from.getBoundingClientRect();
        const tr = to.getBoundingClientRect();
        const fromLeft = fr.left <= tr.left;
        // Coordinates RELATIVE to the canvas (scroll-invariant: both rects and cb
        // shift together when the wrapper scrolls).
        const x1 = (fromLeft ? fr.right : fr.left) - cb.left;
        const y1 = fr.top + fr.height / 2 - cb.top;
        const x2 = (fromLeft ? tr.left : tr.right) - cb.left;
        const y2 = tr.top + tr.height / 2 - cb.top;
        const mx = (x1 + x2) / 2;
        return { d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, mx, my: (y1 + y2) / 2, key: i };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    setPaths(next);
  }, [edges]);

  useLayoutEffect(() => {
    measure();
    const canvas = canvasRef.current;
    const ro = new ResizeObserver(measure);
    if (canvas) ro.observe(canvas);
    window.addEventListener("resize", measure);
    const t = setTimeout(measure, 120); // after fonts/layout settle
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); clearTimeout(t); };
  }, [measure, tables]);

  const fkCols = new Set(edges.map((e) => `${e.fromTable}.${e.fromCol}`));
  const pkCols = new Set(edges.map((e) => `${e.toTable}.${e.toCol}`));

  return (
    // Scroll wrapper — both axes, so a diagram bigger than the box scrolls.
    <div style={{ position: "relative", height: 380, overflow: "auto", borderRadius: "var(--r-md)" }}>
      <div style={{ position: "sticky", top: 0, left: 0, zIndex: 5, padding: "12px 0 0 16px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--muted)", textTransform: "uppercase", pointerEvents: "none" }}>
        SCHEMA · ENTITY RELATIONSHIPS
      </div>
      {/* Canvas sized to content (min 100% of the wrapper) */}
      <div ref={canvasRef} style={{ position: "relative", minWidth: "100%", width: "max-content", minHeight: 320, padding: "8px 28px 28px" }}>
        <svg width={dims.w} height={dims.h} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 1, overflow: "visible" }}>
          <defs>
            <marker id="erd-dot" markerWidth="8" markerHeight="8" refX="4" refY="4">
              <circle cx="4" cy="4" r="3" fill="var(--cyan)" />
            </marker>
          </defs>
          {paths.map((p) => (
            <path key={p.key} d={p.d} fill="none" stroke="var(--cyan)" strokeWidth={1.6} strokeOpacity={0.65} markerStart="url(#erd-dot)" markerEnd="url(#erd-dot)" />
          ))}
        </svg>
        {edges.map((e, i) =>
          paths[i] ? (
            <div key={`lbl-${i}`} style={{ position: "absolute", left: paths[i].mx, top: paths[i].my, transform: "translate(-50%,-50%)", zIndex: 2, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--cyan)", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>
              1 — ∞
            </div>
          ) : null,
        )}

        <div style={{ position: "relative", zIndex: 2, display: "flex", gap: 64, flexWrap: "nowrap", alignItems: "flex-start" }}>
          {tables.map((t) => {
            const primary = t.role === "primary";
            return (
              <div
                key={t.name}
                ref={(el) => setCard(t.name, el)}
                style={{ flex: "0 0 auto", minWidth: 190, background: "var(--panel-2)", border: `1px solid ${primary ? "var(--cyan)" : "var(--line-strong)"}`, borderRadius: 10, overflow: "hidden", boxShadow: "var(--shadow-md)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: primary ? "rgba(124,58,237,.12)" : "var(--panel)", borderBottom: "1px solid var(--line)" }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{short(t.name)}</span>
                  {primary && <span className="mono" style={{ fontSize: 9, letterSpacing: ".1em", color: "var(--cyan)", marginLeft: "auto" }}>PRIMARY</span>}
                </div>
                <div>
                  {t.columns.map((c) => {
                    const key = `${t.name}.${c.name}`;
                    const isPk = pkCols.has(key) || c.name === "id";
                    const isFk = fkCols.has(key);
                    const affected = c.affected !== "none";
                    return (
                      <div
                        key={c.name}
                        ref={(el) => setCell(key, el)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 12,
                          borderTop: "1px solid var(--line)",
                          background: affected && c.severity ? SEV_ROW_BG[c.severity] : "transparent",
                          color: affected && c.severity ? SEV_TEXT[c.severity] : "var(--text-dim)",
                          fontWeight: affected ? 700 : 400, whiteSpace: "nowrap",
                        }}
                      >
                        <span className="mono" style={{ fontSize: 8.5, width: 20, color: isPk ? "var(--warn)" : isFk ? "var(--cyan)" : "var(--faint)" }}>
                          {isPk ? "PK" : isFk ? "FK" : ""}
                        </span>
                        <span className="mono">{c.name}</span>
                        <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>{c.type}</span>
                        {affected && <span className="mono" style={{ fontSize: 9, color: SEV_TEXT[c.severity ?? "amber"] }}>{c.opLabel ?? ""}</span>}
                      </div>
                    );
                  })}
                  {t.columns.length === 0 && (
                    <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--faint)" }}>(columns not in fixture)</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
