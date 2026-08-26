# Testing & Seed Guide

How to seed the demo target DB and run the verification suite. What's already proven, and what needs a live Postgres.

---

## TL;DR

```bash
# 1. install (needs npm registry access)
pnpm install         # or: npm install

# 2. seed the demo TARGET database (the DB the agent migrates)
TARGET_DB_URL=postgres://postgres:postgres@localhost:5433/prod pnpm db:seed

# 3. run the fast unit suite (no DB needed)
pnpm test:blast

# 4. run the rollback integration suite (needs a throwaway Postgres)
SHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5432/shadow pnpm test:rollback

# everything
pnpm test
```

If the npm registry is unavailable, the blast classifier can be verified with **zero dependencies** using Node's built-in type stripping:

```bash
node --experimental-strip-types scripts/verify_blast.ts
```

---

## What each piece is

| Path | What it is | Needs a DB? |
|---|---|---|
| `fixtures/target_schema.sql` | Demo "prod" schema + 50k users / ~115k orders | — |
| `fixtures/migrations.ts` | The 4-migration corpus (safe / locking / irreversible / unbounded) with expected verdicts. Source of truth for both test suites. | — |
| `scripts/seed.ts` | Loads the target schema into `TARGET_DB_URL`. | yes (target) |
| `packages/shadow/src/blast.ts` | Pure blast-radius / reversibility classifier. | no |
| `packages/shadow/test/blast.test.ts` | Vitest unit tests for the classifier. | no |
| `packages/shadow/src/rollback.ts` | Schema-fingerprint rollback verifier. | yes (shadow) |
| `packages/shadow/test/rollback.test.ts` | Vitest integration tests; **self-skips** if `SHADOW_DATABASE_URL` is unset. | yes (shadow) |
| `scripts/verify_blast.ts` | Dependency-free classifier check (Node strip-types). | no |

## The test corpus (what "correct" means)

| Fixture | up | Severity | Reversibility | rollbackVerified |
|---|---|---|---|---|
| `add_last_login` | `ADD COLUMN last_login_at` | 🟢 green | reversible | ✅ true |
| `backfill_full_name_notnull` | `SET NOT NULL` | 🟡 amber | reversible | ✅ true |
| `drop_legacy_notes` | `DROP COLUMN legacy_notes` | 🔴 red | irreversible | ❌ false |
| `deactivate_all_users` | `UPDATE ... (no WHERE)` | 🔴 red | irreversible | ❌ false |

`rollbackVerified = schemaRestored AND not data-mutating`. `drop_legacy_notes` is the teaching case: the schema fingerprint returns, but data is gone, so the verdict is **false**.

## Verification status (already run in this environment)

- **Blast classifier — PASSED (32/32 checks)** via `node --experimental-strip-types scripts/verify_blast.ts`. Covers the corpus plus DROP TABLE/COLUMN, TRUNCATE, bounded/unbounded UPDATE/DELETE, SET NOT NULL, ALTER TYPE, CREATE INDEX (concurrent vs not), volatile-vs-constant defaults, NOT VALID constraints, RENAME, unknown→amber, statement splitting (incl. semicolons inside literals), and worst-case rollup.
- **Seed fixture — VALIDATED** on a real Postgres 16: `target_schema.sql` loads cleanly → 50,000 users / 115,586 orders.
- **Rollback insight — VALIDATED in SQL** on Postgres 16: after `DROP COLUMN legacy_notes` → re-add, the schema fingerprint was **identical** (`84e95c95…` before and after) while rows with `legacy_notes` data went **16,666 → 0**. This is exactly why `rollback.ts` gates the verdict on `dataMutating`, not schema alone.

> The Vitest suites (`*.test.ts`) require `npm install` (registry access) to run; they encode the same assertions the standalone checks above already proved. The rollback Vitest suite additionally needs a `SHADOW_DATABASE_URL`.

## Running a real Postgres for the integration tests

Any throwaway Postgres works. Quickest with Docker:

```bash
docker run --rm -d --name ms-shadow -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
SHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:rollback
```

The rollback tests create/drop a minimal `users` table inside a transaction per case and **roll it back**, so the DB is left pristine and cases can't interfere.
