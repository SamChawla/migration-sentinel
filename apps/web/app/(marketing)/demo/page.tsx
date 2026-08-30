"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DEMO_STEPS } from "@/lib/demo-replay";
import { SeverityChip } from "@/components/chips";

const OPEN_ACCESS = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase());

const TRACE: Record<string, string[]> = {
  "PR Intake": [
    "› webhook received — push to acme/orders-api#42",
    "› scanning changed files for migration SQL…",
    "› found: migrations/0005_idx_orders_status.sql",
    "› extracted SQL — queuing for the pipeline",
    "✓ intake complete — migration request created",
  ],
  "Staging Dry-run": [
    "› target: staging-orders-db (staging)",
    "› pg_dump --schema-only staging",
    "› provisioning ephemeral shadow :5434",
    "› applying up → down on the clone…",
    "✓ schema restored — rollback PROVEN",
    "› blast: 0 rows · no table lock · ~8 ms",
    "✓ GREEN — non-blocking CONCURRENTLY build",
  ],
  "Code Review": [
    "› Qodo review requested on generated SQL",
    "✓ passed — no findings",
  ],
  "Staging Apply": [
    "› GREEN + rollback proven → staging gate opens automatically",
    "› BEGIN · lock_timeout=3s · statement_timeout=30s",
    "› CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status)",
    "✓ APPLIED (autocommit) — 1/1 statement(s)",
    "✓ audit event written",
  ],
  Promote: [
    "› staging run: applied, rollback proven",
    "› promotion eligible: staging → prod",
    "› creating prod migration request (same SQL, higher gate)…",
    "✓ promoted — prod rail UNLOCKED",
  ],
  "Prod Dry-run": [
    "› target: prod-orders-db (prod)",
    "› pg_dump --schema-only prod",
    "› provisioning ephemeral shadow :5434",
    "› applying up → down on the clone…",
    "✓ schema restored — rollback PROVEN",
    "› blast: 0 rows · no table lock · ~12 ms",
    "✓ GREEN — non-blocking CONCURRENTLY build",
  ],
  "Approval Gate": [
    "⏸ prod requires human approval — even for GREEN",
    "⏸ apply_migration is approval-required",
    "⏸ turn paused — awaiting operator",
    "› gate policy: GREEN · promotion-verified · approval pending",
  ],
  Approved: [
    '› operator reviewed blast report + promotion history',
    "› decision: approved",
    "› linked repo detected → routing to export gate (not direct apply)",
    "✓ approval audited",
  ],
  "Export Gate": [
    "› creating branch: sentinel/migration-0005",
    "› committing approved SQL to branch",
    "› opening PR #43 on acme/orders-api",
    "⏸ gate 2 — awaiting PR merge (source-of-truth verification)",
    "› no apply has run — prod is untouched",
  ],
  Apply: [
    "› PR #43 merged — merge verified",
    "› BEGIN · lock_timeout=3s · statement_timeout=30s",
    "› CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status)",
    "✓ APPLIED (autocommit) — 1/1 statement(s) committed",
    "✓ apply_run + audit event written",
    "✓ full provenance: PR#42 → staging → approval → PR#43 → prod",
  ],
};

const LINE_MS = 280;
const HOLD_MS = 750;

const ENV_COLORS: Record<string, string> = {
  staging: "var(--warn)",
  prod: "var(--magenta)",
};

export default function DemoReplay() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [lineN, setLineN] = useState(0);
  const consoleRef = useRef<HTMLDivElement>(null);

  const step = DEMO_STEPS[i];
  const atEnd = i === DEMO_STEPS.length - 1;
  const trace = useMemo(() => TRACE[step.phase] ?? [], [step.phase]);

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
  const traceDone = lineN >= trace.length;
  const complete = atEnd && !playing && traceDone;
  const gateHeld = step.status === "awaiting_approval" || step.status === "awaiting_merge";
  const runStatus = complete ? "complete" : gateHeld ? (step.status === "awaiting_merge" ? "awaiting merge" : "awaiting approval") : playing ? "running" : "paused";
  const replay = () => { setI(0); setLineN(0); setPlaying(true); };
  const lineTone = (l: string) => l.startsWith("✓") ? "var(--safe)" : l.startsWith("⛔") ? "var(--danger)" : l.startsWith("⚠") ? "var(--warn)" : l.startsWith("⏸") ? "var(--hold)" : "var(--text-dim)";

  return (
    <div className="mk-section">
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            v2 Pipeline Run
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 11px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 11, fontWeight: 500 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: gateHeld ? "var(--hold)" : "var(--cyan)", boxShadow: gateHeld ? "none" : "var(--glow-cyan)", animation: playing && !gateHeld ? "pulse 1.4s ease-in-out infinite" : "none" }} />
              {runStatus}
            </span>
          </h1>
          <p style={{ color: "var(--muted)", fontSize: ".9rem", marginTop: 6 }}>
            Watch a <code className="mono" style={{ color: "var(--cyan)" }}>CREATE INDEX CONCURRENTLY</code> travel the full v2 pipeline — GitHub PR intake, staging dry-run, promotion to prod, approval gate, export PR, merge-verified apply.
          </p>
        </div>
        <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="btn btn-cyan btn-sm">Open live console</Link>
      </div>

      {/* Phase tracker + progress */}
      <div className="glass" style={{ padding: "14px 18px", marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
          {DEMO_STEPS.map((s, idx) => {
            const state = idx < i ? "done" : idx === i ? "active" : "pending";
            const envColor = s.env ? ENV_COLORS[s.env] : undefined;
            return (
              <button
                key={idx}
                onClick={() => goto(idx)}
                title={s.title}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 8, cursor: "pointer",
                  fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)",
                  border: `1px solid ${state === "active" ? "var(--cyan)" : "var(--line)"}`,
                  background: state === "active" ? "rgba(124,58,237,.12)" : "transparent",
                  color: state === "done" ? "var(--safe)" : state === "active" ? "var(--cyan)" : "var(--faint)",
                }}
              >
                <span>{state === "done" ? "✓" : String(idx + 1).padStart(2, "0")}</span>
                {s.phase}
                {envColor && (
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: envColor, flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
        <div style={{ height: 5, borderRadius: 3, background: "var(--line-strong)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, var(--cyan-deep), var(--cyan) 60%, var(--magenta))", transition: "width .3s ease" }} />
        </div>
      </div>

      <div className="demo-grid">
        {/* Main panel */}
        <section className="glass" style={{ padding: "1.5rem", animation: "fadeIn .35s ease" }} key={i}>
          {(step.status === "awaiting_approval" || step.status === "awaiting_merge") && (
            <div className="paused-banner" style={{ marginBottom: 12 }}>
              <span className="pulse-dot" /> {step.status === "awaiting_merge"
                ? "GATE 2 — export PR open. Apply blocked until merge."
                : "GATE 1 — agent paused. No production changes made."}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--cyan)" }}>
              PHASE {String(i + 1).padStart(2, "0")} · {step.phase.toUpperCase()}
            </div>
            {step.env && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "1px 8px", borderRadius: 999, fontSize: 10, fontWeight: 600,
                fontFamily: "var(--font-mono)", textTransform: "uppercase",
                color: ENV_COLORS[step.env], border: `1px solid color-mix(in srgb, ${ENV_COLORS[step.env]} 35%, transparent)`,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: ENV_COLORS[step.env] }} />
                {step.env}
              </span>
            )}
          </div>
          <h3 style={{ marginTop: 0, color: "var(--text)" }}>{step.title}</h3>
          <p style={{ color: "var(--muted)" }}>{step.detail}</p>

          {/* PR info */}
          {step.prInfo && (
            <div style={{ borderLeft: "4px solid var(--cyan)", paddingLeft: 12, marginTop: 12 }}>
              <p className="mono" style={{ margin: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--muted)" }}>repo:</span>{" "}
                <span style={{ color: "var(--text)" }}>{step.prInfo.repo}</span>
                <span style={{ color: "var(--cyan)" }}>#{step.prInfo.prNumber}</span>
              </p>
              <p className="mono" style={{ margin: "4px 0", fontSize: 13, color: "var(--muted)" }}>
                file: {step.prInfo.file}
              </p>
              <p style={{ margin: "4px 0", fontSize: 13, color: "var(--text-dim)" }}>
                &ldquo;{step.prInfo.title}&rdquo;
              </p>
            </div>
          )}

          {/* SQL wells */}
          {step.up && (
            <>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, fontFamily: "var(--font-mono)" }}>up.sql</div>
              <pre className="sql-well" style={{ margin: "4px 0 10px" }}>{step.up}</pre>
              <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>down.sql</div>
              <pre className="sql-well" style={{ margin: "4px 0", borderLeft: "3px solid var(--muted)" }}>{step.down}</pre>
            </>
          )}

          {/* Qodo review */}
          {step.qodo && (
            <p>
              <span className={`sev-chip ${step.qodo.verdict === "passed" ? "sev-green" : "sev-amber"}`}>
                {step.qodo.verdict.replace(/_/g, " ")}
              </span>{" "}
              {step.qodo.findings.length > 0 && (
                <span style={{ color: "var(--muted)" }}>{step.qodo.findings.join(" ")}</span>
              )}
            </p>
          )}

          {/* Blast radius */}
          {step.blast && (
            <div style={{ borderLeft: `4px solid ${step.blast.overallSeverity === "green" ? "var(--safe)" : step.blast.overallSeverity === "amber" ? "var(--warn)" : "var(--danger)"}`, paddingLeft: 12, marginTop: 12 }}>
              <p style={{ margin: "6px 0" }}>Overall: <SeverityChip severity={step.blast.overallSeverity} /></p>
              <p className="mono" style={{ margin: "4px 0", color: "var(--muted)" }}>Rows affected (est.): {step.blast.rowsAffected.toLocaleString()}</p>
              <p className="mono" style={{ margin: "4px 0", color: "var(--muted)" }}>Est. lock: {step.blast.estLockMs.toLocaleString()} ms</p>
              <p style={{ margin: "4px 0" }}>Rollback: <span className={`sev-chip ${step.blast.rollbackVerified ? "sev-green" : "sev-red"}`}>{step.blast.rollbackVerified ? "Proven" : "Not proven"}</span></p>
              {step.blast.findings.map((f, k) => (
                <div key={k} style={{ fontSize: 13, color: "var(--muted)" }}>
                  &bull; {f.note} {f.lockType ? <span className="mono">({f.lockType})</span> : null}
                </div>
              ))}
            </div>
          )}

          {/* Promotion rail */}
          {step.promotion && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(124,58,237,0.06)", border: "1px solid var(--line)" }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                fontFamily: "var(--font-mono)", textTransform: "uppercase",
                color: ENV_COLORS[step.promotion.from], border: `1px solid color-mix(in srgb, ${ENV_COLORS[step.promotion.from]} 35%, transparent)`,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: ENV_COLORS[step.promotion.from] }} />
                {step.promotion.from}
              </span>
              <span style={{ color: "var(--cyan)", fontSize: 18 }}>→</span>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                fontFamily: "var(--font-mono)", textTransform: "uppercase",
                color: ENV_COLORS[step.promotion.to], border: `1px solid color-mix(in srgb, ${ENV_COLORS[step.promotion.to]} 35%, transparent)`,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: ENV_COLORS[step.promotion.to] }} />
                {step.promotion.to}
              </span>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--safe)", fontWeight: 600 }}>RAIL UNLOCKED</span>
            </div>
          )}

          {/* Export PR */}
          {step.exportPr && (
            <div style={{ borderLeft: "4px solid var(--hold)", paddingLeft: 12, marginTop: 12 }}>
              <p className="mono" style={{ margin: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--muted)" }}>export repo:</span>{" "}
                <span style={{ color: "var(--text)" }}>{step.exportPr.repo}</span>
                <span style={{ color: "var(--hold)" }}>#{step.exportPr.prNumber}</span>
              </p>
              <p className="mono" style={{ margin: "4px 0", fontSize: 13, color: "var(--muted)" }}>
                branch: {step.exportPr.branch}
              </p>
              <p style={{ margin: "4px 0" }}>
                <span className="sev-chip sev-amber">PR {step.exportPr.state} — awaiting merge</span>
              </p>
            </div>
          )}

          {/* Gate */}
          {step.gate && (
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12 }}>
              <span className="sev-chip sev-red">Irreversible — type &ldquo;{step.gate.confirmWord}&rdquo; to confirm</span>
            </div>
          )}

          {/* Applied success */}
          {step.status === "applied" && (traceDone ? (
            <div className="sev-chip sev-green" style={{ marginTop: 8 }}>
              Applied with guards{step.env ? ` on ${step.env}` : ""} · audit written
            </div>
          ) : (
            <div className="sev-chip sev-amber" style={{ marginTop: 8 }}>Applying · timeouts, transaction, auto-rollback armed</div>
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
      <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" disabled={i === 0} onClick={() => goto(i - 1)}>&#8249; Prev</button>
        <button className="btn btn-cyan" onClick={() => (complete ? replay() : setPlaying((p) => !p))}>
          {complete ? "Replay" : playing ? "Pause" : "Play"}
        </button>
        <button className="btn" disabled={atEnd} onClick={() => goto(i + 1)}>Next &#8250;</button>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--faint)" }}>
          {String(i + 1).padStart(2, "0")} / {String(DEMO_STEPS.length).padStart(2, "0")} · {step.phase}
          {step.env && <span style={{ color: ENV_COLORS[step.env], marginLeft: 6 }}>[{step.env}]</span>}
        </span>
      </div>
    </div>
  );
}
