/**
 * Live schema introspection (PR2, doc 11 §7) — the real tables/columns/FKs of
 * a target database, in the shape the console's ERD and the New Migration
 * schema browser render.
 *
 * The catalog SQL builds on the queries already proven in schemaFingerprint
 * (rollback.ts): pg_attribute + format_type + attnotnull for columns,
 * pg_constraint contype='p' for PKs, contype='f' with paired
 * `unnest … WITH ORDINALITY` for FK column pairs.
 *
 * `introspectConnection` COPIES the bounded read-only pattern from the
 * connections route's probeConnection (apps/web can't be imported from here):
 * wall-clock deadline, per-client connect/query/statement timeouts,
 * `BEGIN READ ONLY` → `ROLLBACK`, and cleanup in `finally`.
 */
import { Client } from "pg";

export interface IntrospectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface IntrospectedTable {
  /** Qualified as "schema.name" (e.g. "public.users"). */
  name: string;
  columns: IntrospectedColumn[];
}

export interface IntrospectedFk {
  fromTable: string;
  fromCol: string;
  toTable: string;
  toCol: string;
}

export interface SchemaIntrospection {
  tables: IntrospectedTable[];
  fks: IntrospectedFk[];
  /** TRUE when the table list was cut at maxTables. */
  truncated: boolean;
}

/** The one method this module needs — lets tests drive it with a plain mock. */
export interface QueryableClient {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

const NS = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;

const DEFAULT_MAX_TABLES = 40;

export async function introspectSchema(
  client: QueryableClient,
  opts: { maxTables?: number; priorityTable?: string } = {},
): Promise<SchemaIntrospection> {
  const maxTables = Math.max(1, opts.maxTables ?? DEFAULT_MAX_TABLES);

  // Build a CTE that limits the table list at the catalog level so the column,
  // PK, and FK queries only touch maxTables worth of data — large catalogs no
  // longer materialize every table's columns before truncation.
  // When a priorityTable is given, ensure it survives truncation even if its
  // alphabetical position would place it beyond the cap.
  const prio = opts.priorityTable;
  const prioSchema = prio?.includes(".") ? prio.split(".")[0] : undefined;
  const prioName = prio?.includes(".") ? prio.split(".")[1] : prio;
  const safePrioSchema = prioSchema?.replace(/'/g, "''");
  const safePrioName = prioName?.replace(/'/g, "''");
  const TABLES_CTE = prio
    ? `WITH _tables AS (
        (SELECT c.oid, n.nspname AS schema, c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p') AND ${NS}
         ORDER BY n.nspname, c.relname
         LIMIT ${maxTables + 1})
        UNION
        (SELECT c.oid, n.nspname AS schema, c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p') AND ${NS}
           AND n.nspname = '${safePrioSchema}' AND c.relname = '${safePrioName}')
      )`
    : `WITH _tables AS (
        SELECT c.oid, n.nspname AS schema, c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p') AND ${NS}
         ORDER BY n.nspname, c.relname
         LIMIT ${maxTables + 1}
      )`;

  const columns = await client.query(
    `${TABLES_CTE}
     SELECT t.schema, t.table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
       FROM _tables t
       JOIN pg_attribute a ON a.attrelid = t.oid
      WHERE a.attnum > 0 AND NOT a.attisdropped
      ORDER BY t.schema, t.table_name, a.attnum`,
  );

  const pks = await client.query(
    `${TABLES_CTE}
     SELECT t.schema, t.table_name, a.attname AS column_name
       FROM _tables t
       JOIN pg_constraint con ON con.conrelid = t.oid AND con.contype = 'p'
       JOIN unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      ORDER BY 1, 2, 3`,
  );

  const fkRows = await client.query(
    `${TABLES_CTE}
     SELECT fn.nspname AS from_schema, fc.relname AS from_table, fa.attname AS from_column,
            tn.nspname AS to_schema, tc.relname AS to_table, ta.attname AS to_column
       FROM pg_constraint con
       JOIN pg_class fc ON fc.oid = con.conrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN pg_class tc ON tc.oid = con.confrelid
       JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS dst(attnum, ord) ON dst.ord = src.ord
       JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = src.attnum
       JOIN pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = dst.attnum
      WHERE con.contype = 'f'
        AND (fc.oid IN (SELECT oid FROM _tables) OR tc.oid IN (SELECT oid FROM _tables))
      ORDER BY 1, 2, con.conname, src.ord`,
  );

  // PK lookup: "schema.table.column" → true
  const pkSet = new Set(
    pks.rows.map((r) => `${r.schema}.${r.table_name}.${r.column_name}`),
  );

  // Group columns per table, preserving catalog order (attnum within table).
  const tableMap = new Map<string, IntrospectedTable>();
  for (const r of columns.rows) {
    const name = `${r.schema}.${r.table_name}`;
    let t = tableMap.get(name);
    if (!t) {
      t = { name, columns: [] };
      tableMap.set(name, t);
    }
    t.columns.push({
      name: String(r.column_name),
      type: String(r.type),
      notNull: Boolean(r.notnull),
      pk: pkSet.has(`${r.schema}.${r.table_name}.${r.column_name}`),
    });
  }

  let tables = Array.from(tableMap.values());
  const truncated = tables.length > maxTables;
  if (truncated) {
    tables = tables.slice(0, maxTables);
    if (prio && !tables.some((t) => t.name === prio)) {
      const extra = tableMap.get(prio);
      if (extra) tables.push(extra);
    }
  }
  const kept = new Set(tables.map((t) => t.name));

  const fks: IntrospectedFk[] = fkRows.rows
    .map((r) => ({
      fromTable: `${r.from_schema}.${r.from_table}`,
      fromCol: String(r.from_column),
      toTable: `${r.to_schema}.${r.to_table}`,
      toCol: String(r.to_column),
    }))
    // No dangling edges: both endpoints must have survived the truncation.
    .filter((e) => kept.has(e.fromTable) && kept.has(e.toTable));

  return { tables, fks, truncated };
}

/**
 * Introspect a connection URL with the bounded read-only discipline of
 * probeConnection (apps/web/app/api/connections/route.ts): wall deadline,
 * per-client timeouts, BEGIN READ ONLY, always ROLLBACK + end. Copied, not
 * imported — this package cannot depend on the web app.
 */
export async function introspectConnection(
  url: string,
  opts: { deadlineMs?: number; maxTables?: number; priorityTable?: string } = {},
): Promise<SchemaIntrospection> {
  const deadlineMs = Math.max(1000, opts.deadlineMs ?? 8000);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: Math.min(4000, deadlineMs),
    query_timeout: Math.min(4000, deadlineMs),
    statement_timeout: Math.min(4000, deadlineMs),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.end().catch(() => {});
      reject(new Error(`Schema introspection exceeded ${deadlineMs} ms.`));
    }, deadlineMs);
  });
  const work = (async () => {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    try {
      return await introspectSchema(client, { maxTables: opts.maxTables, priorityTable: opts.priorityTable });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  })();
  try {
    return await Promise.race([work, cancel]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => {}); // swallow the abandoned worker's later rejection
    await client.end().catch(() => {});
  }
}
