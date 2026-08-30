import { fileURLToPath } from "node:url";
import type { Config } from "drizzle-kit";

// drizzle-kit does NOT auto-load .env. Without this, `pnpm db:migrate` falls back
// to the default below (localhost:5432) and silently hits a stray local Postgres
// instead of the docker control-plane on 5435 — a confusing auth failure. Load
// the repo-root .env first so migrate works out of the box after `docker compose up`.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No root .env (e.g. CI, or DATABASE_URL already exported) — env vars win as-is.
}

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5435/sentinel",
  },
} satisfies Config;
