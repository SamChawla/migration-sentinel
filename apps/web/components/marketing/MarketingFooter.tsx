import Link from "next/link";
import Image from "next/image";

export function MarketingFooter() {
  return (
    <footer className="ed-footer">
      <div className="footer-inner">
        <div className="footer-left">
          <div className="footer-brand" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Image src="/brand/emblem.png" alt="" width={22} height={22} />
            <span>Migration Sentinel</span>
          </div>
          <p>The AI migration agent that pauses<br />before anything irreversible.</p>
        </div>
        <div className="footer-cols">
          <div className="footer-col">
            <div className="footer-col-title">Product</div>
            <Link href="/#pipeline">How it works</Link>
            <Link href="/#capabilities">Features</Link>
            <Link href="/demo">Live demo</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Resources</div>
            <Link href="/docs">Documentation</Link>
            <Link href="/docs#architecture">Architecture</Link>
            <Link href="/docs#safety">Safety model</Link>
            <Link href="/about">About</Link>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Connect</div>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>
            <Link href="/login">Sign in</Link>
            <Link href="/demo">Try the demo</Link>
          </div>
        </div>
      </div>
      <div className="footer-bottom">
        <p>&copy; 2026 Migration Sentinel.</p>
        <div className="footer-tech">
          <span>Postgres</span>
          <span>TrueForge</span>
          <span>Qodo</span>
        </div>
      </div>
    </footer>
  );
}
