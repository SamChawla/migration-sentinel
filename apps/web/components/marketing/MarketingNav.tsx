"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

const OPEN_ACCESS = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase()
);

export function MarketingNav() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <>
      <div className="top-banner">
        <strong>Not another migration runner</strong> — the analyze{" "}
        <span className="arrow-sep">&rarr;</span> prove{" "}
        <span className="arrow-sep">&rarr;</span> gate layer in front of the tools you already use.
      </div>
      <nav className="ed-nav">
        <div className="nav-inner">
          <Link href="/" className="nav-brand">
            <Image src="/brand/emblem.png" alt="" width={26} height={26} />
            <span className="nav-brand-text">Migration Sentinel</span>
          </Link>
          <div className="nav-right">
            <Link href="/docs" className={isActive("/docs") ? "active" : ""}>Docs</Link>
            <Link href="/pricing" className={isActive("/pricing") ? "active" : ""}>Pricing</Link>
            <Link href="/about" className={isActive("/about") ? "active" : ""}>About</Link>
            <Link href="/demo" className={isActive("/demo") ? "active" : ""}>Demo</Link>
            <Link href={OPEN_ACCESS ? "/dashboard" : "/login"} className="nav-console">
              Open Console
            </Link>
          </div>
        </div>
      </nav>
    </>
  );
}
