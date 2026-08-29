"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * First-login guided walkthrough. A spotlight tour that steps through the UI and
 * the migration pipeline — same story as the /demo replay, but on the live app.
 * Shows once per browser (localStorage) and is re-triggerable from the ? button.
 */

const CARD_W = 348;
const DIM = "rgba(6,10,18,0.74)";

// In-memory guard: opened at most once per page load even if sessionStorage
// throws (private mode). Reset naturally on a full reload / new session.
let openedThisLoad = false;

interface Step {
  target: string | null; // data-tour value, or null for a centered step
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    target: null,
    title: "Welcome to Migration Sentinel",
    body: "The approval cockpit for risky database migrations. Take 60 seconds — here's how a change goes from an intent to safely applied, and where you come in.",
  },
  {
    target: "nav",
    title: "Your workspace",
    body: "Migrations (this overview), Requests (the approval queue), Audit (an append-only log of every decision), and Settings.",
  },
  {
    target: "new",
    title: "Submit a change",
    body: "Start a migration from raw SQL, a plain-English intent, or a GitHub PR. The agent — running on TrueForge — generates the paired up / down migration for you.",
  },
  {
    target: "stats",
    title: "The state at a glance",
    body: "What's awaiting your approval, what applied safely with guards, what got blocked at the gate, and how many rollbacks were proven on a throwaway shadow database.",
  },
  {
    target: "recent",
    title: "Every change runs the pipeline",
    body: "Generate → Qodo review → shadow dry-run (blast radius + rollback proof) → the gate. Click Review on any row to open its Approval Console.",
  },
  {
    target: "health",
    title: "Live pipeline health",
    body: "Real-time status of the target, shadow and control databases, the TrueForge agent harness, and the read-only Euron copilot.",
  },
  {
    target: null,
    title: "The gate is the whole point",
    body: "Risky changes pause at the apply_migration gate — nothing touches production until you approve. Irreversible ones (like a DROP) make you type a confirmation word first.",
  },
  {
    target: null,
    title: "Prod gets a second gate",
    body: "A prod migration climbs the environment ladder — it must be applied on a lower environment first. When it's linked to a repo, approval exports {up, down, report} as a GitHub PR; a human merges it there before the guarded apply is released.",
  },
  {
    target: null,
    title: "Ask the copilot",
    body: "Inside any request you can ask a read-only copilot about the change. It runs live SELECTs against the target to answer questions like “how many rows will this touch?” — and it can never approve or apply anything.",
  },
  {
    target: null,
    title: "You're set",
    body: "Open a request that's awaiting approval to see the full Approval Console. Replay this tour anytime from the ? button, bottom-right.",
  },
];

type Box = { top: number; left: number; width: number; height: number };

export function Walkthrough() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);

  const step = STEPS[idx];
  const last = idx === STEPS.length - 1;

  // Auto-open ONCE per browser session on the dashboard (where the anchored
  // elements exist). It does not re-open on ordinary navigation back within a
  // session. `openedThisLoad` (module scope) is an in-memory fallback so that if
  // sessionStorage is unavailable (private mode), the tour still opens at most
  // once per page load instead of on every dashboard mount.
  useEffect(() => {
    if (pathname !== "/dashboard") return;
    if (openedThisLoad) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem("ms_tour_seen") === "1";
    } catch {
      seen = openedThisLoad; // storage blocked → rely on the in-memory guard
    }
    if (seen) return;
    openedThisLoad = true;
    try {
      sessionStorage.setItem("ms_tour_seen", "1");
    } catch {
      /* in-memory guard already prevents a re-open this load */
    }
    setIdx(0);
    setOpen(true);
  }, [pathname]);

  const measure = useCallback(() => {
    setVp({ w: window.innerWidth, h: window.innerHeight });
    const t = STEPS[idx].target;
    if (!t) {
      setBox(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${t}"]`);
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [idx]);

  // On step change: scroll the target into view, then measure.
  useEffect(() => {
    if (!open) return;
    const t = STEPS[idx].target;
    if (t) {
      const el = document.querySelector<HTMLElement>(`[data-tour="${t}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const id = window.setTimeout(measure, t ? 320 : 0);
    return () => window.clearTimeout(id);
  }, [open, idx, measure]);

  // Keep the spotlight aligned while open.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  useLayoutEffect(() => {
    if (open && cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [open, idx, box]);

  const finish = useCallback(() => setOpen(false), []);

  const next = useCallback(() => (last ? finish() : setIdx((i) => i + 1)), [last, finish]);
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, prev, finish]);

  function startTour() {
    setIdx(0);
    setOpen(true);
  }

  // ── Card placement ────────────────────────────────────────────────────────
  const pad = 8;
  const gap = 14;
  const cardStyle: React.CSSProperties = { position: "fixed", width: CARD_W, zIndex: 100002 };
  if (!box) {
    cardStyle.left = "50%";
    cardStyle.top = "50%";
    cardStyle.transform = "translate(-50%, -50%)";
  } else if (box.height > vp.h * 0.6) {
    // Tall element (the nav rail): sit to its right.
    cardStyle.top = Math.min(Math.max(box.top, 16), vp.h - cardH - 16);
    cardStyle.left = Math.min(box.left + box.width + gap, vp.w - CARD_W - 16);
  } else {
    cardStyle.left = Math.min(Math.max(box.left, 16), vp.w - CARD_W - 16);
    const below = box.top + box.height + gap;
    if (below + cardH < vp.h - 8) cardStyle.top = below;
    else cardStyle.top = Math.max(16, box.top - cardH - gap);
  }

  return (
    <>
      {/* Help launcher — always available, hidden while the tour is open */}
      {!open && (
        <button
          onClick={startTour}
          aria-label="Take the walkthrough"
          title="Take the walkthrough"
          style={{
            position: "fixed", right: 20, bottom: 20, zIndex: 90000,
            width: 40, height: 40, borderRadius: "50%",
            background: "var(--panel-2)", border: "1px solid var(--line-strong)",
            color: "var(--cyan)", fontSize: 18, fontWeight: 700, cursor: "pointer",
            boxShadow: "var(--shadow-md)", display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ?
        </button>
      )}

      {open && (
        <>
          {/* Click blocker. For centered steps it also dims; for anchored steps the
              dim comes from the spotlight's box-shadow so the hole reads cleanly. */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", inset: 0, zIndex: 100000, background: box ? "transparent" : DIM }}
          />

          {box && (
            <div
              style={{
                position: "fixed",
                top: box.top - pad,
                left: box.left - pad,
                width: box.width + pad * 2,
                height: box.height + pad * 2,
                borderRadius: 12,
                boxShadow: `0 0 0 9999px ${DIM}, 0 0 0 1.5px var(--cyan)`,
                pointerEvents: "none",
                zIndex: 100001,
                transition: "top .25s ease, left .25s ease, width .25s ease, height .25s ease",
              }}
            />
          )}

          <div
            ref={cardRef}
            style={{
              ...cardStyle,
              background: "var(--panel-2)",
              border: "1px solid var(--line-strong)",
              borderRadius: 14,
              padding: "16px 18px",
              boxShadow: "var(--shadow-md)",
              maxHeight: "80vh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 10, letterSpacing: ".1em", color: "var(--cyan)" }}>
                STEP {idx + 1} OF {STEPS.length}
              </span>
              <button
                onClick={finish}
                style={{ background: "none", border: "none", color: "var(--faint)", fontSize: 12, cursor: "pointer" }}
              >
                Skip
              </button>
            </div>

            <h3 style={{ margin: "0 0 6px", fontSize: 16, color: "var(--text)" }}>{step.title}</h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-dim)" }}>{step.body}</p>

            <div style={{ display: "flex", gap: 5, margin: "14px 0 12px" }}>
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  style={{
                    height: 4, flex: 1, borderRadius: 2,
                    background: i <= idx ? "var(--cyan)" : "var(--line-strong)",
                    transition: "background .2s ease",
                  }}
                />
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
              <button
                onClick={prev}
                disabled={idx === 0}
                className="btn btn-sm"
                style={{ opacity: idx === 0 ? 0.4 : 1, pointerEvents: idx === 0 ? "none" : "auto" }}
              >
                Back
              </button>
              <button onClick={next} className="btn btn-cyan btn-sm">
                {last ? "Get started" : "Next"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
