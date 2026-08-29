import Link from "next/link";

export const metadata = { title: "Documentation — Migration Sentinel" };

const ARCH = [
  { pkg: "packages/core", desc: "State machine, gate policy, disposition, and the read-only SQL guard. The safety brain — no I/O, no dependencies, fully unit-tested." },
  { pkg: "packages/shadow", desc: "Shadow database cloning, dry-run execution, schema diff, and rollback proof. Connects to Postgres to test migrations without touching production." },
  { pkg: "packages/agent", desc: "TrueForge agent harness. Receives migration intents, orchestrates the pipeline, calls tools, and pauses at the gate." },
  { pkg: "packages/qodo", desc: "Qodo code review client. Sends generated SQL for automated review before the shadow run." },
  { pkg: "packages/db", desc: "Drizzle ORM schema and migration tracking. Stores requests, audit events, and pipeline state." },
  { pkg: "apps/web", desc: "Next.js approval console. Dashboard, migration list, approval view with blast report, audit log, settings." },
];

const STEPS = [
  { n: "1", name: "Intake", desc: "A migration request enters the system — either a developer's plain-English description or direct SQL." },
  { n: "2", name: "Generate", desc: "For a plain-English request the agent writes a safe up/down migration pair — and for dangerous patterns (SET NOT NULL with existing NULLs) a two-phase approach. Direct SQL is taken as submitted and carried straight into review." },
  { n: "3", name: "Qodo review", desc: "The generated SQL is sent for automated code review. Findings are attached to the blast report for the human approver." },
  { n: "4", name: "Shadow dry-run", desc: "The migration runs on a schema-only shadow clone. Blast radius (rows affected, lock type, downtime) is estimated from the target's own planner statistics — no production data is copied. Rollback is tested on the clone." },
  { n: "5", name: "Human gate", desc: "The agent pauses. The blast report, rollback proof, and Qodo findings are presented. RED severity requires typed confirmation. The model cannot proceed without a human decision.", gate: true },
  { n: "6", name: "Guarded apply", desc: "On approval, the migration runs with lock_timeout + statement_timeout guards. Transactional migrations run in one transaction and roll back on any error." },
  { n: "7", name: "Audit", desc: "Every action is logged to an append-only audit trail: who approved, when, what changed, blast report attached." },
];

const SAFETY = [
  { rule: "The model cannot self-approve", detail: "The gate is enforced in packages/core/gate.ts, independent of the agent. Even if the agent prompt is compromised, apply() throws without a human decision." },
  { rule: "RED severity requires typed confirmation", detail: "Irreversible operations (DROP, TRUNCATE, data-type narrowing) require the approver to type the exact confirmation word. The button is disabled until the input matches." },
  { rule: "Rollback is proven, not assumed", detail: "The down migration is executed on a shadow clone and the schema is diffed back to the original. If the diff doesn't match, the rollback is marked unproven." },
  { rule: "Read-only query guard", detail: "Every pre-flight probe goes through a guard that rejects any statement with a write operation — only a single read-only SELECT/WITH runs. Probes read the target's own rows (e.g. counting would-be duplicate or NULL values) to prove the migration won't fail on real data; nothing is copied or mutated." },
  { rule: "Every signal feeds the gate", detail: "Blast classifier, rollback verifier, read-only guard, and pre-flight checks each feed the deterministic disposition. A whole-dataset destruction is refused outright; other adverse signals escalate the gate to a typed confirmation." },
];

export default function Docs() {
  return (
    <>
      <header className="ed-page-header">
        <span className="ed-tag">Documentation</span>
        <h1>How <em>Migration Sentinel</em> works</h1>
        <p className="ed-lead">
          Architecture, safety model, and the seven-stage pipeline explained.
        </p>
      </header>

      {/* ── PIPELINE ── */}
      <section className="ed-section" id="pipeline">
        <h2>The pipeline</h2>
        <p className="ed-sub">
          Every migration request travels through seven stages. The agent is physically paused at Stage 5 — the human gate — until an approver decides.
        </p>
        <div className="ed-steps">
          {STEPS.map((s) => (
            <div key={s.n} className={`ed-step${s.gate ? " gate" : ""}`}>
              <div className="ed-step-num">{s.n}</div>
              <div>
                <h3>{s.name}</h3>
                <p>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── TRUEFORGE ── */}
      <div className="ed-section-alt" id="trueforge">
        <div className="ed-section-inner">
          <h2>The agent engine — TrueForge</h2>
          <p className="ed-sub">Both the orchestration and the human gate run on the TrueForge harness.</p>
          <div className="ed-callout accent">
            <p>
              The agent runs on <strong>TrueForge</strong> (<code>@truefoundry/trueforge-sdk</code>): it opens a session,
              streams the turn that generates the migration, and calls tools to drive the pipeline. The <code>apply_migration</code> tool is registered as <strong>approval-required</strong> — when the agent calls it, TrueForge emits <code>tool.approval_required</code> and pauses the turn. We resume it with <code>user.tool_approval</code> <strong>only</strong> after our own
              independent gate (<code>packages/core</code>) records a human decision — so the model
              can never self-approve.
            </p>
          </div>
        </div>
      </div>

      {/* ── ARCHITECTURE ── */}
      <section className="ed-section" id="architecture">
        <h2>Architecture</h2>
        <p className="ed-sub">A pnpm monorepo with clear package boundaries. The safety core has zero I/O dependencies — it&apos;s pure logic, fully testable.</p>
        <div className="ed-arch-grid">
          {ARCH.map((a) => (
            <div key={a.pkg} className="ed-arch-item">
              <h3>{a.pkg}</h3>
              <p>{a.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── SAFETY ── */}
      <div className="ed-section-alt" id="safety">
        <div className="ed-section-inner">
          <h2>Safety model</h2>
          <p className="ed-sub">Five rules that cannot be disabled, even by an admin.</p>
          <div className="ed-rules">
            {SAFETY.map((s, idx) => (
              <div key={idx} className="ed-rule">
                <span className="ed-rule-badge">Rule {idx + 1}</span>
                <div>
                  <h3>{s.rule}</h3>
                  <p>{s.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── CTA ── */}
      <section className="ed-section-cta">
        <h2>See it in action</h2>
        <p>The demo replays a real migration run step by step — no setup needed.</p>
        <div className="ed-cta-actions">
          <Link href="/demo" className="btn-dark">Watch the demo</Link>
          <Link href="/login" className="btn-ghost">Open the console</Link>
        </div>
      </section>
    </>
  );
}
