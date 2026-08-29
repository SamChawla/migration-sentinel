import Link from "next/link";
import { PipelineFlow } from "@/components/PipelineFlow";

export const metadata = { title: "Documentation — Migration Sentinel" };

const ARCH = [
  { pkg: "packages/core", desc: "State machine, gate policy, disposition, and the read-only SQL guard. The safety brain — no I/O, no dependencies, fully unit-tested." },
  { pkg: "packages/shadow", desc: "Shadow database cloning, dry-run execution, schema diff, and rollback proof. Connects to Postgres to test migrations without touching production." },
  { pkg: "packages/agent", desc: "TrueForge agent harness. Receives migration intents, orchestrates the pipeline, calls tools, and pauses at the gate." },
  { pkg: "packages/qodo", desc: "Qodo code review client. Sends generated SQL for automated review before the shadow run." },
  { pkg: "packages/db", desc: "Drizzle ORM schema and migration tracking. Stores requests, audit events, and pipeline state." },
  { pkg: "apps/web", desc: "Next.js approval console. Dashboard, migration list, approval view with blast report, audit log, settings." },
];

const SAFETY = [
  { rule: "The model cannot self-approve", detail: "The gate is enforced in packages/core/gate.ts, independent of the agent. Even if the agent prompt is compromised, apply() throws without a human decision." },
  { rule: "RED severity requires typed confirmation", detail: "Irreversible operations (DROP, TRUNCATE, data-type narrowing) require the approver to type the exact confirmation word. The button is disabled until the input matches." },
  { rule: "Rollback is proven, not assumed", detail: "The down migration is executed on a shadow clone and the schema is diffed back to the original. If the diff doesn't match, the rollback is marked unproven." },
  { rule: "Read-only query guard", detail: "Every pre-flight probe goes through a guard that rejects any statement with a write operation — only a single read-only SELECT/WITH runs. Probes read the target's own rows (e.g. counting would-be duplicate or NULL values) to prove the migration won't fail on real data; nothing is copied or mutated." },
  { rule: "Every signal feeds the gate", detail: "Blast classifier, rollback verifier, read-only guard, and pre-flight checks each feed the deterministic disposition. A whole-dataset destruction is refused outright; other adverse signals (unproven rollback, failing or unprovable pre-flight) escalate the gate to a typed confirmation." },
];

export default function Docs() {
  return (
    <>
      <header className="hero" style={{ padding: "4rem 2rem 3rem" }}>
        <span style={{ display: "inline-block", padding: "4px 14px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 12, fontWeight: 500 }}>
          Documentation
        </span>
        <h1>
          How <span className="accent">Migration Sentinel</span> works
        </h1>
        <p className="lead">
          Architecture, safety model, and the seven-stage pipeline explained.
        </p>
      </header>

      <section className="mk-section" id="pipeline">
        <h2>The pipeline</h2>
        <p className="sect-sub">
          Every migration request travels through seven stages. The agent is physically paused at Stage 5 — the human gate — until an approver decides.
        </p>
        <div className="glass" style={{ padding: "1.8rem 1.2rem" }}>
          <PipelineFlow />
        </div>

        <div className="doc-steps">
          <div className="doc-step glass">
            <div className="doc-step-num">1</div>
            <div><h3>Intake</h3><p style={{ color: "var(--muted)" }}>A migration request enters the system — either a developer's plain-English description or direct SQL.</p></div>
          </div>
          <div className="doc-step glass">
            <div className="doc-step-num">2</div>
            <div><h3>Generate</h3><p style={{ color: "var(--muted)" }}>For a plain-English request the agent writes a safe up/down migration pair — and for dangerous patterns (SET NOT NULL with existing NULLs) a two-phase approach. Direct SQL is taken as submitted and carried straight into review.</p></div>
          </div>
          <div className="doc-step glass">
            <div className="doc-step-num">3</div>
            <div><h3>Qodo review</h3><p style={{ color: "var(--muted)" }}>The generated SQL is sent for automated code review. Findings are attached to the blast report for the human approver.</p></div>
          </div>
          <div className="doc-step glass">
            <div className="doc-step-num">4</div>
            <div><h3>Shadow dry-run</h3><p style={{ color: "var(--muted)" }}>The migration runs on a schema-only shadow clone. Blast radius (rows affected, lock type, downtime) is <b>estimated from the target's own planner statistics</b> — no production data is copied. Rollback is tested on the clone.</p></div>
          </div>
          <div className="doc-step glass" style={{ borderColor: "var(--hold)" }}>
            <div className="doc-step-num" style={{ background: "var(--hold)", color: "var(--space-0)" }}>5</div>
            <div><h3>Human gate</h3><p style={{ color: "var(--muted)" }}>The agent pauses. The blast report, rollback proof, and Qodo findings are presented. RED severity requires typed confirmation. The model cannot proceed without a human decision.</p></div>
          </div>
          <div className="doc-step glass">
            <div className="doc-step-num">6</div>
            <div><h3>Guarded apply</h3><p style={{ color: "var(--muted)" }}>On approval, the migration runs with <span className="mono">lock_timeout</span> + <span className="mono">statement_timeout</span> guards. Transactional migrations run in one transaction and roll back on any error; non-transactional statements (e.g. <span className="mono">CREATE INDEX CONCURRENTLY</span>) run in autocommit and are detected + isolated so a partial change is surfaced, not silently committed.</p></div>
          </div>
          <div className="doc-step glass">
            <div className="doc-step-num">7</div>
            <div><h3>Audit</h3><p style={{ color: "var(--muted)" }}>Every action is logged to an append-only audit trail: who approved, when, what changed, blast report attached.</p></div>
          </div>
        </div>
      </section>

      <section className="mk-section" id="trueforge">
        <h2>The agent engine — TrueForge</h2>
        <p className="sect-sub">Both the orchestration and the human gate run on the TrueForge harness.</p>
        <div className="glass glass-energized" style={{ padding: "1.6rem 1.5rem" }}>
          <p style={{ margin: 0, fontSize: ".95rem", lineHeight: 1.75, color: "var(--muted)" }}>
            The agent runs on <b style={{ color: "var(--text)" }}>TrueForge</b>{" "}
            (<code className="mono" style={{ color: "var(--cyan)" }}>@truefoundry/trueforge-sdk</code>): it opens a session,
            streams the turn that generates the migration, and calls tools to drive the pipeline. The{" "}
            <code className="mono" style={{ color: "var(--cyan)" }}>apply_migration</code> tool is registered as{" "}
            <b style={{ color: "var(--text)" }}>approval-required</b> — when the agent calls it, TrueForge emits{" "}
            <code className="mono">tool.approval_required</code> and pauses the turn. We resume it with{" "}
            <code className="mono">user.tool_approval</code> <b style={{ color: "var(--text)" }}>only</b> after our own
            independent gate (<code className="mono">packages/core</code>) records a human decision — so the model
            can never self-approve. Blast, rollback, Qodo and pre-flight run as independent checks the agent orchestrates.
          </p>
        </div>
      </section>

      <section className="mk-section" id="architecture">
        <h2>Architecture</h2>
        <p className="sect-sub">A pnpm monorepo with clear package boundaries. The safety core has zero I/O dependencies — it's pure logic, fully testable.</p>
        <div className="doc-arch-grid">
          {ARCH.map((a) => (
            <div key={a.pkg} className="glass" style={{ padding: "1rem 1.2rem" }}>
              <h3 style={{ margin: "0 0 .3rem" }}><code className="mono" style={{ color: "var(--cyan)", fontSize: ".9rem" }}>{a.pkg}</code></h3>
              <p style={{ margin: 0, fontSize: ".88rem", lineHeight: 1.6, color: "var(--muted)" }}>{a.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section" id="safety">
        <h2>Safety model</h2>
        <p className="sect-sub">Five rules that cannot be disabled, even by an admin.</p>
        <div className="doc-safety-list">
          {SAFETY.map((s, idx) => (
            <div key={idx} className="glass" style={{ display: "flex", gap: 16, alignItems: "flex-start", padding: "1rem 1.2rem" }}>
              <span className="sev-chip sev-red" style={{ flexShrink: 0 }}>Rule {idx + 1}</span>
              <div>
                <h3 style={{ margin: "0 0 .3rem", color: "var(--text)" }}>{s.rule}</h3>
                <p style={{ margin: 0, fontSize: ".88rem", lineHeight: 1.6, color: "var(--muted)" }}>{s.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section" style={{ textAlign: "center" }}>
        <div className="glass glass-energized" style={{ padding: "2.2rem 2rem" }}>
          <h2 style={{ marginBottom: ".5rem" }}>See it in action</h2>
          <p className="sect-sub" style={{ marginBottom: "1.4rem" }}>
            The demo replays a real migration run step by step — no setup needed.
          </p>
          <div className="hero-ctas">
            <Link href="/demo" className="btn btn-cyan btn-lg">Watch the demo</Link>
            <Link href="/login" className="btn btn-lg">Open the console</Link>
          </div>
        </div>
      </section>
    </>
  );
}
