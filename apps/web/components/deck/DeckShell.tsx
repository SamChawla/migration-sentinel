"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SvgDefs } from "./SvgDefs";
import { DatabaseIcon, GaugeIcon, ShieldIcon, LeverIcon } from "./icons";
import { Walkthrough } from "@/components/Walkthrough";

function initialsOf(name: string): string {
  const parts = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "A") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function useClickOutside(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onAway]);
  return ref;
}

const NAV: { href: string; label: string; Icon: typeof DatabaseIcon; exact?: boolean }[] = [
  { href: "/dashboard", label: "Migrations", Icon: DatabaseIcon },
  { href: "/requests", label: "Requests", Icon: GaugeIcon },
  { href: "/audit", label: "Audit", Icon: ShieldIcon },
  { href: "/settings", label: "Settings", Icon: LeverIcon },
];

function pageName(pathname: string): string {
  if (pathname.startsWith("/requests/new")) return "// NEW MIGRATION";
  if (pathname.startsWith("/requests/")) return "// APPROVAL CONSOLE";
  if (pathname.startsWith("/requests")) return "// REQUESTS";
  if (pathname.startsWith("/audit")) return "// AUDIT LOG";
  if (pathname.startsWith("/settings")) return "// SETTINGS";
  return "// DASHBOARD";
}

export function DeckShell({
  children,
  pendingCount,
  userName = "Demo Admin",
  hudStatus,
}: {
  children: React.ReactNode;
  pendingCount: number;
  userName?: string;
  hudStatus?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside(() => setMenuOpen(false));

  const statusText = hudStatus ?? (pendingCount > 0 ? `OPERATION HELD · ${pendingCount} AWAITING OPERATOR` : "IDLE");
  const statusIdle = !hudStatus && pendingCount === 0;

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <SvgDefs />
      <div className="deck">
        {/* Top HUD */}
        <header className="hud">
          <Link href="/dashboard" className="hud-wordmark">
            <img src="/brand/emblem.png" alt="" style={{ display: "block", height: 24, width: "auto" }} />
            <span>Migration <span className="mk-logo-accent">Sentinel</span></span>
          </Link>
          <span className="hud-page" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)", letterSpacing: ".1em" }}>{pageName(pathname)}</span>
          <span className={`hud-status${statusIdle ? " idle" : ""}`}>
            {!statusIdle && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--hold)", marginRight: 8, animation: "pulse 1.7s ease-in-out infinite" }} />}
            {statusText}
          </span>
          <span className="hud-env">
            TARGET · prod-orders-db
          </span>
        </header>

        {/* Instrument rail */}
        <nav className="rail" aria-label="Main navigation" data-tour="nav">
          {NAV.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={`rail-item${active ? " active" : ""}`} title={n.label}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <n.Icon size={22} />
                  <span className="rail-label">{n.label}</span>
                </div>
                {n.href === "/requests" && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
              </Link>
            );
          })}
          <div className="rail-spacer" />
          <div style={{ position: "relative" }} ref={menuRef}>
            <button className="rail-user" onClick={() => setMenuOpen((v) => !v)} aria-label="Account menu">
              {initialsOf(userName)}
            </button>
            {menuOpen && (
              <div className="menu" style={{ left: "calc(100% + 8px)", right: "auto", bottom: 0, top: "auto" }}>
                <div className="menu-head">
                  <div style={{ fontWeight: 600 }}>{userName}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>demo session</div>
                </div>
                <Link href="/settings" className="menu-item" onClick={() => setMenuOpen(false)}>Settings</Link>
                <Link href="/" className="menu-item" onClick={() => setMenuOpen(false)}>Product page</Link>
                <Link href="/demo" className="menu-item" onClick={() => setMenuOpen(false)}>Demo mode</Link>
                <div className="menu-sep" />
                <button className="menu-item" style={{ color: "var(--danger)" }} onClick={() => void signOut()}>Sign out</button>
              </div>
            )}
          </div>
        </nav>

        {/* Stage */}
        <main className="stage">
          {children}
        </main>
      </div>
      <Walkthrough />
    </>
  );
}
