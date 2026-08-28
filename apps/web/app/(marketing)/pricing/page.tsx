import Link from "next/link";

export const metadata = { title: "Pricing — Migration Sentinel" };

const TIERS = [
  {
    name: "Open Source",
    price: "Free",
    period: "forever",
    desc: "Full safety pipeline for individual developers and small teams.",
    cta: "Get started",
    features: [
      "All 7 pipeline stages",
      "Human approval gate",
      "Blast radius analysis",
      "Rollback verification",
      "Shadow dry-run",
      "Qodo code review integration",
      "Audit log",
      "Community support",
    ],
  },
  {
    name: "Team",
    price: "$49",
    period: "per month",
    desc: "For teams that need shared dashboards and role-based approvals.",
    cta: "Start free trial",
    highlight: true,
    features: [
      "Everything in Open Source",
      "Team dashboard & shared migrations",
      "Role-based approval policies",
      "Slack / Teams notifications",
      "Priority email support",
      "SSO / SAML authentication",
      "Custom approval workflows",
      "90-day audit retention",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "annual contract",
    desc: "On-prem deployment, compliance controls, and dedicated support.",
    cta: "Contact sales",
    features: [
      "Everything in Team",
      "Self-hosted / air-gapped deployment",
      "SOC 2 compliance controls",
      "Multi-database support",
      "Custom integrations & API",
      "Dedicated account manager",
      "SLA guarantees",
      "Unlimited audit retention",
    ],
  },
];

export default function Pricing() {
  return (
    <>
      <header className="ed-page-header">
        <span className="ed-tag">Pricing</span>
        <h1>Start free. <em>Scale when you&apos;re ready.</em></h1>
        <p className="ed-lead">
          The safety pipeline is fully open source. Paid plans add team features, compliance controls, and dedicated support.
        </p>
      </header>

      <section className="ed-section" style={{ paddingTop: 0 }}>
        <div className="ed-pricing-grid">
          {TIERS.map((t) => (
            <div key={t.name} className={`ed-pricing-card${t.highlight ? " highlight" : ""}`}>
              {t.highlight && <div className="ed-pricing-badge">Most popular</div>}
              <div className="ed-pricing-name">{t.name}</div>
              <div style={{ marginBottom: 4 }}>
                <span className="ed-pricing-amount">{t.price}</span>
                <span className="ed-pricing-period">/ {t.period}</span>
              </div>
              <p className="ed-pricing-desc">{t.desc}</p>
              <Link href="/login" className="ed-pricing-cta">
                {t.cta}
              </Link>
              <ul className="ed-pricing-features">
                {t.features.map((f) => (
                  <li key={f}><span className="ed-pricing-check">{"✓"}</span> {f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <div className="ed-stats-band">
        <div className="ed-stats">
          <div>
            <div className="ed-stat-value">100%</div>
            <div className="ed-stat-label">open source core</div>
          </div>
          <div>
            <div className="ed-stat-value">0</div>
            <div className="ed-stat-label">production data ever cloned</div>
          </div>
          <div>
            <div className="ed-stat-value">56/56</div>
            <div className="ed-stat-label">safety tests passing</div>
          </div>
        </div>
      </div>

      <section className="ed-section-cta">
        <h2>Questions?</h2>
        <p>
          Every plan includes the full safety pipeline — human gate, blast analysis, rollback proof, and audit log.
          Paid plans add collaboration, compliance, and support.
        </p>
        <div className="ed-cta-actions">
          <Link href="/demo" className="btn-dark">Try the demo</Link>
          <Link href="/docs" className="btn-ghost">Read the docs</Link>
        </div>
      </section>
    </>
  );
}
