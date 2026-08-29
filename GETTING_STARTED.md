# Getting Started — run Migration Sentinel locally

Get the console running on your machine in about 5 minutes. The whole safety
pipeline — shadow dry-run, rollback proof, data pre-flight, the gate, guarded
apply — runs **live** with no model or external key. A model key and the
TrueForge server are optional (only for generating SQL from a plain-English
intent), and a Euron key is optional (only for the copilot chat).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node** | ≥ 22 | `node -v` |
| **pnpm** | 9 | `npm i -g pnpm` |
| **Docker** | any recent | runs the three Postgres databases |
| **Git** | any | to clone |

Optional: `pg_dump` / `psql` on your PATH (the shadow uses `pg_dump`; Docker
Postgres ships it), a **Euron** API key for the copilot, and the **TrueForge**
server for live NL→SQL generation.

---

## 1. Install

```bash
git clone https://github.com/SamChawla/migration-sentinel.git
cd migration-sentinel
pnpm install
```

## 2. Start the databases

```bash
docker compose up -d
```

This starts three Postgres 16 containers (see `docker-compose.yml`):

| Container | Host port | Role |
|---|---|---|
| `sentinel-db` | **5435** | control plane (our own state) |
| `target-db` | **5433** | the database being migrated |
| `shadow-db` | **5434** | ephemeral clones for dry-runs |

> Host `5432` is intentionally avoided — a local Postgres often already owns it.

## 3. Configure environment

There are **two** env files, on purpose:

- **repo-root `.env`** — used by the scripts, agent, and CLI.
- **`apps/web/.env.local`** — used by the running Next.js app. Next reads env
  from the app directory, **not** the repo root.

Copy both templates:

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

The defaults already match `docker-compose.yml`, so for a local demo you don't
need to change anything. Two optional keys:

- `EURON_API_KEY` (in **`apps/web/.env.local`**) — enables the read-only copilot
  chat. It's an OpenAI-compatible key; base URL defaults to
  `https://api.euron.one/api/v1/euri`.
- `ANTHROPIC_API_KEY` (in `.env`) — the model key the TrueForge server uses to
  generate SQL from an English intent.

## 4. Create the schema and seed demo data

```bash
pnpm --filter @sentinel/db migrate   # create the control-plane tables (sentinel-db)
pnpm db:seed                          # seed target-db: users/orders (~50k / ~115k rows)
pnpm db:seed:sentinel                 # seed the console with demo migration requests
```

> The **`db:seed:sentinel`** step is what populates the dashboard and the
> approval queue — skip it and the console comes up empty.

## 5. Run the app

```bash
pnpm dev
```

Open **http://localhost:3000**.

## 6. Log in (one click)

On the homepage click **Login to Console** (or go to `/login`). In demo mode the
approver token is **pre-filled** — just click **Login to Console** again. You'll
land on the dashboard and a **9-step walkthrough** opens automatically (it opens
on every login in demo mode; replay it anytime from the **?** button, bottom-right).

That's it — you can open any request that's *awaiting approval* to see the full
Approval Console, the blast report, the gate, and the copilot.

---

## Optional extras

### Copilot chat (Euron BYOK)
Put your Euron key in `apps/web/.env.local` as `EURON_API_KEY=…` and restart
`pnpm dev`. On any request, "Ask about this migration" then answers grounded in
the analysis and can run **read-only** `SELECT`s against the target.

### Live NL→SQL generation (TrueForge)
Only needed to author a migration from plain English (raw-SQL intake needs none):

```bash
npx @truefoundry/trueforge   # starts the harness on :8790, with a model-provider key
```

The dashboard/settings health rows show the harness as **unreachable** until it's
running — that's expected and doesn't affect the rest of the demo.

---

## Verify the safety core

```bash
pnpm test          # ~167 passing (Vitest)
pnpm typecheck     # tsc over packages + the Next.js app
pnpm test:coverage # v8 coverage over the deterministic safety core
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login says "Auth not configured" | `APPROVER_TOKEN` is unset in `apps/web/.env.local`. Copy the example and restart `pnpm dev`. |
| Console is empty (no migrations) | You skipped `pnpm db:seed:sentinel`. |
| Copilot returns a 502 / "route not found" | Wrong `EURON_BASE_URL`/model. Use `https://api.euron.one/api/v1/euri` and a tools-capable model your plan exposes. |
| Env change didn't take effect | Restart `pnpm dev` — env is read at startup. |
| A database shows "unreachable" | `docker compose up -d` (or `docker ps` to confirm ports 5433/5434/5435). |
| Reset the demo data | Re-run `pnpm db:seed` and `pnpm db:seed:sentinel`. |
| Port 5432 conflict | We already use 5433/5434/5435 to avoid it; make sure nothing else grabbed those. |
