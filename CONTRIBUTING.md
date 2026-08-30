# Contributing to Migration Sentinel

Thanks for taking the time to dig in. This repo is built the way we'd build
production software: every change lands through a reviewed pull request, and the
deterministic safety core is expected to stay green. This guide gets a newcomer
from a clone to a merged PR.

## Ground rules

- **No direct commits to `main`.** Everything lands via a pull request.
- **Every PR is reviewed by [Qodo](https://www.qodo.ai/)** (the `qodo-code-review`
  GitHub App). Address the findings before you merge — see [Reviews.md](Reviews.md)
  for the running log of past rounds and the recurring bug classes we watch for.
- **Green before merge.** `pnpm lint`, `pnpm typecheck`, and `pnpm test` must pass;
  CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all three
  against three live Postgres 16 services.
- **The safety core is deterministic.** The gate disposition, the rollback
  verdict, and the `blocked` decision are machine-computed and independently
  re-asserted at apply time. If you touch that path, add a test that proves the
  new behavior — the model must never be able to talk its way past the gate.

## Prerequisites

- **Node ≥ 22** and **pnpm 9** (`corepack enable` gives you the pinned version)
- **Docker** (for the three local Postgres instances)
- **PostgreSQL client tools** on your `PATH` — `pg_dump` is used for the
  schema-only shadow (set `PG_DUMP` to override the path if it isn't auto-found)

## Local setup

```bash
pnpm install
cp .env.example .env                          # scripts / agent / CLI
cp apps/web/.env.example apps/web/.env.local  # the running web app (Next reads this one)
docker compose up -d                          # sentinel-db :5435, target-db :5433, shadow-db :5434
pnpm --filter @sentinel/db migrate            # control-plane tables
pnpm db:seed                                  # seed target-db (~50k / ~115k rows)
pnpm db:seed:sentinel                         # seed the console with demo requests
pnpm dev                                      # control plane + Approval Console (:3000)
```

Full walkthrough, env vars, and troubleshooting live in
[GETTING_STARTED.md](GETTING_STARTED.md). TrueForge + a model key are only needed
for the *generate-from-intent* step; raw-SQL intake runs the whole pipeline live
without either.

## Checks — run these before you open a PR

```bash
pnpm lint          # ESLint — correctness rules, not formatting
pnpm typecheck     # tsc --noEmit over packages + the Next.js app
pnpm test          # Vitest — 234 passing (8 live-DB tests self-skip without a shadow URL)
pnpm test:coverage # + v8 coverage over the safety core
```

`pnpm lint:fix` applies the auto-fixable lint results. The lint config
([`eslint.config.js`](eslint.config.js)) is deliberately correctness-focused — it
catches dead code and real bugs and leaves the repo's hand-tuned formatting alone.
There is no enforced formatter; match the style of the file you're editing.

## Branch & commit conventions

- Branch names are typed by intent: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`,
  `chore/<slug>`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with
  a scope, e.g. `feat(gate): …`, `fix(connections): …`, `docs(readme): …`.
- Reference the PR number in the squashed commit (`… (#42)`) and, when a commit
  resolves review findings, say so (`fix: resolve Qodo review findings from #41`).
- If a change was drafted with AI assistance, keep the declaration footer we use
  in PR bodies so provenance stays honest.

## Tests

- **[Vitest](https://vitest.dev/)** is the framework. Unit tests live in each
  package's `test/` directory.
- **Every review finding gets a regression test** — that's what
  `packages/shadow/test/qodo-fixes.test.ts` is. When Qodo (or anyone) catches a
  bug, land the fix *and* the failing spec that would have caught it.
- The **live** shadow tests (`rollback`, `introspect` opt-in) need a throwaway
  Postgres. They self-skip when `SHADOW_DATABASE_URL` is unset and run for real in
  CI. To run them locally:
  ```bash
  SHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5434/shadow pnpm test
  ```

## Pull requests

1. Branch off `main`.
2. Make the change; add tests; get `lint`, `typecheck`, and `test` green.
3. Open the PR with a clear body: what changed, why, how it was tested, and any
   negative-path checks. See the merged PRs for the house format.
4. Wait for the Qodo review. Resolve every finding (fix it, or reply explaining
   why it's a non-issue) before merging.
5. Squash-merge once CI is green and review is clean.

## Project layout

```
apps/web/            Next.js control plane — API routes + Approval Console + /demo replay
packages/
  core/              shared types · request state machine · independent gate · disposition policy · audit
  db/                Drizzle schema + query layer (the control-plane state)
  shadow/            blast classifier · rollback verifier · data pre-flight · read-only query guard · provisioning
  agent/             TrueForge client + approval loop · generation · orchestrator · guarded apply · safety pipeline
  qodo/              Qodo review client (@qodo/command CLI)
fixtures/            demo target schema + the migration corpus
scripts/             seed · seed-sentinel · smoke_live · verify_blast · load-env
```

## Reporting bugs & ideas

Open a GitHub issue. For anything touching the gate, the apply executor, or
tenant/DB boundaries, describe the failure scenario concretely (inputs → wrong
outcome) so it can become a regression test.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
