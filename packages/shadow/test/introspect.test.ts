import { describe, it, expect } from "vitest";
import { introspectSchema, introspectConnection } from "../src/introspect";

/**
 * PR2 (doc 11 §7) — live schema introspection. Unit tests drive a mocked
 * client whose `query` dispatches on the catalog each statement reads, so the
 * mapping logic (qualification, PK flags, FK pairs, truncation) is pinned
 * without a server. The integration case at the bottom is opt-in via
 * SHADOW_DATABASE_URL, same as the rollback suite.
 */

type Row = Record<string, unknown>;

function mockClient(data: { columns: Row[]; pks: Row[]; fks: Row[] }) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string): Promise<{ rows: Row[] }> {
      calls.push(sql);
      if (/contype\s*=\s*'p'/.test(sql)) return { rows: data.pks };
      if (/contype\s*=\s*'f'/.test(sql)) return { rows: data.fks };
      if (/pg_attribute/.test(sql)) return { rows: data.columns };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const USERS_ORDERS = {
  columns: [
    { schema: "public", table_name: "users", column_name: "id", type: "bigint", notnull: true },
    { schema: "public", table_name: "users", column_name: "email", type: "text", notnull: true },
    { schema: "public", table_name: "users", column_name: "full_name", type: "text", notnull: false },
    { schema: "public", table_name: "orders", column_name: "id", type: "bigint", notnull: true },
    { schema: "public", table_name: "orders", column_name: "user_id", type: "bigint", notnull: true },
    { schema: "public", table_name: "orders", column_name: "amount_cents", type: "integer", notnull: false },
  ],
  pks: [
    { schema: "public", table_name: "users", column_name: "id" },
    { schema: "public", table_name: "orders", column_name: "id" },
  ],
  fks: [
    {
      from_schema: "public", from_table: "orders", from_column: "user_id",
      to_schema: "public", to_table: "users", to_column: "id",
    },
  ],
};

describe("introspectSchema — mapping the catalog to the scene shape", () => {
  it("groups columns per table, preserving order, type and NOT NULL", async () => {
    const client = mockClient(USERS_ORDERS);
    const result = await introspectSchema(client);
    expect(result.truncated).toBe(false);
    const users = result.tables.find((t) => t.name === "public.users");
    expect(users).toBeTruthy();
    expect(users!.columns.map((c) => c.name)).toEqual(["id", "email", "full_name"]);
    expect(users!.columns[1]).toMatchObject({ name: "email", type: "text", notNull: true });
    expect(users!.columns[2]).toMatchObject({ name: "full_name", notNull: false });
  });

  it("marks primary-key columns from pg_constraint contype='p'", async () => {
    const client = mockClient(USERS_ORDERS);
    const { tables } = await introspectSchema(client);
    const users = tables.find((t) => t.name === "public.users")!;
    expect(users.columns.find((c) => c.name === "id")!.pk).toBe(true);
    expect(users.columns.find((c) => c.name === "email")!.pk).toBe(false);
  });

  it("qualifies every table name as schema.name — non-public schemas included", async () => {
    const client = mockClient({
      columns: [
        { schema: "app", table_name: "widgets", column_name: "id", type: "bigint", notnull: true },
      ],
      pks: [],
      fks: [],
    });
    const { tables } = await introspectSchema(client);
    expect(tables.map((t) => t.name)).toEqual(["app.widgets"]);
  });

  it("maps FK column pairs with qualified endpoint tables", async () => {
    const client = mockClient(USERS_ORDERS);
    const { fks } = await introspectSchema(client);
    expect(fks).toEqual([
      { fromTable: "public.orders", fromCol: "user_id", toTable: "public.users", toCol: "id" },
    ]);
  });

  it("truncates to maxTables (flagging it) and drops FKs touching cut tables", async () => {
    const client = mockClient({
      columns: [
        { schema: "public", table_name: "a", column_name: "id", type: "bigint", notnull: true },
        { schema: "public", table_name: "b", column_name: "id", type: "bigint", notnull: true },
        { schema: "public", table_name: "b", column_name: "a_id", type: "bigint", notnull: true },
        { schema: "public", table_name: "c", column_name: "id", type: "bigint", notnull: true },
        { schema: "public", table_name: "c", column_name: "b_id", type: "bigint", notnull: true },
      ],
      pks: [],
      fks: [
        { from_schema: "public", from_table: "b", from_column: "a_id", to_schema: "public", to_table: "a", to_column: "id" },
        { from_schema: "public", from_table: "c", from_column: "b_id", to_schema: "public", to_table: "b", to_column: "id" },
      ],
    });
    const result = await introspectSchema(client, { maxTables: 2 });
    expect(result.truncated).toBe(true);
    expect(result.tables.map((t) => t.name)).toEqual(["public.a", "public.b"]);
    // the c→b FK references a table that was cut; it must not dangle
    expect(result.fks).toEqual([
      { fromTable: "public.b", fromCol: "a_id", toTable: "public.a", toCol: "id" },
    ]);
  });

  it("an empty database introspects to empty tables/fks, not an error", async () => {
    const client = mockClient({ columns: [], pks: [], fks: [] });
    const result = await introspectSchema(client);
    expect(result).toEqual({ tables: [], fks: [], truncated: false });
  });
});

const SHADOW_URL = process.env.SHADOW_DATABASE_URL;
describe("introspectConnection — live (opt-in)", () => {
  if (!SHADOW_URL) {
    console.error("[introspect.test] SHADOW_DATABASE_URL not set — skipping the live integration test.");
  }
  it.skipIf(!SHADOW_URL)("connects read-only and returns the shadow DB's schema", async () => {
    const result = await introspectConnection(SHADOW_URL!, { deadlineMs: 8000 });
    expect(Array.isArray(result.tables)).toBe(true);
    expect(Array.isArray(result.fks)).toBe(true);
    expect(typeof result.truncated).toBe("boolean");
  });
});
