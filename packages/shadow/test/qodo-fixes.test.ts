import { describe, it, expect } from "vitest";
import { splitStatements, classifyStatement, codeOnly } from "../src/blast";
import { assertReadOnly, ReadOnlyViolation } from "../src/query";
import { requiredPreflightChecks } from "../src/preflight";

/**
 * Regression tests for the Qodo PR #3 findings on the safety core.
 */

describe("splitStatements — lexer (dollar-quote + comment-in-string)", () => {
  it("keeps a dollar-quoted function body as ONE statement (#5)", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RAISE NOTICE 'a; b'; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE FUNCTION");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("does not merge across string literals that contain comment markers (#1)", () => {
    // The block-comment open lives inside one string and the close inside a
    // later one; a naive regex would delete the DELETE between them.
    const open = "'/" + "*'";
    const close = "'*" + "/'";
    const sql = `SELECT ${open}; DELETE FROM users; SELECT ${close}`;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts.some((s) => /DELETE FROM users/i.test(s))).toBe(true);
  });
});

describe("assertReadOnly — security (#1)", () => {
  it("rejects the chained comment-in-string bypass as multiple statements", () => {
    const open = "'/" + "*'";
    const close = "'*" + "/'";
    const sql = `SELECT ${open}; DELETE FROM users; SELECT ${close}`;
    expect(() => assertReadOnly(sql)).toThrow(ReadOnlyViolation);
  });

  it("rejects an embedded transaction-control + write", () => {
    expect(() => assertReadOnly("SELECT 1; COMMIT; DELETE FROM users")).toThrow(ReadOnlyViolation);
  });

  it("still allows a genuine single SELECT with a CASE ... END", () => {
    expect(() => assertReadOnly("SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END FROM t")).not.toThrow();
  });
});

describe("classifyStatement", () => {
  it("classifies INSERT as data-mutating so rollback proof can't pass it (#2)", () => {
    const c = classifyStatement("INSERT INTO users (id) VALUES (1)");
    expect(c.dataMutating).toBe(true);
  });

  it("treats a literal WHERE inside a string as an UNBOUNDED update (#3)", () => {
    const c = classifyStatement("UPDATE users SET note = 'reset WHERE everything'");
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("still treats a real WHERE clause as bounded", () => {
    const c = classifyStatement("UPDATE users SET note = 'x' WHERE id = 1");
    expect(c.blocking).toBe(false);
  });
});

describe("codeOnly", () => {
  it("blanks single-quoted and dollar-quoted contents", () => {
    expect(codeOnly("UPDATE t SET x = 'a WHERE b'")).not.toMatch(/WHERE/);
    expect(codeOnly("SELECT $$ DROP TABLE t $$")).not.toMatch(/DROP/);
  });
});

describe("requiredPreflightChecks", () => {
  it("handles ALTER TABLE IF EXISTS ... SET NOT NULL (#11)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE IF EXISTS users ALTER COLUMN email SET NOT NULL");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("not_null");
    expect(checks[0].table).toBe("users");
  });

  it("skips the probe for a NOT VALID check constraint (#9)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE orders ADD CONSTRAINT ck CHECK (total >= 0) NOT VALID");
    expect(checks).toHaveLength(0);
  });

  it("builds a composite foreign-key probe with a proper join (#10)", () => {
    const checks = requiredPreflightChecks(
      "ALTER TABLE orders ADD FOREIGN KEY (a, b) REFERENCES parent (pa, pb)",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("p.pa = c.a AND p.pb = c.b");
  });

  it("excludes null keys from the UNIQUE duplicate probe (#8)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ADD UNIQUE (email)");
    expect(checks[0].probeSql).toContain("email IS NOT NULL");
  });
});

describe("Round 2 regressions", () => {
  it("DROP SCHEMA CASCADE is blocked (#1)", () => {
    const c = classifyStatement("DROP SCHEMA app CASCADE");
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("allows a SELECT that returns a keyword literal (#10)", () => {
    expect(() => assertReadOnly("SELECT 'DELETE' AS word")).not.toThrow();
    expect(() => assertReadOnly("SELECT $$DROP TABLE$$ AS t")).not.toThrow();
  });

  it("rejects a session advisory lock in a read query (#2)", () => {
    expect(() => assertReadOnly("SELECT pg_advisory_lock(1)")).toThrow();
    expect(() => assertReadOnly("SELECT nextval('s')")).toThrow();
  });

  it("produces a preflight check for a quoted identifier with spaces (#7)", () => {
    const checks = requiredPreflightChecks('ALTER TABLE "User Accounts" ALTER COLUMN "email address" SET NOT NULL');
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("not_null");
  });

  it("checks ALL comma-separated actions in one ALTER (#6)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ALTER COLUMN email SET NOT NULL, ADD UNIQUE (handle)");
    const kinds = checks.map((c) => c.kind).sort();
    expect(kinds).toEqual(["not_null", "unique"]);
  });

  it("UNIQUE NULLS NOT DISTINCT keeps null keys in the probe (#8)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE users ADD UNIQUE NULLS NOT DISTINCT (email)");
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).not.toContain("IS NOT NULL");
  });

  it("flags an implicit-PK foreign key for review instead of skipping (#4)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("foreign_key");
    expect(checks[0].probeSql).toBeNull();
  });
});

describe("Round 3 regressions", () => {
  it("DROP DATABASE is blocked (R3 #1)", () => {
    const c = classifyStatement("DROP DATABASE analytics");
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("rejects backend-signal functions in a read query (R3 #2)", () => {
    expect(() => assertReadOnly("SELECT pg_terminate_backend(123)")).toThrow();
    expect(() => assertReadOnly("SELECT pg_cancel_backend(123)")).toThrow();
  });

  it("does not split on a semicolon inside a double-quoted identifier (R3 #5)", () => {
    const stmts = splitStatements('SELECT * FROM "a;b"; SELECT 1');
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('"a;b"');
  });

  it("classifies a data-modifying CTE as data-mutating (R3 #6)", () => {
    const c = classifyStatement("WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d");
    expect(c.dataMutating).toBe(true);
  });

  it("classifies CREATE TABLE AS SELECT as data-mutating, not green (R3 #4)", () => {
    const c = classifyStatement("CREATE TABLE snap AS SELECT * FROM orders");
    expect(c.severity).toBe("amber");
    expect(c.dataMutating).toBe(true);
  });

  it("pre-flights CREATE UNIQUE INDEX (R3 #3)", () => {
    const checks = requiredPreflightChecks("CREATE UNIQUE INDEX idx ON users (email)");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("unique");
  });

  it("captures a CHECK with nested parens (R3 #7)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE t ADD CONSTRAINT ck CHECK (coalesce(age, 0) >= 0)");
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("coalesce(age, 0) >= 0");
  });

  it("NOT VALID on one action does not mask a validated sibling (R3 #9)", () => {
    const checks = requiredPreflightChecks(
      "ALTER TABLE t ADD CONSTRAINT a CHECK (x > 0) NOT VALID, ADD CONSTRAINT b CHECK (y > 0)",
    );
    // only the validated sibling (b) gets a probe
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("y > 0");
  });

  it("a DEFAULT on one action does not suppress a no-default NOT NULL sibling (R3 #8)", () => {
    const checks = requiredPreflightChecks(
      "ALTER TABLE t ADD COLUMN a int NOT NULL, ADD COLUMN b int DEFAULT 0",
    );
    expect(checks.some((c) => c.kind === "add_notnull_no_default")).toBe(true);
  });
});

describe("Round 4 regressions", () => {
  it("DROP SEQUENCE is data-mutating (R4 #6)", () => {
    expect(classifyStatement("DROP SEQUENCE orders_id_seq").dataMutating).toBe(true);
  });

  it("DO / CALL procedural blocks are data-mutating (R4 #8)", () => {
    expect(classifyStatement("DO $$ BEGIN DELETE FROM t; END $$").dataMutating).toBe(true);
    expect(classifyStatement("CALL archive_old_orders()").dataMutating).toBe(true);
  });

  it("does not split on a semicolon inside an E-string escape (R4 #7)", () => {
    const stmts = splitStatements("SELECT E'a\\';b'; SELECT 1");
    expect(stmts).toHaveLength(2);
  });

  it("pre-flights ADD PRIMARY KEY for nulls and duplicates (R4 #10)", () => {
    const checks = requiredPreflightChecks("ALTER TABLE t ADD PRIMARY KEY (id)");
    const kinds = checks.map((c) => c.kind).sort();
    expect(kinds).toEqual(["not_null", "unique"]);
  });

  it("scopes a partial UNIQUE index probe to its predicate (R4 #9)", () => {
    const checks = requiredPreflightChecks("CREATE UNIQUE INDEX i ON t (email) WHERE deleted_at IS NULL");
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("deleted_at IS NULL");
  });
});

describe("Round 5 regressions", () => {
  it("a WHERE hidden in a double-quoted identifier stays UNBOUNDED (R5 #1)", () => {
    // codeOnly must blank double-quoted identifiers; a column named "WHERE"
    // must NOT make a whole-table UPDATE look bounded and slip the gate.
    const c = classifyStatement('UPDATE users SET "WHERE" = 1');
    expect(c.severity).toBe("red");
    expect(c.blocking).toBe(true);
  });

  it("blanks a WHERE inside an E'...' escape string so DML stays unbounded (R5 #5)", () => {
    const c = classifyStatement("UPDATE t SET note = E'a\\'WHERE\\'b'");
    expect(c.blocking).toBe(true);
    expect(codeOnly("SELECT E'x\\'WHERE\\'y'")).not.toMatch(/WHERE/);
  });

  it("closes nested block comments at the OUTER delimiter (R5 #2)", () => {
    const stmts = splitStatements("SELECT 1 /* a /* b */ c */; SELECT 2");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 1");
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("treats backslash as literal in ordinary strings, exposing a chained write (R5 #1/#6)", () => {
    // standard_conforming_strings=on: 'abc\' is a complete string; the DELETE
    // that follows is a real, separate statement the guard must see.
    const sql = "SELECT 'abc\\'; DELETE FROM users;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(classifyStatement(stmts[1]).blocking).toBe(true);
    expect(() => assertReadOnly(sql)).toThrow(ReadOnlyViolation);
  });

  it("flags a quoted-name EXCLUDE constraint for review (R5 #3)", () => {
    const checks = requiredPreflightChecks(
      'ALTER TABLE t ADD CONSTRAINT "no overlap" EXCLUDE USING gist (room WITH =)',
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toBeNull();
  });

  it("does not shatter a quoted PK column that contains a comma (R5 #4)", () => {
    const checks = requiredPreflightChecks('ALTER TABLE t ADD PRIMARY KEY ("a,b")');
    const nn = checks.find((c) => c.kind === "not_null");
    expect(nn?.probeSql).toContain('"a,b" IS NULL');
    // exactly one column → exactly one null condition (not split into two)
    expect(nn?.probeSql?.match(/IS NULL/g)).toHaveLength(1);
  });
});

describe("Round 6 regressions", () => {
  it("builds an exact probe for an expression unique index (R6 #2)", () => {
    const checks = requiredPreflightChecks("CREATE UNIQUE INDEX i ON users (lower(email))");
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("unique");
    // balanced capture keeps the whole expression, not truncated at 'lower(email'
    expect(checks[0].probeSql).toContain("GROUP BY lower(email)");
    expect(checks[0].probeSql).not.toBeNull();
  });

  it("keeps NULL keys in a NULLS NOT DISTINCT unique index probe (R6 #1)", () => {
    const checks = requiredPreflightChecks("CREATE UNIQUE INDEX i ON t (email) NULLS NOT DISTINCT");
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).not.toContain("IS NOT NULL");
  });

  it("still excludes NULL keys for an ordinary unique index", () => {
    const checks = requiredPreflightChecks("CREATE UNIQUE INDEX i ON t (email)");
    expect(checks[0].probeSql).toContain("email IS NOT NULL");
  });

  it("scopes a partial expression unique index to its predicate (R6 #1/#2)", () => {
    const checks = requiredPreflightChecks(
      "CREATE UNIQUE INDEX i ON t (lower(email)) WHERE deleted_at IS NULL",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].probeSql).toContain("lower(email)");
    expect(checks[0].probeSql).toContain("deleted_at IS NULL");
  });
});

describe("Round 7 regressions", () => {
  it("degrades a per-key-option index to manual review, not invalid SQL (R7 #1)", () => {
    for (const sql of [
      "CREATE UNIQUE INDEX i ON t (email DESC NULLS LAST)",
      "CREATE UNIQUE INDEX i ON t (email text_pattern_ops)",
      'CREATE UNIQUE INDEX i ON t (email COLLATE "C")',
    ]) {
      const checks = requiredPreflightChecks(sql);
      expect(checks).toHaveLength(1);
      expect(checks[0].kind).toBe("unique");
      expect(checks[0].probeSql).toBeNull(); // manual review, not malformed SQL
    }
  });

  it("does not invent a predicate from WHERE inside an INCLUDE identifier (R7 #2)", () => {
    const checks = requiredPreflightChecks('CREATE UNIQUE INDEX i ON t (email) INCLUDE ("where")');
    expect(checks).toHaveLength(1);
    // no partial predicate should be attached; probe stays a plain dup check
    expect(checks[0].probeSql).not.toContain('"where"');
    expect(checks[0].probeSql).toContain("email IS NOT NULL");
  });

  it("still builds an exact probe for a plain / expression key (R7 #1/#2)", () => {
    expect(requiredPreflightChecks("CREATE UNIQUE INDEX i ON t (email)")[0].probeSql).toContain("GROUP BY email");
    expect(requiredPreflightChecks("CREATE UNIQUE INDEX i ON t (lower(email))")[0].probeSql).toContain("GROUP BY lower(email)");
  });
});
