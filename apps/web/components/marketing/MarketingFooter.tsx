import Link from "next/link";

export function MarketingFooter() {
  return (
    <footer className="mk-footer">
      <div className="mk-footer-inner">
        <div className="mk-footer-grid">
          <div className="mk-footer-brand">
            <span className="mk-logo" style={{ fontSize: "1rem" }}>
              <img src="/brand/emblem.png" alt="Migration Sentinel" style={{ display: "block", height: 24, width: "auto" }} />
              <span className="mk-logo-text">Migration <span className="mk-logo-accent">Sentinel</span></span>
            </span>
            <p style={{ fontSize: ".82rem", marginTop: ".5rem", maxWidth: 280, color: "var(--muted)" }}>
              The AI migration agent that pauses before anything irreversible.
            </p>
          </div>
          <div className="mk-footer-col">
            <div className="mk-footer-heading">Product</div>
            <Link href="/#how">How it works</Link>
            <Link href="/#features">Features</Link>
            <Link href="/demo">Live demo</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div className="mk-footer-col">
            <div className="mk-footer-heading">Resources</div>
            <Link href="/docs">Documentation</Link>
            <Link href="/about">About</Link>
            <Link href="/docs#architecture">Architecture</Link>
            <Link href="/docs#safety">Safety model</Link>
          </div>
          <div className="mk-footer-col">
            <div className="mk-footer-heading">Connect</div>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>
            <Link href="/login">Sign in</Link>
            <Link href="/demo">Try the demo</Link>
          </div>
        </div>
        <div className="mk-footer-bottom">
          <span>© 2026 Migration Sentinel. Built for the TrueForge Agent Harness Hackathon.</span>
          <span>Postgres · TrueForge · Qodo</span>
        </div>
      </div>
    </footer>
  );
}
