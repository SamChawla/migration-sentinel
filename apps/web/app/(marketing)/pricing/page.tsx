import Link from "next/link";

export const metadata = { title: "Pricing — Migration Sentinel" };

const TIERS = [
  {
    name: "Open Source",
    price: "Free",
    period: "forever",
    desc: "Full safety pipeline for individual developers and small teams.",
    cta: "Get started",
    ctaClass: "btn btn-lg",
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
    ctaClass: "btn btn-cyan btn-lg",
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
    ctaClass: "btn btn-lg",
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
      <header className="hero" style={{ padding: "4rem 2rem 3rem" }}>
        <span style={{ display: "inline-block", padding: "4px 14px", borderRadius: 999, border: "1px solid var(--cyan-deep)", color: "var(--cyan)", fontSize: 12, fontWeight: 500 }}>
          Pricing
        </span>
        <h1>
          Start free. <span className="accent">Scale when you&apos;re ready.</span>
        </h1>
        <p className="lead">
          The safety pipeline is fully open source. Paid plans add team features, compliance controls, and dedicated support.
        </p>
      </header>

      <section className="mk-section">
        <div className="pricing-grid">
          {TIERS.map((t) => (
            <div key={t.name} className={`glass pricing-card${t.highlight ? " pricing-highlight" : ""}`}>
              {t.highlight && <div className="pricing-badge">Most popular</div>}
              <h3 className="pricing-name">{t.name}</h3>
              <div className="pricing-price">
                <span className="pricing-amount">{t.price}</span>
                <span className="pricing-period">/ {t.period}</span>
              </div>
              <p style={{ fontSize: ".9rem", lineHeight: 1.6, color: "var(--muted)" }}>{t.desc}</p>
              <Link href="/login" className={t.ctaClass} style={{ width: "100%", marginTop: "1rem" }}>
                {t.cta}
              </Link>
              <ul className="pricing-features">
                {t.features.map((f) => (
                  <li key={f}><span className="pricing-check">✓</span> {f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <div className="mk-stats-band">
        <div className="mk-stats" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="mk-stat"><div className="v">100%</div><div className="l">open source core</div></div>
          <div className="mk-stat"><div className="v">0</div><div className="l">production data ever cloned</div></div>
          <div className="mk-stat"><div className="v">56/56</div><div className="l">safety tests passing</div></div>
        </div>
      </div>

      <section className="mk-section" style={{ textAlign: "center" }}>
        <h2>Questions?</h2>
        <p className="sect-sub">
          Every plan includes the full safety pipeline — human gate, blast analysis, rollback proof, and audit log.
          Paid plans add collaboration, compliance, and support.
        </p>
        <div className="hero-ctas">
          <Link href="/demo" className="btn btn-cyan btn-lg">Try the demo</Link>
          <Link href="/docs" className="btn btn-lg">Read the docs</Link>
        </div>
      </section>
    </>
  );
}
