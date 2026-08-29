import Link from "next/link";

export const dynamic = "force-dynamic";

// Demo: when open access is on, the console needs no login — link straight in.
const OPEN_ACCESS = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase());

type Tone = "cyan" | "warn" | "safe" | "danger";
const PIPELINE: { n: string; title: string; sub: string; tone: Tone; gate?: boolean }[] = [
  { n: "01", title: "Intake", sub: "plain English, SQL, or a PR", tone: "cyan" },
  { n: "02", title: "Generate", sub: "paired up + down SQL", tone: "cyan" },
  { n: "03", title: "Qodo review", sub: "advisory code review", tone: "cyan" },
  { n: "04", title: "Shadow dry-run", sub: "blast radius + rollback proof", tone: "warn" },
  { n: "05", title: "Human gate", sub: "you decide — agent cannot", tone: "warn", gate: true },
  { n: "06", title: "Guarded apply", sub: "timeouts, txn, auto-rollback", tone: "safe" },
  { n: "07", title: "Audit", sub: "append-only record", tone: "safe" },
];

const CAPABILITIES: { n: string; title: string; body: string; phase: string; tone: Tone }[] = [
  { n: "01", title: "Blast radius before prod", body: "A shadow dry-run plus your database's own planner statistics tell you rows affected, lock type, and estimated downtime — before anything runs.", phase: "Analyze", tone: "warn" },
  { n: "02", title: "Rollback proven, not assumed", body: "Every migration's down script is executed on a shadow clone and the schema diffed back. If data can't be restored, we say so — honestly.", phase: "Prove", tone: "safe" },
  { n: "03", title: "A human gate, keyed to danger", body: "Irreversible operations demand a typed confirmation. The gate is enforced server-side, independently of the agent — the model cannot self-approve.", phase: "Gate", tone: "danger" },
  { n: "04", title: "Author from intent", body: "Describe the change in plain English or paste a PR — the agent writes a safe up/down pair for you.", phase: "Intake", tone: "cyan" },
  { n: "05", title: "Data pre-flight probes", body: "SET NOT NULL with existing NULLs? We probe the real data read-only, catch the failure before it happens, and regenerate a two-phase migration.", phase: "Analyze", tone: "warn" },
  { n: "06", title: "Near-zero cost", body: "No production data is ever cloned. Schema-only shadows + read-only catalog stats — the only real cost is a few model calls.", phase: "Prove", tone: "safe" },
];

export default function Landing() {
  return (
    <>
      <div className="mk-statusbar">
        <span className="mk-status-live">
          <span className="dot" /> Human-gated · read-only until you approve
        </span>
        <span className="mk-status-target">
          Connect any Postgres <span className="sep">·</span>{" "}
          <Link href="/login" className="mk-status-link">link your own databases →</Link>
        </span>
      </div>

      <header className="hero">
        <span className="mk-eyebrow">
          <span className="mk-eyebrow-dot" />
          TrueForge Agent Harness Hackathon · WeMakeDevs × TrueFoundry
        </span>
        <h1>
          The AI agent that migrates your database —<br />
          and <span className="accent">pauses before anything</span> <span style={{ color: "var(--danger)" }}>irreversible</span>.
        </h1>
        <p className="lead">
          Schema migrations are the most dangerous routine operation in software. Migration Sentinel plans them,
          dry-runs them on a shadow database, proves the rollback, and refuses to touch prod until a human approves.
        </p>
        <div className="hero-ctas">
          <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="btn btn-cyan btn-lg">
            {OPEN_ACCESS ? "Open the Console" : "Login to Console"}
          </Link>
          <Link href="/demo" className="btn btn-lg">Watch the replay demo</Link>
        </div>
        <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--text-dim)" }}>
          {OPEN_ACCESS
            ? "No login for the demo — click Open the Console and you're in."
            : "Demo credentials are pre-filled — just click Login to Console. No signup."}
        </p>
      </header>

      <section className="mk-section" id="how">
        <div className="mk-kicker"><span /> Pipeline</div>
        <h2 style={{ textAlign: "left" }}>One migration, seven checkpoints</h2>
        <p className="sect-sub" style={{ textAlign: "left", margin: "0 0 2rem" }}>
          Every request travels the same pipeline. Nothing skips the gate — the agent is physically
          paused until you decide.
        </p>

        <div className="mk-pipe">
          {PIPELINE.map((s) => (
            <div key={s.n} className={`mk-pipe-cell${s.gate ? " gate" : ""}`}>
              <div className={`mk-pipe-num tone-${s.tone}`}>{s.n}</div>
              <div className={`mk-pipe-bar tone-${s.tone}`} />
              <div className="mk-pipe-title">{s.title}</div>
              <div className="mk-pipe-sub">{s.sub}</div>
            </div>
          ))}
        </div>

        <p className="mk-aside">
          <b>Alembic is <span className="mono">git commit</span>.</b>{" "}
          Migration Sentinel is the CI + code review + &ldquo;are you sure?&rdquo; gate that runs before that commit hits production.
        </p>
      </section>

      <section className="mk-section" id="features">
        <div className="mk-kicker"><span /> Capabilities</div>
        <h2 style={{ textAlign: "left" }}>What only Migration Sentinel does</h2>
        <p className="sect-sub" style={{ textAlign: "left", margin: "0 0 2rem" }}>
          Not another migration runner — the analyze → prove → gate layer in front of the tools you already use.
        </p>

        <div className="mk-caps">
          {CAPABILITIES.map((c) => (
            <div key={c.n} className="mk-cap-row">
              <div className="mk-cap-num">{c.n}</div>
              <div className="mk-cap-title">{c.title}</div>
              <div className="mk-cap-body">{c.body}</div>
              <div className={`mk-cap-phase tone-${c.tone}`}>
                <span className="dot" /> {c.phase}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section">
        <div className="glass mk-demo">
          <div className="mk-demo-head">
            <span className="mk-kicker mk-kicker-danger"><span /> Live demo</span>
            <span className="mk-status-live warn">
              <span className="dot" /> 2 migrations awaiting operator
            </span>
          </div>
          <div className="mk-demo-body">
            <h2>See the gate refuse a <span className="mono" style={{ color: "var(--danger)" }}>DROP COLUMN</span></h2>
            <p className="sect-sub" style={{ margin: "0 auto 1.6rem" }}>
              Two migrations are waiting in the console right now — one safe, one irreversible. Decide for yourself.
            </p>
            <div className="hero-ctas">
              <Link href="/login" className="btn btn-cyan btn-lg">Open the approval console</Link>
            </div>
            <p style={{ marginTop: "1rem", fontSize: ".82rem", color: "var(--muted)" }}>
              Demo login: <span className="mono">admin / admin</span>
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
