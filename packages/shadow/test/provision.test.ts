import { describe, it, expect } from "vitest";
import { sanitizeDump } from "../src/provision";

/**
 * sanitizeDump makes a pg_dump replayable over the wire protocol (via the pg
 * client, not psql). Two classes of line must be removed or the replay throws:
 *   - psql backslash meta-commands (\restrict / \unrestrict / \connect)
 *   - version-specific GUCs a newer pg_dump writes that an older shadow rejects
 *     (SET transaction_timeout is PG17+; the shadow runs PG16 -> 42704).
 */
describe("sanitizeDump", () => {
  it("strips psql backslash meta-commands", () => {
    const dump = [
      "\\restrict abc123",
      "CREATE TABLE users (id int);",
      "\\unrestrict abc123",
    ].join("\n");
    const out = sanitizeDump(dump);
    expect(out).not.toMatch(/\\restrict/);
    expect(out).not.toMatch(/\\unrestrict/);
    expect(out).toContain("CREATE TABLE users (id int);");
  });

  it("strips the PG17+ transaction_timeout GUC an older server rejects", () => {
    const dump = ["SET statement_timeout = 0;", "SET transaction_timeout = 0;", "SET client_encoding = 'UTF8';"].join(
      "\n",
    );
    const out = sanitizeDump(dump);
    expect(out).not.toMatch(/transaction_timeout/);
    // but keeps the SETs a shadow understands
    expect(out).toContain("SET statement_timeout = 0;");
    expect(out).toContain("SET client_encoding = 'UTF8';");
  });

  it("leaves ordinary DDL and comments intact", () => {
    const dump = [
      "-- a comment",
      "CREATE TABLE public.orders (",
      "  id bigint NOT NULL",
      ");",
      "ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);",
    ].join("\n");
    expect(sanitizeDump(dump)).toBe(dump);
  });

  it("does not remove a backslash that is mid-statement, only leading ones", () => {
    // A leading-backslash line is a meta-command; a backslash inside a value is not.
    const dump = "INSERT INTO t VALUES ('a\\nb');";
    expect(sanitizeDump(dump)).toBe(dump);
  });
});
