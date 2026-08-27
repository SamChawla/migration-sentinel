"use client";
import { useState } from "react";
import { useRouter, redirect } from "next/navigation";
import Link from "next/link";

// Demo convenience: when NEXT_PUBLIC_DEMO_TOKEN is set (local / the demo deploy),
// the approver token is pre-filled so the console is one click away. Unset in
// production → the field stays blank and login is a normal secure sign-in.
const DEMO_TOKEN = process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "";
// When open access is on there is no login step — bounce straight to the console
// so any "Open console" link (from /demo, /about, …) just works.
const OPEN_ACCESS = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_DEMO_OPEN_ACCESS ?? "").toLowerCase());

export default function Login() {
  if (OPEN_ACCESS) redirect("/dashboard");
  const router = useRouter();
  const demoMode = DEMO_TOKEN.length > 0;
  const [username, setUsername] = useState("approver");
  const [password, setPassword] = useState(DEMO_TOKEN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(asUser?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The password field carries the APPROVER_TOKEN — the API validates it.
        body: JSON.stringify({ username: asUser ?? username, token: password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Sign-in failed.");
        setBusy(false);
        return;
      }
      // Trigger the first-run walkthrough on the dashboard. Set per navigation
      // (sessionStorage) so it opens on every login for the demo, but not on
      // ordinary dashboard visits within the session.
      try {
        sessionStorage.setItem("ms_tour_on_login", "1");
      } catch {
        /* private mode / blocked storage — tour just won't auto-open */
      }
      // Success — navigate away; the page unmounts, so leave `busy` as-is.
      router.push("/dashboard");
      router.refresh();
    } catch {
      // A network/service failure rejects fetch() — without this, `busy` would
      // stay true and the button would sit disabled on "Signing in..." forever.
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="mk-nav" style={{ position: "absolute", top: 0, left: 0, right: 0, background: "transparent", borderBottom: "none", boxShadow: "none" }}>
        <div className="mk-nav-inner">
          <Link href="/" className="mk-logo">
            <img src="/brand/emblem.png" alt="Migration Sentinel" style={{ display: "block", height: 28, width: "auto" }} />
            <span className="mk-logo-text">Migration <span className="mk-logo-accent">Sentinel</span></span>
          </Link>
          <div className="mk-links">
            <Link href="/docs">Docs</Link>
            <Link href="/demo">Demo</Link>
          </div>
        </div>
      </nav>

      <main className="login-wrap">
        <div className="login-card">
          <div className="login-logo" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text)" }}>
            <img src="/brand/emblem.png" alt="" style={{ display: "block", height: 32, width: "auto" }} />
            <span>Migration <span className="mk-logo-accent">Sentinel</span></span>
          </div>
          <p className="login-tag">Sign in to the operator console</p>

          {demoMode && (
            <div
              style={{
                display: "flex", alignItems: "center", gap: 9, textAlign: "left",
                fontSize: 12.5, lineHeight: 1.4, color: "var(--text-dim)",
                border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px",
                margin: "0 0 18px", background: "var(--panel)",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cyan)", boxShadow: "var(--glow-cyan)", flexShrink: 0 }} />
              <span>
                <b style={{ color: "var(--text)" }}>Demo mode</b> — the seed token is pre-filled. Just click{" "}
                <b>Login to Console</b>.
              </span>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); void signIn(); }} style={{ textAlign: "left" }}>
            <label className="lbl" htmlFor="u">Username</label>
            <input id="u" className="field" style={{ marginBottom: 14 }} value={username}
              onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            <label className="lbl" htmlFor="p">Approver token</label>
            <input id="p" className="field" type="password" style={{ marginBottom: error ? 10 : 20 }} value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="APPROVER_TOKEN" />
            {error && <div className="inline-error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
            <button className="btn btn-cyan" type="submit" disabled={busy}
              style={{ width: "100%", textTransform: "uppercase", letterSpacing: ".06em" }}>
              {busy ? "Signing in..." : "Login to Console"}
            </button>
          </form>

          <p className="login-hint">
            {demoMode ? (
              <>Single-approver console. The <span className="mono">APPROVER_TOKEN</span> is pre-filled for the demo —
              approvals are still enforced server-side by the gate.</>
            ) : (
              <>Single-approver console — sign in with the <span className="mono">APPROVER_TOKEN</span> configured for
              this deployment.<br />Approvals are enforced server-side by the gate.</>
            )}
          </p>
        </div>
      </main>
    </>
  );
}
