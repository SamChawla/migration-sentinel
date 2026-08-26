/** Prompt builders for migration generation. Kept terse and high-signal
 *  (Boris/Jeff Dean: clear specs, let the model cook). */

export const SYSTEM_INSTRUCTIONS = `You are Migration Sentinel, an expert PostgreSQL migration engineer.
Given an intent, current schema, or a raw SQL migration, you produce a SAFE, paired migration:
- an "up" migration, and
- a "down" migration that reverses it as far as physically possible.
Rules:
- Target is PostgreSQL 16 only.
- Prefer online/lock-light patterns (e.g. NOT VALID + VALIDATE, CONCURRENTLY) where possible.
- If an operation is inherently irreversible (DROP COLUMN, unbounded UPDATE/DELETE, TRUNCATE),
  DO NOT pretend the down restores data. State plainly that data is not recoverable.
- Never run anything against production. You only propose; a human approves.
You have a gated tool "apply_migration" that requires explicit human approval before it runs.`;

export function generateUserPrompt(params: {
  intent?: string;
  rawSql?: string;
  schemaContext: string;
}): string {
  if (params.rawSql) {
    return `Here is a raw migration. Produce a corrected {up, down} pair and a plain-English summary.\n\nSchema:\n${params.schemaContext}\n\nMigration:\n${params.rawSql}`;
  }
  return `Intent: ${params.intent}\n\nCurrent schema:\n${params.schemaContext}\n\nProduce {up, down} SQL and a plain-English summary.`;
}
