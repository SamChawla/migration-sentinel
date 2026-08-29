import { describe, it, expect, vi } from "vitest";
import { GateError } from "@sentinel/core";
import {
  openApplyGateSession,
  resolveApplyGate,
  APPLY_TOOL_NAME,
} from "../src/apply-session";
import type { TrueForgeLike } from "../src/trueforge";

/**
 * Phase A (doc 11 §2a/§2b, doc 12 A.1) — the TrueForge tool-approval leg of the
 * apply gate. These tests pin OUR protocol logic against a mocked client:
 *
 *   - the session spec registers `apply_migration` as approval-required;
 *   - a `tool.approval_required` pause returns control WITHOUT executing;
 *   - `user.tool_approval: allow` is only ever sent after the deterministic
 *     gate check passes — and never when it throws;
 *   - `deny` never reaches the executor;
 *   - an unreachable TrueForge falls back to the deterministic path, without
 *     throwing.
 */

type CreatedTurn = { sessionId: string; input: any[] };

function makeStream(events: unknown[]) {
  return {
    withMetadata() {
      return (async function* () {
        for (const e of events) yield { data: e };
      })();
    },
  };
}

/** Mock client that pauses on the first turn with one apply_migration call. */
function makeClient(opts: {
  pauseEvents?: unknown[];
  createThrows?: boolean;
  turnThrows?: boolean;
} = {}) {
  const created: any[] = [];
  const turns: CreatedTurn[] = [];
  const pauseEvents = opts.pauseEvents ?? [
    {
      type: "tool.approval_required",
      threadId: "th-1",
      toolCalls: [{ id: "tc-1", sourceEventId: "ev-1" }],
    },
    { type: "turn.done", state: { status: "paused" } },
  ];
  const client: TrueForgeLike = {
    sessions: {
      async create(req: unknown) {
        if (opts.createThrows) throw new Error("ECONNREFUSED 127.0.0.1:8790");
        created.push(req);
        return { data: { id: "sess-1" } };
      },
      async createTurnStream(sessionId: string, req: any) {
        if (opts.turnThrows) throw new Error("ECONNREFUSED 127.0.0.1:8790");
        turns.push({ sessionId, input: req?.input ?? [] });
        return makeStream(pauseEvents);
      },
    },
  };
  return { client, created, turns };
}

const SESSION = { sessionId: "sess-1", threadId: "th-1", toolCallId: "tc-1" };

describe("openApplyGateSession — session spec + pause capture", () => {
  it("registers apply_migration as an approval-required tool on the session", async () => {
    const { client, created } = makeClient();
    await openApplyGateSession({ client, requestId: "r1", title: "add col", upSql: "ALTER TABLE t ADD COLUMN x int" });
    expect(created).toHaveLength(1);
    const spec = created[0]?.agent?.spec;
    expect(spec).toBeTruthy();
    const gated = (spec.mcpServers ?? []).flatMap((s: any) => s.requireApprovalForTools ?? []);
    expect(gated).toContain(APPLY_TOOL_NAME);
  });

  it("returns the pause coordinates when tool.approval_required fires — and does NOT execute anything", async () => {
    const { client } = makeClient();
    const session = await openApplyGateSession({
      client,
      requestId: "r1",
      title: "add col",
      upSql: "ALTER TABLE t ADD COLUMN x int",
    });
    expect(session).toEqual(SESSION);
  });

  it("returns null (fallback) when the turn completes with NO approval pause", async () => {
    const { client } = makeClient({
      pauseEvents: [
        { type: "model.message.delta", content: "I have no such tool." },
        { type: "turn.done", state: { status: "done" } },
      ],
    });
    const session = await openApplyGateSession({ client, requestId: "r1", title: "t", upSql: "SELECT 1" });
    expect(session).toBeNull();
  });

  it("returns null (fallback) when TrueForge is unreachable — never throws", async () => {
    const { client } = makeClient({ createThrows: true });
    await expect(
      openApplyGateSession({ client, requestId: "r1", title: "t", upSql: "SELECT 1" }),
    ).resolves.toBeNull();
  });
});

describe("resolveApplyGate — allow/deny carries the human decision", () => {
  it("approved + gate passes → sends user.tool_approval allow, THEN executes", async () => {
    const { client, turns } = makeClient();
    const order: string[] = [];
    const result = await resolveApplyGate({
      client,
      session: SESSION,
      decision: "approved",
      assertGate: () => {
        order.push("gate");
      },
      execute: async () => {
        order.push("execute");
        return "applied";
      },
    });
    expect(result.executed).toBe(true);
    expect(result.result).toBe("applied");
    expect(result.trueforgeUsed).toBe(true);
    expect(order).toEqual(["gate", "execute"]);
    const approvalInputs = turns.flatMap((t) => t.input).filter((i) => i.type === "user.tool_approval");
    expect(approvalInputs).toHaveLength(1);
    expect(approvalInputs[0]).toMatchObject({
      threadId: "th-1",
      toolCallId: "tc-1",
      approval: { status: "allow" },
    });
  });

  it("approved but the deterministic gate THROWS → no allow is sent, executor never runs, error propagates", async () => {
    const { client, turns } = makeClient();
    const execute = vi.fn();
    await expect(
      resolveApplyGate({
        client,
        session: SESSION,
        decision: "approved",
        assertGate: () => {
          throw new GateError("typed confirmation required");
        },
        execute,
      }),
    ).rejects.toThrow(GateError);
    expect(execute).not.toHaveBeenCalled();
    expect(turns.flatMap((t) => t.input)).toHaveLength(0);
  });

  it("rejected → sends deny with a reason; the executor is NEVER called", async () => {
    const { client, turns } = makeClient();
    const execute = vi.fn();
    const result = await resolveApplyGate({
      client,
      session: SESSION,
      decision: "rejected",
      reason: "operator rejected",
      assertGate: () => {},
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.trueforgeUsed).toBe(true);
    const approvalInputs = turns.flatMap((t) => t.input).filter((i) => i.type === "user.tool_approval");
    expect(approvalInputs).toHaveLength(1);
    expect(approvalInputs[0].approval).toMatchObject({ status: "deny", reason: "operator rejected" });
  });

  it("TrueForge unreachable on resolve → approved path still executes via the deterministic gate, without throwing", async () => {
    const { client } = makeClient({ turnThrows: true });
    const result = await resolveApplyGate({
      client,
      session: SESSION,
      decision: "approved",
      assertGate: () => {},
      execute: async () => "applied",
    });
    expect(result.executed).toBe(true);
    expect(result.result).toBe("applied");
    expect(result.trueforgeUsed).toBe(false);
  });

  it("no persisted session (pause never opened) → approved path executes deterministically, no network attempted", async () => {
    const { client, turns } = makeClient();
    const result = await resolveApplyGate({
      client,
      session: null,
      decision: "approved",
      assertGate: () => {},
      execute: async () => "applied",
    });
    expect(result.executed).toBe(true);
    expect(result.trueforgeUsed).toBe(false);
    expect(turns).toHaveLength(0);
  });

  it("rejected + TrueForge unreachable → still resolves (deny is best-effort), executor untouched", async () => {
    const { client } = makeClient({ turnThrows: true });
    const execute = vi.fn();
    const result = await resolveApplyGate({
      client,
      session: SESSION,
      decision: "rejected",
      assertGate: () => {},
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.trueforgeUsed).toBe(false);
  });
});
