import Link from "next/link";

export const metadata = { title: "About — Migration Sentinel" };

const PRINCIPLES = [
  { ico: "⏸️", title: "The gate is the product", body: "Every migration pauses at a human checkpoint before touching production. The agent is physically paused — it cannot self-approve. This is the one thing we refuse to compromise on." },
  { ico: "🔬", title: "Prove, don’t promise", body: "Rollback verification runs on a shadow clone. Blast radius comes from the database’s own planner. Nothing is estimated — everything is tested." },
  { ico: "🪶", title: "Zero production data", body: "We never clone production data. Schema-only shadows and read-only catalog queries mean near-zero cost and no compliance risk." },
  { ico: "🤝", title: "Open architecture", body: "Built on Postgres, Drizzle, and standard SQL tooling. No proprietary lock-in, no custom DSL. Prod changes flow back to your repo as a reviewable PR, so your merge workflow stays the owner of production." },
];

const STACK = [
  { name: "TrueForge", role: "Agent orchestration & tool execution" },
  { name: "Postgres", role: "Target database & shadow cloning" },
  { name: "Qodo", role: "Automated migration code review" },
  { name: "Drizzle", role: "Schema definition & migration tracking" },
  { name: "Next.js", role: "Approval console & dashboard UI" },
  { name: "TypeScript", role: "End-to-end type safety across all packages" },
];

export default function About() {
  return (
    <>
      <header className="ed-page-header">
        <span className="ed-tag">About the project</span>
        <h1>Making database migrations <em>safe by default</em></h1>
        <p className="ed-lead">
          Migration Sentinel was built for the TrueForge Agent Harness Hackathon (WeMakeDevs &times; TrueFoundry, Aug 24&ndash;30 2026)
          with a single conviction: AI agents should never make irreversible changes without human approval.
        </p>
      </header>

      {/* ── PRINCIPLES ── */}
      <section className="ed-section" style={{ paddingTop: 0 }}>
        <h2>Core principles</h2>
        <p className="ed-sub">Every design decision traces back to one of these.</p>
        <div className="ed-feature-grid">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="ed-feature">
              <div className="ed-feature-ico">{p.ico}</div>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── TRUEFORGE ── */}
      <div className="ed-section-alt">
        <div className="ed-section-inner" style={{ textAlign: "center", maxWidth: 720, margin: "0 auto" }}>
          <span className="ed-tag">Powered by TrueForge</span>
          <h2 style={{ marginTop: 16 }}>The agent runs on TrueForge</h2>
          <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.8, marginTop: 12 }}>
            Migration Sentinel is built on the <strong style={{ color: "var(--ink)" }}>TrueForge</strong> agent harness —
            sessions, streaming turns, and a first-class <strong style={{ color: "var(--ink)" }}>tool-approval</strong> loop.
            That loop <em>is</em> our human gate: the <code style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--coral)" }}>apply_migration</code> tool
            is registered as approval-required, so the agent&apos;s turn physically pauses until an operator decides.
          </p>
        </div>
      </div>

      {/* ── STACK ── */}
      <section className="ed-section">
        <h2>Built with</h2>
        <p className="ed-sub">A pnpm monorepo with clear separation of concerns — safety core, agent, UI, and database are independent packages.</p>
        <div className="ed-stack-grid">
          {STACK.map((s) => (
            <div key={s.name} className="ed-stack-item">
              <h3>{s.name}</h3>
              <p>{s.role}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="ed-section-cta">
        <h2>Try it yourself</h2>
        <p>
          The demo console has real migrations waiting — approve or reject them to see the gate in action.
        </p>
        <div className="ed-cta-actions">
          <Link href="/login" className="btn-dark">Open the console</Link>
          <Link href="/demo" className="btn-ghost">Watch the demo replay</Link>
        </div>
      </section>
    </>
  );
}
