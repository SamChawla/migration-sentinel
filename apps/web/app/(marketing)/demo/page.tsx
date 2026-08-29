"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DEMO_STEPS } from "@/lib/demo-replay";
import { SeverityChip } from "@/components/chips";

const OPEN_ACCESS = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase());

// The streaming "agent trace" for each phase — this is what turns a static step
// list into a run you watch happen. Lines append one by one as the phase plays.
const TRACE: Record<string, string[]> = {
  Intake: ["› request received — drop_legacy_notes", "› intake: natural-language intent", "✓ queued for the pipeline"],
  Generate: ["› TrueForge session opened", "› streaming turn — authoring up / down…", "✓ artifact written (up.sql, down.sql)", "⚠ down cannot restore dropped data"],
  Review: ["› Qodo review requested on the generated SQL", "✓ passed_with_warnings · 1 finding"],
  "Dry-run": ["› pg_dump --schema-only target", "› provisioning ephemeral shadow :5434", "› applying up → down on the clone", "⚠ schema shape restores, but dropped-column data cannot — rollback NOT proven", "› blast: ~1,204,338 rows · AccessExclusiveLock · ~14s", "⛔ DROP COLUMN destroys data — irreversible"],
  Gate: ["⏸ apply_migration is approval-required", "⏸ turn paused — awaiting operator", "› gate policy: RED · typed confirmation required"],
  Decision: ['› operator typed "users" and approved', "› user.tool_approval → allow", "› resuming the paused turn"],
  Apply: ["› BEGIN · lock_timeout=3s · statement_timeout=30s", "› ALTER TABLE public.users DROP COLUMN legacy_notes", "✓ COMMIT — applied in 480 ms", "✓ apply_run + audit event written"],
};

const LINE_MS = 300; // per streamed trace line
const HOLD_MS = 850; // pause after a phase completes before the next begins

export default function DemoReplay() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true); // auto-start — it plays itself
  const [lineN, setLineN] = useState(0); // trace lines revealed for the current phase
  const consoleRef = useRef<HTMLDivElement>(null);

  const step = DEMO_STEPS[i];
  const atEnd = i === DEMO_STEPS.length - 1;
  const trace = useMemo(() => TRACE[step.phase] ?? [], [step.phase]);

  // Driver: stream this phase's trace lines, then advance to the next phase.
  useEffect(() => {
    if (!playing) return;
    if (lineN < trace.length) {
      const t = setTimeout(() => setLineN((n) => n + 1), LINE_MS);
      return () => clearTimeout(t);
    }
    if (!atEnd) {
      const t = setTimeout(() => { setI((n) => n + 1); setLineN(0); }, HOLD_MS);
      return () => clearTimeout(t);
    }
    setPlaying(false);
  }, [playing, lineN, trace.length, atEnd]);

  // Accumulated console: all prior phases in full + the current phase's revealed lines.
  const consoleLines = useMemo(() => {
    const out: { line: string; phase: string }[] = [];
    for (let s = 0; s < i; s++) {
      const ph = DEMO_STEPS[s].phase;
      for (const line of TRACE[ph] ?? []) out.push({ line, phase: ph });
    }
    for (const line of trace.slice(0, lineN)) out.push({ line, phase: step.phase });
    return out;
  }, [i, lineN, trace, step.phase]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight, behavior: "smooth" });
  }, [consoleLines.length]);

  const progress = ((i + (trace.length ? lineN / trace.length : 1)) / DEMO_STEPS.length) * 100;

  const goto = (n: number) => { setPlaying(false); setI(Math.max(0, Math.min(n, DEMO_STEPS.length - 1))); setLineN(0); };
  // The current phase's trace has fully streamed. The "applied" success chip
  // must wait for this — phase entry resets lineN to 0, and COMMIT + audit are
  // the LAST lines of the Apply trace, so claiming success earlier would report
  // a production change before the replayed apply reached it.
  const traceDone = lineN >= trace.length;
  // "Complete" only when the LAST phase has finished streaming — not merely
  // because the index is last (Apply still streams while atEnd is true).
  const complete = atEnd && !playing && traceDone;
  // The badge reports the recorded agent's state, not the replay transport:
  // during the Gate phase the agent is paused awaiting the operator even while
  // the replay keeps streaming, so "running" would contradict AGENT PAUSED.
  const gateHeld = step.status === "awaiting_approval";
  const runStatus = complete ? "complete" : gateHeld ? "awaiting approval" : playing ? "running" : "paused";
  const replay = () => { setI(0); setLineN(0); setPlaying(true); }; // reset AND play in one click
  const lineTone = (l: string) => l.startsWith("✓") ? "var(--safe)" : l.startsWith("⛔") ? "var(--danger)" : l.startsWith("⚠") ? "var(--warn)" : l.startsWith("⏸") ? "var(--hold)" : "var(--text-dim)";

  return (
    <div className="mk-section">
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            Live Pipeline Run
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 11px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 11, fontWeight: 500 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: gateHeld ? "var(--hold)" : "var(--cyan)", boxShadow: gateHeld ? "none" : "var(--glow-cyan)", animation: playing && !gateHeld ? "pulse 1.4s ease-in-out infinite" : "none" }} />
              {runStatus}
            </span>
          </h1>
          <p style={{ color: "var(--muted)", fontSize: ".9rem", marginTop: 6 }}>
            Watch a real <code className="mono" style={{ color: "var(--cyan)" }}>drop_legacy_notes</code> run travel the pipeline — intake → generate → dry-run → the gate → guarded apply. Sandbox replay; no production touched.
          </p>
        </div>
        <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="btn btn-cyan btn-sm">Open live console</Link>
      </div>

      {/* Phase tracker + progress */}
      <div className="glass" style={{ padding: "14px 18px", marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {DEMO_STEPS.map((s, idx) => {
            const state = idx < i ? "done" : idx === i ? "active" : "pending";
            return (
              <button
                key={idx}
                onClick={() => goto(idx)}
                title={s.title}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 8, cursor: "pointer",
                  fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)",
                  border: `1px solid ${state === "active" ? "var(--cyan)" : "var(--line)"}`,
                  background: state === "active" ? "rgba(124,58,237,.12)" : "transparent",
                  color: state === "done" ? "var(--safe)" : state === "active" ? "var(--cyan)" : "var(--faint)",
                }}
              >
                <span>{state === "done" ? "✓" : String(idx + 1).padStart(2, "0")}</span>
                {s.phase}
              </button>
            );
          })}
        </div>
        <div style={{ height: 5, borderRadius: 3, background: "var(--line-strong)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, var(--cyan-deep), var(--cyan) 60%, var(--magenta))", transition: "width .3s ease" }} />
        </div>
      </div>

      <div className="demo-grid">
        {/* Main panel — the step content */}
        <section className="glass" style={{ padding: "1.5rem", animation: "fadeIn .35s ease" }} key={i}>
          {step.status === "awaiting_approval" && (
            <div className="paused-banner" style={{ marginBottom: 12 }}>
              <span className="pulse-dot" /> AGENT PAUSED — apply_migration held at the gate. No production changes made.
            </div>
          )}
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--cyan)", marginBottom: 4 }}>
            PHASE {String(i + 1).padStart(2, "0")} · {step.phase.toUpperCase()}
          </div>
          <h3 style={{ marginTop: 0, color: "var(--text)" }}>{step.title}</h3>
          <p style={{ color: "var(--muted)" }}>{step.detail}</p>

          {step.up && (
            <>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, fontFamily: "var(--font-mono)" }}>up.sql</div>
              <pre className="sql-well" style={{ margin: "4px 0 10px" }}>{step.up}</pre>
              <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>down.sql</div>
              <pre className="sql-well" style={{ margin: "4px 0", borderLeft: "3px solid var(--danger)" }}>{step.down}</pre>
            </>
          )}

          {step.qodo && (
            <p>
              <span className="sev-chip sev-amber">{step.qodo.verdict.replace(/_/g, " ")}</span>{" "}
              <span style={{ color: "var(--muted)" }}>{step.qodo.findings.join(" ")}</span>
            </p>
          )}

          {step.blast && (
            <div style={{ borderLeft: "4px solid var(--danger)", paddingLeft: 12, marginTop: 12 }}>
              <p style={{ margin: "6px 0" }}>Overall: <SeverityChip severity={step.blast.overallSeverity} /></p>
              <p className="mono" style={{ margin: "4px 0", color: "var(--muted)" }}>Rows affected (est.): {step.blast.rowsAffected.toLocaleString()}</p>
              <p className="mono" style={{ margin: "4px 0", color: "var(--muted)" }}>Est. lock: {step.blast.estLockMs.toLocaleString()} ms</p>
              <p style={{ margin: "4px 0" }}>Rollback: <span className="sev-chip sev-red">Not recoverable</span></p>
              {step.blast.findings.map((f, k) => (
                <div key={k} style={{ fontSize: 13, color: "var(--muted)" }}>
                  &bull; {f.note} {f.lockType ? <span className="mono">({f.lockType})</span> : null}
                </div>
              ))}
            </div>
          )}

          {step.gate && (
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12 }}>
              <span className="sev-chip sev-red">Irreversible — type &ldquo;{step.gate.confirmWord}&rdquo; to confirm</span>
            </div>
          )}

          {step.status === "applied" && (traceDone ? (
            <div className="sev-chip sev-green" style={{ marginTop: 8 }}>Applied with guards &middot; audit written</div>
          ) : (
            <div className="sev-chip sev-amber" style={{ marginTop: 8 }}>Applying &middot; timeouts, transaction, auto-rollback armed</div>
          ))}
        </section>

        {/* Streaming agent trace */}
        <section className="glass glass-solid" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warn)" }} />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--safe)" }} />
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)", marginLeft: 6 }}>agent trace</span>
          </div>
          <div ref={consoleRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Agent trace" style={{ padding: "12px 14px", height: 340, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7 }}>
            {consoleLines.map((c, k) => (
              <div key={k} style={{ color: lineTone(c.line), whiteSpace: "pre-wrap", animation: "fadeIn .2s ease" }}>{c.line}</div>
            ))}
            {playing && lineN < trace.length && (
              <span style={{ display: "inline-block", width: 7, height: 14, background: "var(--cyan)", verticalAlign: "middle", animation: "pulse 1s steps(2) infinite" }} />
            )}
          </div>
        </section>
      </div>

      {/* Transport controls */}
      <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
        <button className="btn" disabled={i === 0} onClick={() => goto(i - 1)}>‹ Prev</button>
        <button className="btn btn-cyan" onClick={() => (complete ? replay() : setPlaying((p) => !p))}>
          {complete ? "↻ Replay" : playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button className="btn" disabled={atEnd} onClick={() => goto(i + 1)}>Next ›</button>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--faint)" }}>
          {String(i + 1).padStart(2, "0")} / {String(DEMO_STEPS.length).padStart(2, "0")} · {step.phase}
        </span>
      </div>
    </div>
  );
}
