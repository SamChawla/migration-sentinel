"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Demo: when open access is on, the console needs no login — link straight in.
const OPEN_ACCESS = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase());

export function MarketingNav() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav className="mk-nav">
      <div className="mk-nav-inner">
        <Link href="/" className="mk-logo">
          <img src="/brand/emblem.png" alt="Migration Sentinel" style={{ display: "block", height: 30, width: "auto" }} />
          <span className="mk-logo-text">Migration <span className="mk-logo-accent">Sentinel</span></span>
        </Link>
        <div className="mk-links">
          <Link href="/docs" className={isActive("/docs") ? "mk-link-active" : ""}>Docs</Link>
          <Link href="/pricing" className={isActive("/pricing") ? "mk-link-active" : ""}>Pricing</Link>
          <Link href="/about" className={isActive("/about") ? "mk-link-active" : ""}>About</Link>
          <Link href="/demo" className={isActive("/demo") ? "mk-link-active" : ""}>Demo</Link>
          <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="btn btn-cyan btn-sm">Open console</Link>
        </div>
      </div>
    </nav>
  );
}
