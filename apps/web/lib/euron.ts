/**
 * Euron chat client — BYOK, OpenAI-compatible.
 *
 * The migration PIPELINE runs on TrueForge (see packages/agent). The copilot
 * chat is a separate, read-only assistant that runs on the operator's own Euron
 * key. Euron exposes an OpenAI-compatible `/chat/completions` endpoint, so this
 * is a thin fetch wrapper — no SDK, no extra dependency, and it works against
 * any OpenAI-compatible provider if EURON_BASE_URL is repointed.
 *
 * Config (all via .env — never hardcode a key):
 *   EURON_API_KEY   the bearer key (required; absent → chat disabled)
 *   EURON_BASE_URL  default https://api.euron.one/api/v1
 *   EURON_MODEL     default gpt-4.1-nano — set to a model your Euron plan exposes
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** assistant turns that call tools */
  tool_calls?: ToolCall[];
  /** tool result turns must echo the call id they answer */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function euronConfigured(): boolean {
  return Boolean(process.env.EURON_API_KEY?.trim());
}

function baseUrl(): string {
  return (process.env.EURON_BASE_URL?.trim() || "https://api.euron.one/api/v1").replace(/\/+$/, "");
}

export function euronModel(): string {
  return process.env.EURON_MODEL?.trim() || "gpt-4.1-nano";
}

export class EuronError extends Error {}

interface CompletionChoice {
  message: ChatMessage;
  finish_reason: string;
}

/**
 * One OpenAI-compatible chat completion. Returns the assistant message (which may
 * carry tool_calls). Throws EuronError on missing key or a non-OK response so the
 * caller can surface a clean 4xx/5xx rather than leaking provider internals.
 */
export async function chatComplete(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  signal?: AbortSignal;
}): Promise<ChatMessage> {
  const key = process.env.EURON_API_KEY?.trim();
  if (!key) {
    throw new EuronError(
      "Euron API key is not configured. Set EURON_API_KEY in .env to enable the copilot.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: euronModel(),
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    throw new EuronError(`Could not reach Euron (${baseUrl()}): ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EuronError(`Euron returned ${res.status}: ${body.slice(0, 500) || res.statusText}`);
  }

  const json = (await res.json().catch(() => null)) as { choices?: CompletionChoice[] } | null;
  const message = json?.choices?.[0]?.message;
  if (!message) throw new EuronError("Euron returned no completion choice.");
  return message;
}
