import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  // Default matches docker-compose (sentinel-db on host 5435). The running web
  // app always sets DATABASE_URL via apps/web/.env.local; this fallback only
  // covers a stray direct import with no env — point it at the docker DB, not a
  // local 5432 Postgres, so it fails toward the intended control plane.
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5435/sentinel",
});

export const db = drizzle(pool, { schema });
export { schema };
