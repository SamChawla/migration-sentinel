/**
 * TrueForge client + the tool-approval loop that IS our gate.
 * API shape verified against trueforge.dev (see docs/08-TrueForge-Integration).
 *
 * The `apply_migration` tool is registered as a gated (approval-required) tool.
 * When the agent calls it, the turn pauses and emits `tool.approval_required`.
 * We resume with `user.tool_approval` — but ONLY after our own control-plane
 * gate (ADR-004 / @sentinel/core assertApproved) says approved.
 */
import { TrueForge } from "@truefoundry/trueforge-sdk";

/**
 * Structural view of the SDK client — the two calls this module needs. The
 * apply-gate leg (apply-session.ts) and its tests inject mocks through this,
 * so the gate logic is provable without a live server; the real `TrueForge`
 * instance satisfies it as-is.
 */
export interface TrueForgeTurnStreamLike {
  withMetadata(): AsyncIterable<{ data: unknown; id?: string }>;
}
export interface TrueForgeLike {
  sessions: {
    create(req: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, req: unknown): Promise<TrueForgeTurnStreamLike>;
  };
}

export function createClient(): TrueForge {
  // The local server (`npx @truefoundry/trueforge`) runs with auth disabled, so
  // no token is required. Set TRUEFORGE_TOKEN only when pointing at a hosted /
  // auth-enabled TrueForge — it becomes the `Authorization: Bearer` ID token.
  const token = process.env.TRUEFORGE_TOKEN;
  return new TrueForge({
    baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
    timeoutInSeconds: 600,
    ...(token ? { token } : {}),
  });
}

export const MODEL = process.env.SENTINEL_MODEL ?? "anthropic/claude-sonnet-4-6";

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
}

/**
 * Stream a turn and collect any tool-approval pauses. Returns when the turn
 * closes (either done, or paused awaiting approval).
 *
 * Field names (threadId, toolCalls[].id) verified against SDK v0.1.3's
 * ToolApprovalRequiredEvent/ToolCallRef types and spike.ts Check 3.
 */
export async function streamUntilPauseOrDone(
  client: TrueForgeLike,
  sessionId: string,
  input: unknown[],
  onDelta?: (text: string) => void,
): Promise<{ status: string; pending: PendingApproval[] }> {
  const pending: PendingApproval[] = [];
  const stream = await client.sessions.createTurnStream(sessionId, { input: input as any });

  let status = "unknown";
  for await (const { data: event } of stream.withMetadata()) {
    switch ((event as any).type) {
      case "model.message.delta":
        onDelta?.((event as any).content ?? "");
        break;
      case "tool.approval_required":
        for (const call of (event as any).toolCalls ?? []) {
          pending.push({ threadId: (event as any).threadId, toolCallId: call.id });
        }
        break;
      case "turn.done":
        status = (event as any).state?.status ?? "done";
        break;
    }
  }
  return { status, pending };
}

/** Resume a paused turn by allowing/denying the gated tool call. */
export async function resolveApproval(
  client: TrueForgeLike,
  sessionId: string,
  pending: PendingApproval[],
  allow: boolean,
  reason?: string,
) {
  const input = pending.map((p) => ({
    type: "user.tool_approval",
    threadId: p.threadId,
    toolCallId: p.toolCallId,
    approval: allow ? { status: "allow" } : { status: "deny", reason: reason ?? "Rejected at gate" },
  }));
  return client.sessions.createTurnStream(sessionId, { input: input as any });
}
