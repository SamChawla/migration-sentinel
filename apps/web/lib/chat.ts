/**
 * Migration copilot — read-only Q&A over ONE migration request.
 *
 * Grounds the model in the request's SQL, blast findings, rollback verdict,
 * pre-flight and audit trail, and gives it exactly ONE tool: a hard-guarded
 * read-only SELECT against that request's target database. The copilot can
 * ANSWER and QUERY; it can never write, and it is wholly separate from the
 * approval gate — nothing here can apply, approve, or mutate a request.
 */
import { Client } from "pg";
import type { RequestRecord, AuditEventRow } from "@sentinel/db/queries";
import { runReadOnlyQuery as runGuardedReadOnly } from "@sentinel/shadow";
import { chatComplete, type ChatMessage, type ToolDef } from "./euron";

const MAX_ROWS = 50;
const MAX_TOOL_ROUNDS = 4;
const QUERY_TIMEOUT_MS = 5000;
// Independent wall-clock deadline. The DB statement_timeout bounds server-side
// execution and the guard refuses set_config/SET so SQL can't disable it — but a
// network-stalled socket still needs a client-side cutoff that destroys the
// connection rather than holding the request open.
const QUERY_DEADLINE_MS = QUERY_TIMEOUT_MS + 3000;
const MAX_SQL_CONTEXT_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 8000;

export interface RanQuery {
  sql: string;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

export interface CopilotAnswer {
  answer: string;
  queries: RanQuery[];
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)` : s;
}

// ── Read-only SQL execution ─────────────────────────────────────────────────
// Guard + executor are the canonical, unit-tested ones from @sentinel/shadow
// (ADR-009): a single-statement SELECT/WITH allowlist that ALSO refuses
// state-mutating / session-escaping functions (pg_terminate_backend, set_config,
// pg_advisory*, pg_sleep, …), executed inside a READ ONLY transaction that caps
// rows AT THE DATABASE (LIMIT rowCap+1) so a huge result never buffers in memory.

/** Race `p` against a wall-clock deadline AND the request's abort signal; when
 *  either fires, destroy `client` so a disconnected client (or a stalled socket)
 *  never leaves a target query running past `ms`. */
async function raceCancellable<T>(p: Promise<T>, ms: number, client: Client, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancel = new Promise<never>((_, reject) => {
    const kill = (msg: string) => {
      client.end().catch(() => {}); // force-cancel the in-flight query
      reject(new Error(msg));
    };
    timer = setTimeout(() => kill(`Query exceeded ${ms} ms deadline.`), ms);
    if (signal) {
      if (signal.aborted) return kill("Request aborted.");
      onAbort = () => kill("Request aborted.");
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([p, cancel]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    // If cancellation won, `p` is still pending; its later rejection (the guarded
    // query failing on the destroyed client) would be unhandled — swallow it.
    p.catch(() => {});
  }
}

/** Execute a guarded read-only query against the target DB. Never throws for a
 *  SQL/guard error — returns it as data so the model can reason about it. The
 *  request `signal` cancels the connect + query so a disconnected client stops
 *  target-DB work immediately rather than running until the deadline. */
async function runTargetQuery(targetUrl: string, raw: string, signal?: AbortSignal): Promise<RanQuery & { _rows?: unknown[] }> {
  if (signal?.aborted) return { sql: raw.trim(), error: "Request aborted." };
  const client = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 4000 });
  try {
    const work = (async () => {
      await client.connect();
      return runGuardedReadOnly(client, raw, { timeoutMs: QUERY_TIMEOUT_MS, rowCap: MAX_ROWS });
    })();
    const { rows, truncated } = await raceCancellable(work, QUERY_DEADLINE_MS, client, signal);
    return { sql: raw.trim(), rowCount: rows.length, truncated, ...(rows.length ? { _rows: rows } : {}) };
  } catch (e) {
    return { sql: raw.trim(), error: (e as Error).message };
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Grounded context ───────────────────────────────────────────────────────

function buildSystemContext(rec: RequestRecord, audit: AuditEventRow[]): string {
  const findings = rec.findings
    .map((f) => `  - [${f.severity}] ${f.note ?? f.statement}${f.lockType ? ` (lock: ${f.lockType})` : ""}`)
    .join("\n") || "  (none)";
  const preflight = rec.preflight
    .map((p) => `  - ${p.kind} on ${p.table}: ${p.description} — ${p.willFail === true ? "WILL FAIL" : p.willFail === false ? "ok" : "could not be proven"}${p.violations != null ? ` (${p.violations} rows)` : ""}`)
    .join("\n") || "  (none)";
  const trail = audit
    .slice(0, 20)
    .map((e) => `  - ${e.action} by ${e.actor}: ${e.detail}`)
    .join("\n") || "  (none)";

  return [
    "You are Migration Sentinel's copilot — a READ-ONLY assistant helping a database operator decide whether to approve one Postgres migration. You never apply, approve, or change anything; you explain the analysis and can run read-only SELECTs against the target database to answer factual questions.",
    "",
    "Rules:",
    "- Ground every answer in the facts below and in query results. If you don't know, say so and suggest a query.",
    "- To check live data (e.g. how many rows a change would touch, how many NULLs a SET NOT NULL would break), call query_target_db with a single read-only SELECT.",
    "- Be concise and specific. Never invent row counts — query for them.",
    "- Never suggest bypassing the approval gate.",
    "",
    `MIGRATION: ${rec.title}`,
    `Status: ${rec.status} · Target DB: ${rec.targetDb} · Requested by: ${rec.requestedBy}`,
    `Overall severity: ${rec.overallSeverity} · Reversibility: ${rec.reversibility} · Rollback verified: ${rec.rollbackVerified}`,
    `Rows affected (est): ${rec.rowsAffected ?? "unknown"} · Est. lock: ${rec.estLockMs ?? "unknown"} ms`,
    `Qodo review: ${rec.qodoVerdict}${rec.qodoFindings.length ? ` — ${rec.qodoFindings.join("; ")}` : ""}`,
    "",
    "UP SQL:",
    clip(rec.upSql, MAX_SQL_CONTEXT_CHARS),
    "",
    "DOWN SQL (rollback):",
    clip(rec.downSql || "(none provided)", MAX_SQL_CONTEXT_CHARS),
    "",
    "Blast findings:",
    findings,
    "",
    "Data pre-flight:",
    preflight,
    "",
    "Recent audit trail:",
    trail,
  ].join("\n");
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "query_target_db",
      description:
        "Run a single READ-ONLY SELECT (or WITH…SELECT) against the target database to check live data. Use for row counts, NULL counts, value distributions — anything the static analysis above doesn't already state. Writes/DDL are refused.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single read-only SELECT statement." },
        },
        required: ["sql"],
      },
    },
  },
];

// ── Orchestration ──────────────────────────────────────────────────────────

export async function answerMigrationQuestion(input: {
  rec: RequestRecord;
  audit: AuditEventRow[];
  targetUrl: string | null;
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** Request abort signal — combined with the provider's own per-call timeout so
   *  a client disconnect tears down in-flight Euron calls across tool rounds. */
  signal?: AbortSignal;
}): Promise<CopilotAnswer> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemContext(input.rec, input.audit) },
    ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.question },
  ];

  const queries: RanQuery[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await chatComplete({ messages, tools: TOOLS, signal: input.signal });
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      return { answer: reply.content?.trim() || "(no answer)", queries };
    }

    for (const call of calls) {
      if (call.function.name !== "query_target_db") {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "unknown tool" }) });
        continue;
      }
      let sqlArg = "";
      try {
        sqlArg = String(JSON.parse(call.function.arguments || "{}").sql ?? "");
      } catch {
        /* leave empty → guard reports empty query */
      }

      if (!input.targetUrl) {
        const q: RanQuery = { sql: sqlArg, error: "No target database is configured for this request." };
        queries.push(q);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(q) });
        continue;
      }

      const ran = await runTargetQuery(input.targetUrl, sqlArg, input.signal);
      const { _rows, ...publicPart } = ran;
      queries.push(publicPart);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clip(JSON.stringify({ ...publicPart, rows: _rows ?? [] }), MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  // Ran out of tool rounds — ask for a final grounded answer with no more tools.
  const final = await chatComplete({ messages, signal: input.signal });
  return { answer: final.content?.trim() || "(no answer)", queries };
}
