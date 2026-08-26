/**
 * Migration generation via TrueForge (Phase 3.2).
 *
 * Given an intent (or a raw migration to correct) plus the target's live schema,
 * the TrueForge agent produces a paired {up, down} migration and a plain-English
 * summary. We ask the model to return a single JSON object and parse it.
 *
 * Requires a reachable TrueForge server ($TRUEFORGE_BASE_URL) and a configured
 * model provider key. When either is missing the call throws; the orchestrator
 * turns that into a `failed` status with an explanatory audit event rather than
 * silently proceeding.
 */
import { createClient, MODEL } from "./trueforge";
import { SYSTEM_INSTRUCTIONS, generateUserPrompt } from "./prompts";

export interface GeneratedMigration {
  up: string;
  down: string;
  summary: string;
  model: string;
}

export interface GenerateParams {
  intent?: string;
  rawSql?: string;
  schemaContext: string;
}

function extractJson(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function generateMigration(params: GenerateParams): Promise<GeneratedMigration> {
  const client = createClient();
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions:
          SYSTEM_INSTRUCTIONS +
          '\n\nWhen asked to produce a migration, respond with ONLY a single minified JSON object ' +
          'of the shape {"up":"<sql>","down":"<sql>","summary":"<one paragraph>"} and no other text.',
      },
    },
  });

  const prompt =
    generateUserPrompt(params) +
    '\n\nReturn ONLY minified JSON {"up":"...","down":"...","summary":"..."} with valid, escaped PostgreSQL in the up/down fields.';

  let text = "";
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: "user.message", content: prompt }] as any,
  });
  for await (const { data: event } of stream.withMetadata()) {
    const type = (event as any).type;
    if (type === "model.message.delta") text += (event as any).content ?? "";
    if (type === "turn.done") break;
  }

  const json = extractJson(text);
  if (!json || typeof json.up !== "string" || typeof json.down !== "string") {
    throw new Error(`TrueForge generation returned no valid {up,down} JSON. Got: ${text.slice(0, 200)}`);
  }
  return {
    up: json.up,
    down: json.down,
    summary: typeof json.summary === "string" ? json.summary : "",
    model: MODEL,
  };
}
