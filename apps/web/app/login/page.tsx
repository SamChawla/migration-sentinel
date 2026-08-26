"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function Login() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);

  async function signIn(asUser?: string) {
    setBusy(true);
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: asUser ?? username }),
    });
    router.push("/dashboard");
    router.refresh();
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

          <form onSubmit={(e) => { e.preventDefault(); void signIn(); }} style={{ textAlign: "left" }}>
            <label className="lbl" htmlFor="u">Username</label>
            <input id="u" className="field" style={{ marginBottom: 14 }} value={username}
              onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            <label className="lbl" htmlFor="p">Password</label>
            <input id="p" className="field" type="password" style={{ marginBottom: 20 }} value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <button className="btn btn-cyan" type="submit" disabled={busy}
              style={{ width: "100%", textTransform: "uppercase", letterSpacing: ".06em" }}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <div className="login-divider">demo access</div>
          <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={() => void signIn("admin")}>
            Continue as demo admin
          </button>

          <p className="login-hint">
            Demo build — any credentials work. Default: <span className="mono">admin / admin</span>.
            <br />Approvals are enforced server-side by the gate.
          </p>
        </div>
      </main>
    </>
  );
}
