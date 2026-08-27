"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { DEMO_STEPS } from "@/lib/demo-replay";
import { SeverityChip } from "@/components/chips";

export default function DemoReplay() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const step = DEMO_STEPS[i];
  const atEnd = i === DEMO_STEPS.length - 1;

  useEffect(() => {
    if (!playing) return;
    if (atEnd) { setPlaying(false); return; }
    const t = setTimeout(() => setI((n) => Math.min(n + 1, DEMO_STEPS.length - 1)), 1400);
    return () => clearTimeout(t);
  }, [playing, i, atEnd]);

  return (
    <div className="mk-section">
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>
            Demo Replay{" "}
            <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 11, fontWeight: 500, verticalAlign: "middle" }}>
              recorded run
            </span>
          </h1>
          <p style={{ color: "var(--muted)", fontSize: ".9rem", marginTop: 6 }}>
            Replays a real <code className="mono" style={{ color: "var(--cyan)" }}>drop_legacy_notes</code> run step by step — no live agent, model, or database needed.
          </p>
        </div>
        <Link href="/login" className="btn btn-cyan btn-sm">Open live console</Link>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0 20px" }}>
        {DEMO_STEPS.map((s, idx) => (
          <button key={idx} onClick={() => { setPlaying(false); setI(idx); }}
            style={{
              padding: "4px 12px", borderRadius: 6, border: "1px solid var(--line)",
              background: idx === i ? "rgba(124,58,237,.1)" : "transparent",
              color: idx === i ? "var(--cyan)" : "var(--text-dim)",
              cursor: "pointer", fontSize: 12, fontWeight: 500,
            }}>
            {idx + 1}. {s.phase}
          </button>
        ))}
      </div>

      <section className="glass" style={{ padding: "1.5rem", animation: "fadeIn .3s ease" }} key={i}>
        {step.status === "awaiting_approval" && (
          <div className="paused-banner" style={{ marginBottom: 12 }}>AGENT PAUSED — waiting for human decision</div>
        )}
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

        {step.status === "applied" && (
          <div className="sev-chip sev-green" style={{ marginTop: 8 }}>Applied with guards &middot; audit written</div>
        )}
      </section>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button className="btn" disabled={i === 0} onClick={() => { setPlaying(false); setI(i - 1); }}>Prev</button>
        <button className="btn btn-cyan" onClick={() => (atEnd ? setI(0) : setPlaying((p) => !p))}>
          {atEnd ? "Restart" : playing ? "Pause" : "Play"}
        </button>
        <button className="btn" disabled={atEnd} onClick={() => { setPlaying(false); setI(i + 1); }}>Next</button>
      </div>
    </div>
  );
}
