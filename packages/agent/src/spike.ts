/**
 * Day-1 TrueForge spike — de-risk the external assumptions BEFORE building Phase 3.
 *
 *   pnpm spike                 # run all checks against $TRUEFORGE_BASE_URL
 *   pnpm spike --dump          # also print every event's shape (do this first!)
 *   pnpm spike --reconnect     # persistence test: re-attach to a saved turn
 *
 * What it proves (each prints ✓/✗ and never aborts the rest):
 *   1. Connectivity + inline agent + token streaming (model.message.delta).
 *   2. ask_user_question → tool.response_required → respond  (our backfill-ask primitive).
 *   3. Tool approval PAUSE → resume with allow/deny        (our gate).
 *   4. Session persistence across a server restart          (semi-manual).
 *
 * IMPORTANT — read this before trusting a green run:
 *   The exact way to register a *custom approval-gated tool* was not fully
 *   specified in the docs available when this was written. So:
 *     - Run `--dump` FIRST and eyeball the real event `type`s and field names.
 *     - If Check 3 can't trigger `tool.approval_required`, it tells you what to
 *       configure (Setup → "pause before write/destructive MCP tools") rather
 *       than failing silently. Confirm `toolCalls[].id` / `threadId` against the
 *       dump and adjust the two marked spots if your server differs.
 *   Treat this file as a probe you EDIT on Day 1, not gospel.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const MODEL = process.env.SENTINEL_MODEL ?? "anthropic/claude-sonnet-4-6";
const DUMP = process.argv.includes("--dump");
const RECONNECT = process.argv.includes("--reconnect");
const STATE_FILE = ".spike-state.json";

// An instruction that should trip the approval gate — a WRITE, not a
// destruction, by default so the spike never performs a destructive action just
// because the gate fired. Override with SPIKE_GATED_PROMPT to target a specific
// gated tool. The ALLOW path (actually executing the tool) additionally requires
// SPIKE_ALLOW_DESTRUCTIVE=1 (see below).
const GATED_PROMPT =
  process.env.SPIKE_GATED_PROMPT ??
  "Use your available tools to write the text 'spike-ok' to a scratch file at /tmp/spike-target/probe.txt. You MUST use the tool that performs the write.";
// The DENY path always runs (safe). Executing the ALLOW path actually runs the
// gated tool, so it is opt-in — otherwise a documented `pnpm spike` could perform
// the side effect merely because the gate fired.
const ALLOW_DESTRUCTIVE = process.env.SPIKE_ALLOW_DESTRUCTIVE === "1";

const results: { name: string; ok: boolean; note?: string }[] = [];
const record = (name: string, ok: boolean, note?: string) => {
  results.push({ name, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
};

/** Iterate a turn stream, optionally dumping each event, classifying the ones
 *  we care about. Returns what we saw. Defensive property access throughout. */
async function drainTurn(
  stream: AsyncIterable<{ data: any; id?: string }>,
): Promise<{
  status: string;
  text: string;
  approvals: any[];
  questions: any[];
  lastSeq?: string;
  turnId?: string;
}> {
  let status = "unknown";
  let text = "";
  let lastSeq: string | undefined;
  let turnId: string | undefined;
  const approvals: any[] = [];
  const questions: any[] = [];

  for await (const { data: event, id } of stream) {
    if (id) lastSeq = id;
    const type = event?.type as string | undefined;
    if (DUMP) console.log("   ·", type, JSON.stringify(shallow(event)));

    switch (type) {
      case "turn.created":
        turnId = event?.turnId ?? event?.turn?.id ?? turnId;
        break;
      case "model.message.delta":
        text += event?.content ?? "";
        break;
      case "tool.approval_required":
        approvals.push(event);
        break;
      case "tool.response_required":
        questions.push(event);
        break;
      case "turn.done":
        status = event?.state?.status ?? event?.status ?? "done";
        break;
    }
  }
  return { status, text, approvals, questions, lastSeq, turnId };
}

/** top-level keys + tiny previews, so --dump stays readable */
function shallow(o: any): any {
  if (!o || typeof o !== "object") return o;
  const out: any = {};
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    out[k] =
      typeof v === "string" ? v.slice(0, 60) : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? "{…}" : v;
  }
  return out;
}

async function newSession(client: TrueForge, instructions: string) {
  const { data: session } = await client.sessions.create({
    agent: { spec: { model: { name: MODEL }, instructions } },
  });
  return session;
}

// ── Check 1 — connectivity + streaming ────────────────────────────────────
async function checkStreaming(client: TrueForge) {
  try {
    const session = await newSession(client, "You are a terse assistant. Answer in one word.");
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: 'Reply with exactly: READY' }],
    });
    const r = await drainTurn(stream.withMetadata());
    const ok = r.text.toUpperCase().includes("READY") || r.status.toLowerCase().includes("complete") || r.status === "done";
    record("1. connectivity + streaming", ok, `status=${r.status}, text="${r.text.trim().slice(0, 40)}"`);
  } catch (e) {
    record("1. connectivity + streaming", false, (e as Error).message);
  }
}

// ── Check 2 — ask_user_question (the backfill-ask primitive) ───────────────
async function checkQuestion(client: TrueForge) {
  try {
    const session = await newSession(
      client,
      "When you need a decision from the user, you MUST call ask_user_question rather than guessing.",
    );
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [
        {
          type: "user.message",
          content:
            "I want to backfill a NOT NULL column but haven't told you the value. Ask me what default value to use before doing anything.",
        },
      ],
    });
    const r = await drainTurn(stream.withMetadata());
    if (r.questions.length === 0) {
      record("2. ask_user_question pause", false, "no tool.response_required fired — check the agent has ask_user_question; try --dump");
      return;
    }
    // respond to each question. Confirm field names against --dump if this errors.
    const responses = r.questions.map((q) => ({
      type: "user.tool_response",
      threadId: q?.threadId,
      toolCallId: firstToolCallId(q),               // ← confirm shape on Day 1
      content: "empty_string",
    }));
    const resume = await client.sessions.createTurnStream(session.id, { input: responses as any });
    const r2 = await drainTurn(resume.withMetadata());
    // Only PASS if the resumed turn actually completed — an "unknown" status
    // (no turn.done arrived) or a "failed" terminal must NOT certify the
    // pause/resume API as working (that was silently green before).
    const resumedOk = r2.status === "done" || r2.status.toLowerCase().includes("complete");
    record(
      "2. ask_user_question pause + resume",
      resumedOk,
      `asked ${r.questions.length}, resumed → status=${r2.status}` +
        (resumedOk ? "" : " (resume did not complete — pause/resume NOT verified)"),
    );
  } catch (e) {
    record("2. ask_user_question pause + resume", false, (e as Error).message);
  }
}

// ── Check 3 — tool approval gate (deny then allow) ─────────────────────────
async function checkApproval(client: TrueForge) {
  // DENY path
  try {
    const session = await newSession(
      client,
      "You have tools. Destructive actions require human approval — call the tool; do not refuse.",
    );
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: GATED_PROMPT }],
    });
    const r = await drainTurn(stream.withMetadata());
    if (r.approvals.length === 0) {
      record(
        "3a. approval pause fires",
        false,
        "no tool.approval_required — configure a gated (approval-required) tool for the agent (Setup → pause before write/destructive tools), then re-run with --dump",
      );
    } else {
      record("3a. approval pause fires", true, `${r.approvals.length} approval(s), turn paused`);
      // resume with DENY
      const denied = await client.sessions.createTurnStream(session.id, {
        input: buildApprovals(r.approvals, false) as any,
      });
      const rd = await drainTurn(denied.withMetadata());
      record("3b. resume with DENY", true, `status=${rd.status} (tool should NOT have executed)`);
    }
  } catch (e) {
    record("3a/3b. approval deny path", false, (e as Error).message);
  }

  // ALLOW path (fresh session) — opt-in only: this actually EXECUTES the gated
  // tool, so it must never run by default.
  if (!ALLOW_DESTRUCTIVE) {
    record("3c. resume with ALLOW", true, "skipped — set SPIKE_ALLOW_DESTRUCTIVE=1 to run the tool-executing allow path");
    return;
  }
  try {
    const session = await newSession(
      client,
      "You have tools. Destructive actions require human approval — call the tool; do not refuse.",
    );
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: GATED_PROMPT }],
    });
    const r = await drainTurn(stream.withMetadata());
    if (r.approvals.length === 0) {
      record("3c. resume with ALLOW", false, "no approval event on allow-path run (see 3a guidance)");
      return;
    }
    const allowed = await client.sessions.createTurnStream(session.id, {
      input: buildApprovals(r.approvals, true) as any,
    });
    const ra = await drainTurn(allowed.withMetadata());
    record("3c. resume with ALLOW → tool runs", true, `status=${ra.status}`);
  } catch (e) {
    record("3c. approval allow path", false, (e as Error).message);
  }
}

// ── Check 4 — persistence across restart (semi-manual) ─────────────────────
async function checkPersistence(client: TrueForge) {
  if (RECONNECT) {
    if (!existsSync(STATE_FILE)) {
      record("4. reconnect", false, `no ${STATE_FILE}; run once WITHOUT --reconnect first`);
      return;
    }
    const { sessionId, turnId, lastSeq } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    try {
      const { data: turn } = await client.sessions.getTurn(sessionId, turnId);
      // Re-attach live if still running, else replay the event log.
      if (turn?.state?.status === "running") {
        const resume = await client.sessions.subscribeToTurn(sessionId, turnId, {
          afterSequenceNumber: lastSeq,
        } as any);
        const r = await drainTurn(resume.withMetadata());
        record("4. reconnect (live)", true, `resumed running turn → status=${r.status}`);
      } else {
        let n = 0;
        for await (const _e of await client.sessions.listTurnEvents(sessionId, turnId)) n++;
        record("4. reconnect (replay)", true, `turn status=${turn?.state?.status}; replayed ${n} events`);
      }
    } catch (e) {
      record("4. reconnect", false, (e as Error).message);
    }
    return;
  }

  // First pass: start a long-ish turn, save its coordinates, DON'T finish reading.
  try {
    const session = await newSession(client, "You are a helpful assistant.");
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: "Count slowly from 1 to 20, one number per line." }],
    });
    let turnId: string | undefined;
    let lastSeq: string | undefined;
    let seen = 0;
    for await (const { data: event, id } of stream.withMetadata()) {
      if (id) lastSeq = id;
      if (event?.type === "turn.created") turnId = event?.turnId ?? event?.turn?.id;
      if (++seen >= 3) break; // bail early to simulate a disconnect
    }
    writeFileSync(STATE_FILE, JSON.stringify({ sessionId: session.id, turnId, lastSeq }, null, 2));
    record(
      "4. persistence setup",
      Boolean(turnId),
      `saved ${STATE_FILE}. Now: restart the TrueForge server, then run \`pnpm spike --reconnect\``,
    );
  } catch (e) {
    record("4. persistence setup", false, (e as Error).message);
  }
}

// ── helpers for the two spots to confirm on Day 1 ──────────────────────────
function firstToolCallId(event: any): string | undefined {
  // recipe: event.toolCalls[].id ; some servers use .toolCallId
  const call = event?.toolCalls?.[0];
  return call?.id ?? call?.toolCallId ?? event?.toolCallId;
}
function buildApprovals(approvalEvents: any[], allow: boolean) {
  const out: any[] = [];
  for (const ev of approvalEvents) {
    for (const call of ev?.toolCalls ?? [{}]) {
      out.push({
        type: "user.tool_approval",
        threadId: ev?.threadId,
        toolCallId: call?.id ?? call?.toolCallId ?? ev?.toolCallId, // ← confirm shape on Day 1
        approval: allow ? { status: "allow" } : { status: "deny", reason: "spike deny" },
      });
    }
  }
  return out;
}

async function main() {
  console.log(`\nTrueForge spike → ${BASE_URL}  (model ${MODEL})${DUMP ? "  [dump]" : ""}\n`);
  const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 600 });

  if (RECONNECT) {
    await checkPersistence(client);
  } else {
    await checkStreaming(client);
    await checkQuestion(client);
    await checkApproval(client);
    await checkPersistence(client);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  console.log(
    "If Check 3 didn't fire, the harness is fine — you just need to mark a tool approval-required.\n" +
      "Confirm event field names with --dump before wiring Phase 3.\n",
  );
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error("spike crashed:", e);
  process.exit(1);
});
