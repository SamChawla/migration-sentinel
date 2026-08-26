/**
 * Rollback verifier — INTEGRATION test (needs a live Postgres).
 *
 * Runs against SHADOW_DATABASE_URL. If it's not set, the suite is skipped with
 * a clear message rather than failing — so `pnpm test` stays green without a DB,
 * and CI can opt in by providing a throwaway Postgres.
 *
 *   SHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5432/shadow \
 *     pnpm test rollback
 *
 * Each fixture runs inside its own transaction that is ROLLED BACK afterward,
 * so the shadow DB is left pristine and cases don't interfere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { verifyRollback, schemaFingerprint } from "../src/rollback";
import { MIGRATION_FIXTURES } from "../../../fixtures/migrations";

const URL = process.env.SHADOW_DATABASE_URL;
const run = URL ? describe : describe.skip;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[rollback.test] SHADOW_DATABASE_URL not set — skipping integration tests.\n" +
      "  Provide a throwaway Postgres to run them, e.g.\n" +
      "  SHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5432/shadow pnpm test\n",
  );
}

run("rollback verifier (live Postgres)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  // Minimal base schema the fixtures operate on. Data is irrelevant to schema
  // fingerprinting, so we don't seed rows here.
  const BASE_SCHEMA = `
    CREATE TABLE public.users (
      id           bigserial PRIMARY KEY,
      email        text NOT NULL UNIQUE,
      full_name    text,
      is_active    boolean NOT NULL DEFAULT true,
      legacy_notes text,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  `;

  for (const fx of MIGRATION_FIXTURES) {
    it(`${fx.name}: rollbackVerified === ${fx.expected.rollbackVerified}`, async () => {
      await client.query("BEGIN");
      try {
        await client.query("DROP TABLE IF EXISTS public.users CASCADE");
        await client.query(BASE_SCHEMA);

        const result = await verifyRollback(client, fx.up, fx.down);
        expect(result.rollbackVerified).toBe(fx.expected.rollbackVerified);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }

  it("schemaFingerprint is stable and changes on a real schema change", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DROP TABLE IF EXISTS public.users CASCADE");
      await client.query(BASE_SCHEMA);

      const a = await schemaFingerprint(client);
      const b = await schemaFingerprint(client);
      expect(a).toBe(b); // deterministic

      await client.query("ALTER TABLE public.users ADD COLUMN nickname text");
      const c = await schemaFingerprint(client);
      expect(c).not.toBe(a); // sensitive to change
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("proves schema-restored is NOT the same as rollback-verified (DROP COLUMN)", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DROP TABLE IF EXISTS public.users CASCADE");
      await client.query(BASE_SCHEMA);

      const result = await verifyRollback(
        client,
        "ALTER TABLE public.users DROP COLUMN legacy_notes;",
        "ALTER TABLE public.users ADD COLUMN legacy_notes text;",
      );
      // schema comes back...
      expect(result.schemaRestored).toBe(true);
      // ...but the honest verdict is still false because data was destroyed.
      expect(result.rollbackVerified).toBe(false);
      expect(result.dataMutating).toBe(true);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
