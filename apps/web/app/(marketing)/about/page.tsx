import Link from "next/link";

export const metadata = { title: "About — Migration Sentinel" };

const PRINCIPLES = [
  { ico: "⏸️", title: "The gate is the product", body: "Every migration pauses at a human checkpoint before touching production. The agent is physically paused — it cannot self-approve. This is the one thing we refuse to compromise on." },
  { ico: "🔬", title: "Prove, don't promise", body: "Rollback verification runs on a shadow clone. Blast radius comes from the database's own planner. Nothing is estimated — everything is tested." },
  { ico: "🪶", title: "Zero production data", body: "We never clone production data. Schema-only shadows and read-only catalog queries mean near-zero cost and no compliance risk." },
  { ico: "🤝", title: "Open architecture", body: "Built on Postgres, Drizzle, and standard SQL tooling. No proprietary lock-in, no custom DSL. Your existing migration workflow stays intact." },
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
      <header className="hero" style={{ padding: "4rem 2rem 3rem" }}>
        <span style={{ display: "inline-block", padding: "4px 14px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 12, fontWeight: 500 }}>
          About the project
        </span>
        <h1>
          Making database migrations <span className="accent">safe by default</span>
        </h1>
        <p className="lead">
          Migration Sentinel was built for the TrueForge Agent Harness Hackathon (WeMakeDevs × TrueFoundry, Aug 24–30 2026)
          with a single conviction: AI agents should never make irreversible changes without human approval.
        </p>
      </header>

      <section className="mk-section">
        <h2>Core principles</h2>
        <p className="sect-sub">Every design decision traces back to one of these.</p>
        <div className="mk-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="glass mk-feature">
              <div className="f-ico">{p.ico}</div>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mk-stats-band">
        <div style={{ maxWidth: 900, margin: "0 auto", textAlign: "center", padding: "0 1rem" }}>
          <span className="mono" style={{ fontSize: 12, letterSpacing: ".12em", color: "var(--cyan)" }}>⚡ POWERED BY TRUEFORGE</span>
          <h2 style={{ margin: "12px 0 10px" }}>The agent runs on TrueForge</h2>
          <p style={{ color: "var(--muted)", fontSize: ".97rem", lineHeight: 1.75, margin: 0 }}>
            Migration Sentinel is built on the <b style={{ color: "var(--text)" }}>TrueForge</b> agent harness —
            sessions, streaming turns, and a first-class <b style={{ color: "var(--text)" }}>tool-approval</b> loop.
            That loop <i>is</i> our human gate: the <span className="mono" style={{ color: "var(--cyan)" }}>apply_migration</span> tool
            is registered as approval-required, so the agent's turn physically pauses until an operator decides.
            Blast · rollback · Qodo · pre-flight run as independent checks the agent orchestrates.
          </p>
        </div>
      </div>

      <section className="mk-section">
        <h2>Built with</h2>
        <p className="sect-sub">A pnpm monorepo with clear separation of concerns — safety core, agent, UI, and database are independent packages.</p>
        <div className="mk-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {STACK.map((s) => (
            <div key={s.name} className="glass" style={{ textAlign: "center", padding: "1.2rem" }}>
              <h3 style={{ margin: "0 0 .3rem", color: "var(--text)" }}>{s.name}</h3>
              <p style={{ margin: 0, fontSize: ".88rem", color: "var(--muted)" }}>{s.role}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section" style={{ textAlign: "center" }}>
        <div className="glass glass-energized" style={{ padding: "2.2rem 2rem" }}>
          <h2 style={{ marginBottom: ".5rem" }}>Try it yourself</h2>
          <p className="sect-sub" style={{ marginBottom: "1.4rem" }}>
            The demo console has real migrations waiting — approve or reject them to see the gate in action.
          </p>
          <div className="hero-ctas">
            <Link href="/login" className="btn btn-cyan btn-lg">Open the console</Link>
            <Link href="/demo" className="btn btn-lg">Watch the demo replay</Link>
          </div>
        </div>
      </section>
    </>
  );
}
