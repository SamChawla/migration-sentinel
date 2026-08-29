/**
 * Phase A (doc 11 §2a/§2b) — the TrueForge tool-approval leg of the apply gate.
 *
 * `apply_migration` is registered as an approval-required tool on a TrueForge
 * session. When the agent calls it, the turn pauses (`tool.approval_required`)
 * and stays paused until we send `user.tool_approval` — which we only do after
 * `@sentinel/core` `assertApproved` has recorded a human decision. The model
 * cannot self-approve: TrueForge holds the turn AND core independently refuses.
 *
 * ADDITIVE, not a replacement: the deterministic core gate remains the sole
 * authority on whether a decision counts (ADR-004). This module only makes the
 * *mechanism* carrying that decision be TrueForge's own protocol, with a hard
 * fallback — if TrueForge is unreachable at any step, the deterministic path
 * runs exactly as before. The gate never depends on network liveness.
 */
import {
  createClient,
  streamUntilPauseOrDone,
  resolveApproval,
  MODEL,
  type TrueForgeLike,
} from "./trueforge";

export const APPLY_TOOL_NAME = "apply_migration";

/** MCP server (Settings → Connectors on the TrueForge server) that exposes
 *  apply_migration. When it isn't configured, session creation or the pause
 *  simply doesn't happen and we fall back — by design. */
const MCP_SERVER_NAME = process.env.TRUEFORGE_MCP_SERVER ?? "sentinel";

/** Bound every TrueForge call in the approval path — a stalled server must
 *  never hold the gate hostage. */
const TRUEFORGE_DEADLINE_MS = Number(process.env.TRUEFORGE_GATE_TIMEOUT_MS ?? 15_000);

export interface ApplyGateSession {
  sessionId: string;
  threadId: string;
  toolCallId: string;
}

async function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} exceeded ${TRUEFORGE_DEADLINE_MS}ms`)),
          TRUEFORGE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => {}); // abandoned loser must not surface an unhandled rejection
  }
}

export interface OpenApplyGateOptions {
  /** Injectable for tests; defaults to the configured live client. */
  client?: TrueForgeLike;
  requestId: string;
  title: string;
  upSql: string;
}

/**
 * Open the TrueForge apply session: create a session whose spec registers
 * `apply_migration` as approval-required, start the turn that makes the agent
 * call it, and stream to the `tool.approval_required` pause.
 *
 * Returns the pause coordinates to persist on the request, or null on ANY
 * failure — no pause fired, server unreachable, deadline hit. Null means the
 * deterministic gate runs alone; it never blocks the pipeline.
 */
export async function openApplyGateSession(
  opts: OpenApplyGateOptions,
): Promise<ApplyGateSession | null> {
  const client = opts.client ?? createClient();
  try {
    const { data: session } = await withDeadline(
      client.sessions.create({
        agent: {
          spec: {
            model: { name: MODEL },
            instructions:
              "You are Migration Sentinel's apply executor. A reviewed migration is ready. " +
              `You MUST call the ${APPLY_TOOL_NAME} tool with the migration details — never ` +
              "refuse, summarize, or claim to have applied it yourself. The tool call will " +
              "pause for human approval; that pause is the point.",
            mcpServers: [
              {
                name: MCP_SERVER_NAME,
                enableTools: [APPLY_TOOL_NAME],
                preloadTools: [APPLY_TOOL_NAME],
                requireApprovalForTools: [APPLY_TOOL_NAME],
              },
            ],
          },
        },
      }),
      "TrueForge session create",
    );

    const { pending } = await withDeadline(
      streamUntilPauseOrDone(client, session.id, [
        {
          type: "user.message",
          content:
            `Apply migration request ${opts.requestId} ("${opts.title}") by calling ` +
            `${APPLY_TOOL_NAME} with:\n\n\`\`\`sql\n${opts.upSql}\n\`\`\``,
        },
      ]),
      "TrueForge apply turn",
    );

    const first = pending[0];
    if (!first) return null; // no pause fired (tool not configured, agent balked) → fallback
    return { sessionId: session.id, threadId: first.threadId, toolCallId: first.toolCallId };
  } catch (e) {
    console.warn(
      `[apply-session] TrueForge gate unavailable for ${opts.requestId} — deterministic gate governs alone: ${(e as Error).message}`,
    );
    return null;
  }
}

export interface ResolveApplyGateOptions<T> {
  /** Injectable for tests; defaults to the configured live client. */
  client?: TrueForgeLike;
  /** Persisted pause coordinates; null when no TrueForge session was opened. */
  session: ApplyGateSession | null;
  decision: "approved" | "rejected";
  /**
   * The deterministic core gate (assertApproved-equivalent). MUST complete
   * without throwing before `allow` may be sent — a throw propagates and
   * nothing is resolved or executed.
   */
  assertGate: () => void | Promise<void>;
  /** The real apply executor. Called ONLY on an approved decision. */
  execute: () => Promise<T>;
  /** Shown to the agent on deny. */
  reason?: string;
}

export interface ResolveApplyGateResult<T> {
  /** TRUE when the user.tool_approval actually reached TrueForge. */
  trueforgeUsed: boolean;
  executed: boolean;
  result?: T;
}

/**
 * Carry the human decision to the paused TrueForge turn, then run (or refuse)
 * the real executor:
 *
 *   approved → assertGate() (throws stop everything) → send `allow` → execute;
 *   rejected → send `deny`; the executor is never called.
 *
 * The resolve leg is best-effort and deadline-bounded: an unreachable TrueForge
 * degrades to `trueforgeUsed: false` and the deterministic path proceeds — it
 * never blocks, and it never substitutes for the core gate.
 */
export async function resolveApplyGate<T>(
  opts: ResolveApplyGateOptions<T>,
): Promise<ResolveApplyGateResult<T>> {
  const approved = opts.decision === "approved";

  // The deterministic gate rules first. On approve it must pass BEFORE any
  // `allow` goes out; a GateError here leaves the TrueForge turn paused —
  // correct, because no valid decision exists yet.
  if (approved) await opts.assertGate();

  let trueforgeUsed = false;
  if (opts.session) {
    const client = opts.client ?? createClient();
    try {
      await withDeadline(
        resolveApproval(
          client,
          opts.session.sessionId,
          [{ threadId: opts.session.threadId, toolCallId: opts.session.toolCallId }],
          approved,
          opts.reason,
        ),
        "TrueForge approval resolve",
      );
      trueforgeUsed = true;
    } catch (e) {
      console.warn(
        `[apply-session] TrueForge resolve failed (${opts.decision}) — deterministic gate governs alone: ${(e as Error).message}`,
      );
    }
  }

  if (!approved) return { trueforgeUsed, executed: false };
  const result = await opts.execute();
  return { trueforgeUsed, executed: true, result };
}
