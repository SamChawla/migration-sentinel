"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ENV_ORDER, nextEnv, type DbEnvironment, type RequestStatus } from "@sentinel/core";
import { EnvBadge } from "@/components/EnvBadge";

export interface RailRun {
  requestId: string;
  environment: DbEnvironment;
  status: RequestStatus;
  targetAlias: string;
}

interface Conn {
  id: string;
  alias: string;
  environment: DbEnvironment;
  hasUrl: boolean;
}

/**
 * The environment promotion rail (doc 11 §3): one cell per environment showing
 * this promotion group's latest run there, a "Promote to <env>" action once the
 * current run is applied, and an honest lock message on a prod request whose
 * group has no lower-env applied run yet. The lock shown here is cosmetic —
 * the approvals route and apply executor enforce it server-side.
 */
export function PromotionRail({
  requestId,
  environment,
  status,
  runs,
  prodLocked,
}: {
  requestId: string;
  environment: DbEnvironment;
  status: RequestStatus;
  runs: RailRun[];
  prodLocked: boolean;
}) {
  const router = useRouter();
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Conn[] | null>(null);
  const [chosenAlias, setChosenAlias] = useState<string>("");

  // Latest run per environment (runs arrive oldest→newest, so the last wins).
  const latest = new Map<DbEnvironment, RailRun>();
  for (const run of runs) latest.set(run.environment, run);

  const target = nextEnv(environment);
  const canPromote = status === "applied" && target !== null;

  // When a promotion is possible, load the registered connections for the NEXT
  // environment so the operator picks WHICH one to clone against (the server
  // otherwise falls back to the first next-env connection with a URL). Only
  // URL-backed connections are eligible — a URL-less alias can't be run.
  const loadTargets = useCallback(() => {
    if (!canPromote || !target) return;
    fetch("/api/connections")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const conns: Conn[] = (d.connections ?? []).filter(
          (c: Conn) => c.environment === target && c.hasUrl,
        );
        setTargets(conns);
        setChosenAlias((cur) => cur || conns[0]?.alias || "");
      })
      .catch(() => setTargets([]));
  }, [canPromote, target]);

  useEffect(() => { loadTargets(); }, [loadTargets]);

  async function promote() {
    setError(null);
    setPromoting(true);
    try {
      const res = await fetch(`/api/requests/${requestId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Send the chosen target when one is picked; omit it to let the server
        // pick the first eligible next-env connection (unchanged fallback).
        body: JSON.stringify(chosenAlias ? { targetAlias: chosenAlias } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      router.push(`/requests/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Promotion failed.");
      setPromoting(false);
    }
  }

  const noTargetConn = canPromote && targets !== null && targets.length === 0;

  function statusColor(s: RequestStatus): string {
    if (s === "applied") return "var(--safe)";
    if (s === "awaiting_approval" || s === "approved" || s === "applying") return "var(--hold)";
    if (s === "rejected" || s === "failed" || s === "blocked" || s === "rolled_back") return "var(--danger)";
    return "var(--muted)";
  }

  return (
    <div className="glass" style={{ padding: "12px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span className="hud-label" style={{ margin: 0 }}>Promotion rail</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--faint)", letterSpacing: ".06em" }}>
          same SQL · re-analyzed per environment
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${ENV_ORDER.length}, 1fr)`, gap: 8 }}>
        {ENV_ORDER.map((env, i) => {
          const run = latest.get(env);
          const isHere = env === environment;
          return (
            <div
              key={env}
              style={{
                border: `1px solid ${isHere ? "var(--line-strong)" : "var(--line)"}`,
                borderRadius: 10,
                padding: "8px 10px",
                background: isHere ? "var(--panel-2)" : "transparent",
                position: "relative",
              }}
            >
              {i > 0 && (
                <span aria-hidden="true" style={{ position: "absolute", left: -8, top: "50%", transform: "translateY(-50%)", color: "var(--faint)", fontSize: 10 }}>
                  ›
                </span>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <EnvBadge env={env} />
                {isHere && <span className="mono" style={{ fontSize: 9, color: "var(--faint)", letterSpacing: ".08em" }}>THIS RUN</span>}
              </div>
              <div style={{ marginTop: 6, fontSize: 11 }}>
                {run ? (
                  <span className="mono" style={{ color: statusColor(run.status) }}>
                    {run.status.replace(/_/g, " ")}
                  </span>
                ) : (
                  <span style={{ color: "var(--faint)" }}>—</span>
                )}
              </div>
              {run && (
                <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.targetAlias}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {prodLocked && (
        <div className="inline-error" role="alert" style={{ marginTop: 10 }}>
          Prod approval is locked: this migration has not been applied on a lower environment yet.
          Run it on staging (or below) first — the same SQL, applied — and the prod gate unlocks.
        </div>
      )}

      {canPromote && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          {/* Target picker — shown only when more than one next-env connection
              exists. A single connection is auto-selected (no needless choice);
              zero shows the honest "add a connection" hint below. */}
          {targets && targets.length > 1 && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--faint)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <EnvBadge env={target!} /> target
              </span>
              <select
                className="field field-mono"
                aria-label={`Target ${target} connection`}
                value={chosenAlias}
                onChange={(e) => setChosenAlias(e.target.value)}
                style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer" }}
              >
                {targets.map((c) => (
                  <option key={c.id} value={c.alias}>{c.alias}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn btn-cyan btn-sm" disabled={promoting || noTargetConn} onClick={promote}>
            {promoting
              ? "Promoting…"
              : targets && targets.length === 1
                ? `Promote to ${chosenAlias || target}`
                : `Promote to ${target}`}
          </button>
          <span style={{ fontSize: 11, color: "var(--faint)" }}>
            {noTargetConn
              ? `No ${target} connection with a URL — add one in Settings first.`
              : `Clones this migration against a ${target} connection and re-runs the full analysis.`}
          </span>
        </div>
      )}
      {error && <div className="inline-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
