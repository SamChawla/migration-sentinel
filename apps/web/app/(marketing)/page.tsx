import Link from "next/link";

export const dynamic = "force-dynamic";

const OPEN_ACCESS = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase()
);

const STEPS = [
  { n: "1", name: "Intake", desc: "Plain English, SQL, or a PR diff" },
  { n: "2", name: "Generate", desc: "Paired up + down migration" },
  { n: "3", name: "Code review", desc: "Advisory review via Qodo" },
  { n: "4", name: "Shadow dry-run", desc: "Blast radius + rollback proof" },
  { n: "5", name: "Human gate", desc: "You decide — agent cannot proceed", gate: true },
  { n: "6", name: "Guarded apply", desc: "Timeouts, txn, auto-rollback" },
  { n: "7", name: "Audit", desc: "Append-only record" },
];

const CAPABILITIES = [
  { title: "Blast radius before prod", desc: "Shadow dry-run plus your database's own planner statistics: rows affected, lock type, estimated downtime — before anything runs." },
  { title: "Rollback proven, not assumed", desc: "Every migration's down script is executed on a shadow clone and the schema diffed back. If data can't be restored, we say so." },
  { title: "Human gate, keyed to danger", desc: "Irreversible operations demand typed confirmation. The gate is enforced server-side — the model cannot self-approve." },
  { title: "Author from intent", desc: "Describe the change in plain English or paste a PR. The agent writes a safe up/down pair for you." },
  { title: "Data pre-flight probes", desc: "SET NOT NULL with existing NULLs? We probe the real data read-only, catch the failure before it happens, and regenerate a two-phase migration." },
  { title: "Near-zero cost", desc: "No production data is ever cloned. Schema-only shadows + read-only catalog stats — the only real cost is a few model calls." },
];

type Cell = { cls: string; text: string };
const TOOLS: { name: string; cells: Cell[]; highlight?: boolean }[] = [
  { name: "Alembic", cells: [
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Django Migrations", cells: [
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Flyway", cells: [
    { cls: "no", text: "—" }, { cls: "yes", text: "Yes" },
    { cls: "no", text: "—" }, { cls: "partial", text: "Undo (paid)" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Liquibase", cells: [
    { cls: "partial", text: "Diff-based" }, { cls: "yes", text: "Yes" },
    { cls: "partial", text: "updateSQL" }, { cls: "partial", text: "Manual" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Atlas", cells: [
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "partial", text: "Lint only" }, { cls: "no", text: "—" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Prisma Migrate", cells: [
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
    { cls: "no", text: "—" }, { cls: "no", text: "—" },
  ] },
  { name: "Migration Sentinel", cells: [
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
    { cls: "yes", text: "Yes" }, { cls: "yes", text: "Yes" },
  ], highlight: true },
];

const Arrow = () => (
  <div className="flow-arrow">
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M7 4L13 10L7 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

export default function Landing() {
  return (
    <>
      {/* ── HERO ── */}
      <section className="ed-hero">
        <div className="hero-main">
          <p className="hero-context">TrueForge Agent Harness Hackathon &middot; WeMakeDevs &times; TrueFoundry</p>
          <h1>The migration agent that <em>pauses before anything irreversible.</em></h1>
          <p className="hero-body">
            Schema migrations are the most dangerous routine operation in software.
            Sentinel plans them, dry-runs on a shadow database, proves the rollback,
            and won&apos;t touch production until you approve.
          </p>
          <div className="hero-actions">
            <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="btn-dark">
              Open the console
            </Link>
            <Link href="/demo" className="btn-ghost">Watch replay demo</Link>
          </div>
        </div>

        <div>
          <div className="hero-card">
            <div className="hero-card-header">
              <span>Migration #24</span>
              <span className="status-safe">Safe</span>
            </div>
            <div className="hero-card-body">
              <div className="hero-card-row">
                <span className="label">Operation</span>
                <span className="value safe">ADD COLUMN</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Table</span>
                <span className="value">users</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Rows affected</span>
                <span className="value">0</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Rollback</span>
                <span className="value safe">{"✓"} verified</span>
              </div>
            </div>
          </div>

          <div className="hero-card">
            <div className="hero-card-header">
              <span>Migration #25</span>
              <span className="status-risk">High risk</span>
            </div>
            <div className="hero-card-body">
              <div className="hero-card-row">
                <span className="label">Operation</span>
                <span className="value danger">DROP COLUMN</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Table</span>
                <span className="value">users.legacy_email</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Non-null values</span>
                <span className="value danger">847,291</span>
              </div>
              <div className="hero-card-row">
                <span className="label">Rollback</span>
                <span className="value danger">{"✗"} data loss permanent</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SIGNATURE MOMENT ── */}
      <div className="blocked">
        <div className="blocked-sql">
          <span className="kw">ALTER TABLE</span> users{" "}
          <span className="kw">DROP COLUMN</span> legacy_email;
        </div>
        <p className="blocked-caption">
          847,291 non-null values. Irreversible. The agent generated this migration,
          proved it can&apos;t be rolled back, and <strong>escalated</strong> —
          it requires you to type the exact confirmation before it will apply.
          Unbounded destruction (a bare DELETE, a DROP TABLE) goes further:
          the gate <strong>refuses outright</strong>, approval or not.
        </p>
      </div>

      {/* ── PIPELINE ── */}
      <section className="pipeline" id="pipeline">
        <div className="pipeline-header">
          <h2>One migration, seven checkpoints.</h2>
          <p>Every request travels the same path. Nothing skips the gate — the agent is physically paused until you decide.</p>
        </div>
        <div className="pipeline-steps">
          {STEPS.map((s) => (
            <div key={s.n} className={`p-step${s.gate ? " gate" : ""}`}>
              <div className="p-step-num">{s.n}</div>
              <div className="p-step-name">{s.name}</div>
              <div className="p-step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
        <p className="pipeline-footnote">
          Think of it this way: <code>alembic</code> is <code>git commit</code>.
          Migration Sentinel is the CI + code review + {"“"}are you sure?{"”"} gate
          that runs before that commit hits production.
        </p>
      </section>

      {/* ── CAPABILITIES ── */}
      <section className="capabilities" id="capabilities">
        <div className="cap-inner">
          <div className="cap-header">
            <h2>What only Sentinel does.</h2>
            <p>Six things your migration tool doesn&apos;t do today — and the reason none of them require you to switch tools.</p>
          </div>
          <div className="cap-list">
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="cap-item">
                <div className="cap-item-title">{c.title}</div>
                <div className="cap-item-desc">{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHERE IT FITS ── */}
      <section className="positioning" id="positioning">
        <div className="pos-header">
          <h2>Your ORM writes migrations. Sentinel makes them safe.</h2>
          <div className="pos-header-text">
            <p>
              Django, SQLAlchemy, Prisma — they all generate migration files.
              Alembic, Flyway, Liquibase — they all track and apply them.
              None of them analyze what the migration will actually do to your data before it runs.
            </p>
            <p>
              Sentinel isn&apos;t a replacement for any of these. It&apos;s the missing
              layer between {"“"}migration generated{"”"} and {"“"}migration
              applied to prod{"”"} — the safety gate that doesn&apos;t exist in your current stack.
            </p>
          </div>
        </div>

        <div className="flow">
          <div className="flow-stage">
            <div className="flow-stage-label">You already have this</div>
            <div className="flow-stage-title">ORM / Schema definition</div>
            <div className="flow-stage-body">
              Your models change. The ORM generates a migration file describing the diff.
            </div>
            <div className="flow-stage-tools">
              <span className="flow-tool">Django ORM</span>
              <span className="flow-tool">SQLAlchemy</span>
              <span className="flow-tool">Prisma</span>
              <span className="flow-tool">TypeORM</span>
            </div>
          </div>

          <Arrow />

          <div className="flow-stage sentinel">
            <div className="flow-stage-label">Sentinel sits here</div>
            <div className="flow-stage-title">Analyze &rarr; Prove &rarr; Gate</div>
            <div className="flow-stage-body">
              Shadow dry-run, blast radius analysis, rollback verification, human
              approval. All before anything touches production.
            </div>
          </div>

          <Arrow />

          <div className="flow-stage">
            <div className="flow-stage-label">You already have this</div>
            <div className="flow-stage-title">Migration runner</div>
            <div className="flow-stage-body">
              Once approved, your existing tool applies the migration. Sentinel
              doesn&apos;t replace your runner — it guards it.
            </div>
            <div className="flow-stage-tools">
              <span className="flow-tool">Alembic</span>
              <span className="flow-tool">Flyway</span>
              <span className="flow-tool">Liquibase</span>
              <span className="flow-tool">Atlas</span>
            </div>
          </div>
        </div>

        <div className="flow-compare">
          <div className="flow-compare-card without">
            <div className="flow-compare-label">Without Sentinel</div>
            <div className="flow-compare-steps">
              <div>models.py changed</div>
              <div>&rarr; makemigrations</div>
              <div>&rarr; migrate <span className="dimmed">&larr; hope for the best</span></div>
              <div><span className="strike">&rarr; 3 AM incident page</span></div>
            </div>
          </div>
          <div className="flow-compare-card with">
            <div className="flow-compare-label">With Sentinel</div>
            <div className="flow-compare-steps">
              <div>models.py changed</div>
              <div>&rarr; makemigrations</div>
              <div className="added">&rarr; sentinel: dry-run, prove rollback, show blast radius</div>
              <div className="added">&rarr; human approves (or rejects)</div>
              <div>&rarr; migrate</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── COMPARISON TABLE ── */}
      <section className="comparison" id="compare">
        <div className="comparison-inner">
          <div className="comparison-header">
            <h2>Sentinel complements your existing tools.</h2>
            <p>Every tool below handles one part of the migration lifecycle. Sentinel adds the safety layer none of them have.</p>
          </div>
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Generates migrations</th>
                  <th>Tracks history</th>
                  <th>Shadow dry-run</th>
                  <th>Proves rollback</th>
                  <th>Blast radius</th>
                  <th>Human gate</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((t) => (
                  <tr key={t.name} className={t.highlight ? "sentinel-row" : undefined}>
                    <td>{t.name}</td>
                    {t.cells.map((c, i) => (
                      <td key={i}><span className={c.cls}>{c.text}</span></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="comp-note">
            Sentinel works alongside these tools, not instead of them. Use your ORM to
            define schemas, your migration tool to track versions, and Sentinel to make
            sure nothing dangerous reaches production without your approval.
          </p>
        </div>
      </section>

      {/* ── DEMO CTA ── */}
      <section className="demo" id="demo">
        <h2>See the gate catch a <span className="drop">DROP COLUMN</span></h2>
        <p>Two migrations are waiting in the console — one safe, one irreversible. Decide for yourself.</p>
        <Link href="/demo" className="demo-cta">
          Watch the replay demo
        </Link>
      </section>
    </>
  );
}
