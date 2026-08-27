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
import { assertReadOnlySelect } from "@sentinel/core";
import { chatComplete, type ChatMessage, type ToolDef } from "./euron";

const MAX_ROWS = 50;
const MAX_TOOL_ROUNDS = 4;
const QUERY_TIMEOUT_MS = 5000;

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

// ── Read-only SQL execution ─────────────────────────────────────────────────
// The shape guard (assertReadOnlySelect) lives in @sentinel/core so the
// "read-only" promise is unit-tested; here we add the run-time READ ONLY
// transaction that refuses a write a second time.

/** Execute a guarded read-only SELECT against the target DB. Never throws for a
 *  SQL error — returns it as data so the model can reason about it. */
async function runReadOnlyQuery(targetUrl: string, raw: string): Promise<RanQuery> {
  let sql: string;
  try {
    sql = assertReadOnlySelect(raw);
  } catch (e) {
    return { sql: raw, error: (e as Error).message };
  }

  const client = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const result = await client.query(sql);
    await client.query("ROLLBACK").catch(() => {});
    const rows = result.rows.slice(0, MAX_ROWS);
    return {
      sql,
      rowCount: result.rowCount ?? rows.length,
      truncated: result.rows.length > MAX_ROWS,
      // rows travel back to the model as JSON; kept on the RanQuery via a side field.
      ...(rows.length ? { _rows: rows } : {}),
    } as RanQuery & { _rows?: unknown[] };
  } catch (e) {
    return { sql, error: (e as Error).message };
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
    rec.upSql,
    "",
    "DOWN SQL (rollback):",
    rec.downSql || "(none provided)",
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
}): Promise<CopilotAnswer> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemContext(input.rec, input.audit) },
    ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.question },
  ];

  const queries: RanQuery[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await chatComplete({ messages, tools: TOOLS });
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

      const ran = (await runReadOnlyQuery(input.targetUrl, sqlArg)) as RanQuery & { _rows?: unknown[] };
      const { _rows, ...publicPart } = ran;
      queries.push(publicPart);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ ...publicPart, rows: _rows ?? [] }),
      });
    }
  }

  // Ran out of tool rounds — ask for a final grounded answer with no more tools.
  const final = await chatComplete({ messages });
  return { answer: final.content?.trim() || "(no answer)", queries };
}
