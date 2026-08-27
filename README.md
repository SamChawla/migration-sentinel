# 🛡️ Migration Sentinel

**An AI agent that plans, dry-runs, and applies PostgreSQL schema migrations — and physically stops for a human before anything irreversible.**

[![CI](https://github.com/SamChawla/migration-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/SamChawla/migration-sentinel/actions/workflows/ci.yml)
![Coverage](https://img.shields.io/badge/coverage-68%25%20lines%20%C2%B7%2088%25%20branches-yellowgreen)
![Tests](https://img.shields.io/badge/tests-167%20passing-brightgreen)
![Qodo](https://img.shields.io/badge/Qodo-13%20review%20rounds%20%C2%B7%200%20open-8A2BE2)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

Built for the **TrueForge Agent Harness Hackathon** (WeMakeDevs × TrueFoundry). The agent runs on TrueForge; every migration travels one pipeline; nothing skips the gate.

```
intake → generate up/down → shadow dry-run (blast radius + rollback proof) → data pre-flight
       → Qodo review → ⏸ HUMAN GATE → guarded apply → audit
```

---

## Table of Contents

- [Why Migration Sentinel](#why-migration-sentinel)
- [What only we do](#what-only-we-do)
- [The pipeline](#the-pipeline)
- [The gate — four dispositions](#the-gate--four-dispositions)
- [How the shadow works (and what it costs)](#how-the-shadow-works-and-what-it-costs)
- [Architecture](#architecture)
- [Control-plane schema](#control-plane-schema)
- [HTTP API](#http-api)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Tests, CI & coverage](#tests-ci--coverage)
- [Project structure](#project-structure)
- [Safety & control](#safety--control)
- [Built with](#built-with)

---

## Why Migration Sentinel

Schema migrations are the single most dangerous routine operation in software. One bad `ALTER TABLE` takes an exclusive lock and stalls every query; a missing `WHERE` rewrites millions of rows; a `DROP COLUMN` shipped without a rollback is unrecoverable. Yet the "review" is still a human squinting at a PR diff and hoping.

The tools you already use — **Alembic, Drizzle Kit, Flyway, Liquibase** — *author*, *version*, and *apply* migrations. They execute exactly what you wrote. None of them tell you what a migration will **do** to production before it runs, none **prove** the rollback works, and none **pause for a human** at the irreversible moment.

> **Alembic is `git commit`. Migration Sentinel is the CI + code review + "are you sure?" gate that runs before that commit hits production.**

We're the **analyze → prove → gate** layer in front of whatever you use to apply. We can even emit an Alembic/Drizzle migration file as output.

## What only we do

| # | Capability | Type |
|---|---|---|
| 1 | **Blast radius before prod** — rows affected, lock type, downtime estimate from the target's own planner statistics | ⚙️ Deterministic |
| 2 | **Rollback proven, not assumed** — apply `up`→`down` on a shadow, verify the schema returns, and flag data-loss *honestly* | ⚙️ Deterministic |
| 3 | **A human gate keyed to danger** — irreversible ops require a typed confirmation; the gate is enforced *independently of the agent* | ⚙️ Deterministic |
| 4 | **Data pre-flight** — exact read-only probes on the real target catch data-dependent failures (`SET NOT NULL` on NULL rows, dup `UNIQUE`, …) | ⚙️ Deterministic |
| 5 | **Authoring from intent** — plain-English or raw SQL → a safe `up`/`down` pair | 🤖 Model (TrueForge) |
| 6 | **Advisory code review** — Qodo reviews the generated migration SQL | 🤖 Model (Qodo) |

The model **proposes**; deterministic policy **disposes**. The severity, the rollback verdict, and the gate decision are all machine-computed — never chosen by the LLM.

## The pipeline

<p align="center">
  <img src="assets/workflow.svg" alt="Migration Sentinel pipeline — Intake, Generate, Dry-run, Pre-flight, Qodo, human Gate, Apply, Audit" width="100%">
</p>

Every request travels the same path. The agent orchestrates it and then **physically pauses** at the gate — the apply tool cannot run until a human decision is recorded in our own database.

```mermaid
flowchart TD
    A[Intake: NL intent or raw SQL] --> B{Have SQL?}
    B -- No --> G[TrueForge generates up/down + summary]
    B -- Yes --> C
    G --> C[pg_dump target schema → clone onto ephemeral shadow]
    C --> D[Static blast classifier]
    C --> E[Rollback proof: up→down schema fingerprint]
    C --> F[Data pre-flight: read-only probes on real target]
    C --> Q[Qodo review of the SQL]
    D & E & F & Q --> P[Gate disposition policy]
    P --> DIS{Disposition}
    DIS -- blocked --> X[⛔ Refused — no approval can override]
    DIS -- auto / approval / typed_confirm --> GATE[⏸ Approval Console]
    GATE -- reject --> STOP[Clean stop]
    GATE -- approve --> APPLY[Guarded apply: lock_timeout + statement_timeout, txn, auto-rollback]
    APPLY --> AUD[apply_run + audit]
```

## The gate — four dispositions

The disposition is computed deterministically from severity + whether a whole-dataset destruction is present + whether the data pre-flight will/can't-be-proven pass.

| Disposition | When | What the human can do |
|---|---|---|
| `auto` | green & recoverable | Approve normally |
| `approval` | amber (locking / slow) | A human approves — no typed confirmation |
| `typed_confirm` | red-but-recoverable, scoped irreversible loss, or data that will/can't-be-proven pass | Type the **exact** affected table name to assume responsibility |
| `blocked` | whole-dataset destruction, no recovery path (`DROP TABLE`, `TRUNCATE`, unbounded `UPDATE`/`DELETE`) | **Nothing** — Sentinel refuses to apply; even human approval cannot override. Remedy is a bounded/reversible replacement |

`blocked` is re-derived from the SQL of record at the gate **and again** inside the apply executor — it is a system property, not a stored flag the agent could tamper with.

## How the shadow works (and what it costs)

We do **not** clone production data (slow, expensive, a privacy problem). Two cheap, independent signals instead:

1. **Schema-only shadow** — a live `pg_dump --schema-only` of the target is cloned into a tiny ephemeral Postgres. We run `up`→`down` on it to prove the migration is valid and the rollback restores the schema. **Zero rows moved.**
2. **Data pre-flight on the real target** — for data-dependent operations we run an **exact, read-only** aggregate probe against the target (e.g. `SELECT count(*) FROM users WHERE legacy_notes IS NULL`) with a hard `statement_timeout`, so we know *before* the gate whether existing data will block the migration.

> Honest limitation: row/downtime figures are **planner estimates, not measured truth** — enough to catch "this rewrites the whole table," never claimed as exact.

## Architecture

```mermaid
flowchart LR
    subgraph Control Plane
        WEB[Next.js console + API]
        AGENT[Agent orchestrator]
        SENT[(sentinel-db<br/>Drizzle state)]
    end
    subgraph Analysis
        SHADOW[(shadow-db<br/>ephemeral clone)]
        TARGET[(target-db<br/>real, read-only until apply)]
    end
    subgraph Sponsors
        TF[TrueForge server<br/>session · turn · tool-approval]
        QODO[Qodo CLI / PR review]
    end

    WEB --> AGENT
    AGENT --> SENT
    AGENT -->|generate| TF
    AGENT -->|pg_dump schema| TARGET
    AGENT -->|clone + up/down proof| SHADOW
    AGENT -->|read-only probes| TARGET
    AGENT -->|review SQL| QODO
    AGENT -.->|guarded apply on approval| TARGET
```

The **only** code path that writes the target is the guarded apply executor, and it independently re-asserts the gate before it runs.

## Control-plane schema

Normalized state in our own Postgres (Drizzle). The `audit_event` table is append-only.

```mermaid
erDiagram
    target_database ||--o{ migration_request : targets
    migration_request ||--o{ generated_artifact : has
    migration_request ||--|| approval : "gated by"
    migration_request ||--o{ shadow_run : "dry-run"
    migration_request ||--o{ apply_run : "applied by"
    migration_request ||--o{ audit_event : logs
    generated_artifact ||--o| qodo_review : "reviewed by"
    shadow_run ||--o| blast_report : produces
    shadow_run ||--o{ preflight_result : probes
    blast_report ||--o{ blast_finding : "per statement"
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/requests` | List all migration requests (hydrated) |
| `POST` | `/api/requests` | Create a request → fires the live pipeline |
| `GET` | `/api/requests/[id]` | Full request detail for the console |
| `POST` | `/api/approvals` | **The gate** — record decision, run independent check, drive guarded apply |
| `GET` | `/api/stream/[id]` | SSE stream of shadow + apply logs |
| `POST` | `/api/auth/login` · `/api/auth/logout` | Single-approver session |

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript (ESM), pnpm workspaces |
| Agent harness | **TrueForge** (`@truefoundry/trueforge-sdk`) — sessions, turn streaming, tool-approval HITL |
| Code review | **Qodo** — GitHub App (`/agentic_review` on PRs) + `@qodo/command` CLI for in-app SQL review |
| Web | Next.js 15 (App Router), React 19 |
| State | Drizzle ORM + PostgreSQL 16 |
| DB access | `pg` (node-postgres) |
| Shadow | Docker Postgres + native `pg_dump` (schema-only) |
| Tests | Vitest |

## Getting started

```bash
pnpm install
cp .env.example .env                 # fill in keys (see below)
docker compose up -d                 # sentinel-db :5435, target-db :5433, shadow-db :5434
pnpm --filter @sentinel/db migrate   # control-plane tables
pnpm db:seed                         # seed target-db with users/orders (50k / 115k rows)
pnpm dev                             # control plane + Approval Console (:3000)

# Optional — only needed to generate SQL from an English intent:
npx @truefoundry/trueforge           # TrueForge server (:8790), with a model-provider key
```

Raw-SQL intake runs the whole pipeline **live** — shadow dry-run, rollback proof, pre-flight, gate, guarded apply — with **no** model or TrueForge server required. TrueForge + a model key are only for the *generate-from-intent* step.

Verify the safety core (the pure classifier/gate/guard tests run with zero external
deps; the rollback + provisioning tests use the ephemeral shadow above):

```bash
pnpm test                            # 167 passing
pnpm test:coverage                   # + v8 coverage report
pnpm typecheck                       # packages + web app
```

## Environment variables

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Control-plane Postgres (sentinel-db) |
| `TARGET_DB_URL` | The database being migrated (read-only until apply) |
| `SHADOW_ADMIN_URL` | Admin conn that can `CREATE`/`DROP` ephemeral shadow DBs |
| `SHADOW_DATABASE_URL` | A throwaway shadow DB — used by the live rollback tests / CI |
| `APPROVER_TOKEN` | The single-approver login token (the Approval Console validates it) |
| `APPROVER_IDENTITY` | Server-set actor recorded in the audit log (default `approver`) |
| `TRUEFORGE_BASE_URL` | TrueForge server (default `http://localhost:8790`) |
| `TRUEFORGE_TOKEN` | *Only* for a hosted/auth-enabled TrueForge (local server needs none) |
| `ANTHROPIC_API_KEY` | The model-provider key the TrueForge server uses to generate SQL |
| `QODO_API_KEY` | In-app Qodo CLI review (unset → review is skipped, pipeline still runs) |
| `PG_DUMP` | Override the `pg_dump` path if not auto-found |

> Next reads `apps/web/.env.local`, **not** the repo-root `.env` — mirror the DB URLs there for the running app.

## Tests, CI & coverage

```bash
pnpm test            # 167 passing (Vitest)
pnpm test:coverage   # v8 coverage over the deterministic safety core
pnpm typecheck       # tsc --noEmit over packages + the Next.js app
```

**167 passing** across the deterministic safety core:

| Suite | Tests | What it proves |
|---|---:|---|
| `shadow/blast` | 32 | statement classifier + SQL lexer (strings, dollar-quotes, nested comments, E-strings) |
| `shadow/qodo-fixes` | 49 | regression tests for every review round (each finding gets a test) |
| `agent/apply` | 19 | autocommit detection + `findExecutorSubversion` (txn/timeout/2PC contract) |
| `shadow/query` | 16 | read-only guard (advisory locks, `set_config`, backend signals, `dblink`, …) |
| `shadow/preflight` | 12 | exact data-dependent probes (NOT NULL, UNIQUE, CHECK, FK, PK, EXCLUDE) |
| `qodo` | 12 | verdict JSON extraction + skip/degradation contract |
| `core/disposition` | 11 | the four-way gate policy |
| `shadow/rollback` | 7 | **live** shadow: `up`→`down` schema-fingerprint proof (real Postgres) |
| `agent/generate` | 5 | resilient `{up,down}` JSON extraction |
| `shadow/provision` | 4 | `sanitizeDump` (dollar-quote-aware pg_dump post-processing) |

Coverage of the safety core (`@vitest/coverage-v8`): **~68% lines/statements, ~88% branches**.
The lower line figure is honest — the guarded-**apply execution** and the network/CLI
clients (TrueForge, `pg`, `pg_dump`, the Qodo CLI) are exercised **live** by
`scripts/smoke_live.ts` (full intake → gate → guarded apply end-to-end against the
real databases), not by unit tests.

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push/PR:
it provisions three Postgres 16 services mirroring `docker-compose`, then runs
`pnpm typecheck` and `pnpm test:coverage` — so the **live rollback + provisioning
tests actually run in CI**, not self-skip.

## Project structure

```
apps/web/            Next.js control plane — API routes + Approval Console + /demo replay
packages/
  core/              shared types · request state machine · independent gate · disposition policy · audit
  db/                Drizzle schema + query layer (the control-plane state)
  shadow/            blast classifier · rollback verifier · data pre-flight · read-only query guard · shadow provisioning + pg_dump
  agent/             TrueForge client + approval loop · generation · orchestrator · guarded apply · safety pipeline · Day-1 spike
  qodo/              Qodo review client (@qodo/command CLI)
fixtures/            demo target schema + the migration corpus
scripts/             seed.ts · seed-sentinel.ts · smoke_live.ts · verify_blast.ts · load-env.ts
.github/workflows/   ci.yml — typecheck + tests + coverage against live Postgres services
```

Meaningful code landed via a **native stacked-PR** set (`feat/foundations` →
`feat/core-db` → `feat/safety-core` → `feat/agent-qodo` → `feat/web-console` →
`feat/scripts`), each reviewed by the Qodo GitHub App and re-reviewed until clean
before merge.

## Safety & control

- **Runs code somewhere safe** — the migration executes first on an **ephemeral, schema-only shadow**, never on prod, during analysis.
- **Stops before anything irreversible** — the agent reaches `awaiting_approval` and does **not** call the apply tool; a human decides.
- **The gate is a system property** — the apply executor calls `assertApproved()` against the database of record and re-derives `blocked` from the SQL; the model cannot self-approve, and a blocked migration can't be pushed through even with human approval.
- **Guarded apply** — `SET lock_timeout` + `statement_timeout`, single transaction, auto-`ROLLBACK` on error/timeout, and an `apply_run` + audit row.
- **Least privilege** — the target is read-only until the approved apply; the NL query box is SELECT-only, enforced four independent ways.

## Built with

TrueForge (agent harness), Qodo (code review), Drizzle + PostgreSQL, Next.js, and Claude Code. The safety core is deterministic and unit-tested; the model is used where judgment helps (authoring) and kept away from where it must not (the gate).

## License

[MIT](LICENSE) © 2026 Migration Sentinel.
