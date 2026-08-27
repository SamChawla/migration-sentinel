"use client";
import { useRef, useState } from "react";

interface RanQuery {
  sql: string;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  queries?: RanQuery[];
}

const SUGGESTIONS = [
  "Is the rollback safe, and why?",
  "How many rows would this actually touch right now?",
  "What's the single biggest risk here?",
];

export function MigrationChat({ requestId }: { requestId: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setError(null);
    setInput("");
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const next = [...messages, { role: "user" as const, content: q }];
    setMessages(next);
    setBusy(true);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }));

    try {
      const res = await fetch(`/api/requests/${requestId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setMessages((m) => [...m, { role: "assistant", content: data.answer, queries: data.queries }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Copilot request failed.");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }));
    }
  }

  return (
    <div className="glass" style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Ask about this migration</h3>
        <span
          className="mono"
          title="Runs on your Euron key — OpenAI-compatible, bring-your-own-key"
          style={{
            marginLeft: "auto", fontSize: 10, letterSpacing: ".06em", color: "var(--faint)",
            border: "1px solid var(--line)", borderRadius: 999, padding: "2px 9px",
          }}
        >
          ⚡ Euron · BYOK · read-only
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--faint)", margin: "0 0 12px" }}>
        Grounded in the blast report, rollback verdict and pre-flight. It can run <b>read-only SELECTs</b> against
        the target — it can never approve, apply, or change anything.
      </p>

      {messages.length > 0 && (
        <div
          ref={scrollRef}
          style={{
            display: "flex", flexDirection: "column", gap: 12, maxHeight: 340,
            overflowY: "auto", padding: "4px 2px 12px", marginBottom: 4,
          }}
        >
          {messages.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".1em", color: "var(--faint)", marginBottom: 3, textAlign: m.role === "user" ? "right" : "left" }}>
                {m.role === "user" ? "YOU" : "COPILOT"}
              </div>
              <div
                style={{
                  fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", borderRadius: 12, padding: "9px 13px",
                  background: m.role === "user" ? "rgba(124,58,237,.10)" : "var(--panel-2)",
                  border: "1px solid var(--line)",
                  color: m.role === "user" ? "var(--text)" : "var(--text-dim)",
                }}
              >
                {m.content}
              </div>
              {m.queries && m.queries.length > 0 && (
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                  {m.queries.map((qr, j) => (
                    <div key={j} className="mono" style={{ fontSize: 10.5, background: "var(--space-1, rgba(0,0,0,.25))", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 9px" }}>
                      <span style={{ color: "var(--cyan)" }}>▸ ran SELECT</span>
                      <span style={{ color: "var(--faint)", marginLeft: 8 }}>
                        {qr.error ? `refused: ${qr.error}` : `${qr.rowCount ?? 0} row${qr.rowCount === 1 ? "" : "s"}${qr.truncated ? " (capped)" : ""}`}
                      </span>
                      <div style={{ color: "var(--muted)", marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{qr.sql}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="mono" style={{ fontSize: 11, color: "var(--cyan)", alignSelf: "flex-start" }}>
              copilot is thinking<span className="ellipsis">…</span>
            </div>
          )}
        </div>
      )}

      {messages.length === 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="btn btn-sm" onClick={() => ask(s)} disabled={busy} style={{ fontSize: 12 }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="inline-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

      <form
        onSubmit={(e) => { e.preventDefault(); ask(input); }}
        style={{ display: "flex", gap: 10, alignItems: "flex-end" }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder="e.g. How many users have a NULL email right now?"
          rows={2}
          disabled={busy}
          style={{
            flex: 1, resize: "vertical", fontSize: 13, lineHeight: 1.4, borderRadius: 10,
            padding: "9px 12px", background: "var(--panel-2)", border: "1px solid var(--line-strong)",
            color: "var(--text)", fontFamily: "inherit",
          }}
        />
        <button type="submit" className="btn btn-cyan" disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
