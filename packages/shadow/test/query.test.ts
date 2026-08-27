import { describe, it, expect } from "vitest";
import { assertReadOnly, ReadOnlyViolation } from "../src/query";

const allowed = [
  "SELECT count(*) FROM users",
  "select * from users where is_active = true",
  "WITH active AS (SELECT id FROM users WHERE is_active) SELECT count(*) FROM active",
  "SELECT count(*) FILTER (WHERE legacy_notes IS NOT NULL) FROM users",
];

const rejected = [
  "UPDATE users SET is_active = false",
  "DELETE FROM users",
  "DROP TABLE users",
  "TRUNCATE users",
  "SELECT 1; DROP TABLE users",                 // chaining
  "SELECT 1; SELECT 2",                          // multiple statements
  "WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x", // writable CTE
  "INSERT INTO users (email) VALUES ('x')",
  "ALTER TABLE users ADD COLUMN x int",
  "SET statement_timeout = 0",
  "COPY users TO '/tmp/out'",
  "",
];

describe("assertReadOnly — allowlist", () => {
  for (const q of allowed) {
    it(`ALLOWS: ${q.slice(0, 48)}`, () => {
      expect(() => assertReadOnly(q)).not.toThrow();
    });
  }
  for (const q of rejected) {
    it(`REJECTS: ${q.slice(0, 48) || "(empty)"}`, () => {
      expect(() => assertReadOnly(q)).toThrow(ReadOnlyViolation);
    });
  }
});
