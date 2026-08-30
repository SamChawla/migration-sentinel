import { describe, it, expect } from "vitest";
import {
  classifyStatement,
  classifyMigration,
  splitStatements,
  splitUpDownSql,
} from "../src/blast";
import { MIGRATION_FIXTURES } from "../../../fixtures/migrations";

describe("blast classifier — fixture corpus (source of truth)", () => {
  for (const fx of MIGRATION_FIXTURES) {
    it(`${fx.name}: ${fx.expected.overallSeverity}/${fx.expected.reversibility}`, () => {
      const result = classifyMigration(fx.up);
      expect(result.overallSeverity).toBe(fx.expected.overallSeverity);
      expect(result.reversibility).toBe(fx.expected.reversibility);
    });
  }
});

describe("classifyStatement — RED / irreversible", () => {
  it("DROP COLUMN is red + irreversible + data-mutating", () => {
    const c = classifyStatement("ALTER TABLE users DROP COLUMN email");
    expect(c.severity).toBe("red");
    expect(c.reversibility).toBe("irreversible");
    expect(c.dataMutating).toBe(true);
  });

  it("DROP TABLE is red + irreversible", () => {
    const c = classifyStatement("DROP TABLE orders");
    expect(c.severity).toBe("red");
    expect(c.reversibility).toBe("irreversible");
  });

  it("TRUNCATE is red + irreversible", () => {
    const c = classifyStatement("TRUNCATE users");
    expect(c.severity).toBe("red");
    expect(c.reversibility).toBe("irreversible");
  });

  it("unbounded UPDATE (no WHERE) is red + irreversible", () => {
    const c = classifyStatement("UPDATE users SET is_active = false");
    expect(c.severity).toBe("red");
    expect(c.reversibility).toBe("irreversible");
  });

  it("unbounded DELETE (no WHERE) is red + irreversible", () => {
    const c = classifyStatement("DELETE FROM sessions");
    expect(c.severity).toBe("red");
    expect(c.reversibility).toBe("irreversible");
  });
});

describe("classifyStatement — blocking (Sentinel refuses to apply)", () => {
  it("DROP TABLE is blocking — whole-object destruction", () => {
    expect(classifyStatement("DROP TABLE orders").blocking).toBe(true);
  });

  it("TRUNCATE is blocking", () => {
    expect(classifyStatement("TRUNCATE users").blocking).toBe(true);
  });

  it("unbounded UPDATE is blocking", () => {
    expect(classifyStatement("UPDATE users SET is_active = false").blocking).toBe(true);
  });

  it("unbounded DELETE is blocking", () => {
    expect(classifyStatement("DELETE FROM sessions").blocking).toBe(true);
  });

  it("DROP COLUMN is NOT blocking — scoped, reviewable loss (typed-confirm, not refused)", () => {
    const c = classifyStatement("ALTER TABLE users DROP COLUMN email");
    expect(c.reversibility).toBe("irreversible");
    expect(c.blocking).toBe(false);
  });

  it("bounded UPDATE (with WHERE) is NOT blocking", () => {
    expect(classifyStatement("UPDATE users SET is_active = false WHERE id = 5").blocking).toBe(false);
  });

  it("safe additive column is NOT blocking", () => {
    expect(classifyStatement("ALTER TABLE users ADD COLUMN last_login_at timestamptz").blocking).toBe(false);
  });

  it("classifyMigration surfaces hasBlockingStatement across the whole migration", () => {
    expect(
      classifyMigration("ALTER TABLE users ADD COLUMN a int;\nTRUNCATE users;").hasBlockingStatement,
    ).toBe(true);
    expect(
      classifyMigration("ALTER TABLE users DROP COLUMN legacy_notes;").hasBlockingStatement,
    ).toBe(false);
  });
});

describe("classifyStatement — AMBER / locking or lossy", () => {
  it("UPDATE with WHERE is amber but still data-mutating + irreversible", () => {
    const c = classifyStatement("UPDATE users SET is_active = false WHERE id = 5");
    expect(c.severity).toBe("amber");
    expect(c.dataMutating).toBe(true);
    expect(c.reversibility).toBe("irreversible");
  });

  it("SET NOT NULL is amber but reversible", () => {
    const c = classifyStatement("ALTER TABLE users ALTER COLUMN full_name SET NOT NULL");
    expect(c.severity).toBe("amber");
    expect(c.reversibility).toBe("reversible");
  });

  it("ALTER COLUMN TYPE is amber + lossy", () => {
    const c = classifyStatement("ALTER TABLE users ALTER COLUMN amount TYPE bigint");
    expect(c.severity).toBe("amber");
    expect(c.reversibility).toBe("lossy");
  });

  it("non-concurrent CREATE INDEX is amber", () => {
    const c = classifyStatement("CREATE INDEX idx_users_email ON users (email)");
    expect(c.severity).toBe("amber");
  });

  it("ADD COLUMN with a volatile default is amber (table rewrite)", () => {
    const c = classifyStatement("ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid()");
    expect(c.severity).toBe("amber");
  });
});

describe("classifyStatement — GREEN / safe", () => {
  it("ADD COLUMN nullable is green + reversible", () => {
    const c = classifyStatement("ALTER TABLE users ADD COLUMN last_login_at timestamptz");
    expect(c.severity).toBe("green");
    expect(c.reversibility).toBe("reversible");
    expect(c.dataMutating).toBe(false);
  });

  it("ADD COLUMN with constant default is green", () => {
    const c = classifyStatement("ALTER TABLE users ADD COLUMN status text DEFAULT 'active'");
    expect(c.severity).toBe("green");
  });

  it("CREATE INDEX CONCURRENTLY is green", () => {
    const c = classifyStatement("CREATE INDEX CONCURRENTLY idx ON users (email)");
    expect(c.severity).toBe("green");
  });

  it("ADD CONSTRAINT ... NOT VALID is green", () => {
    const c = classifyStatement(
      "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID",
    );
    expect(c.severity).toBe("green");
  });

  it("RENAME is green + reversible", () => {
    const c = classifyStatement("ALTER TABLE users RENAME COLUMN full_name TO display_name");
    expect(c.severity).toBe("green");
    expect(c.reversibility).toBe("reversible");
  });
});

describe("classifyStatement — conservative default", () => {
  it("unknown statement is treated as amber (never silently green)", () => {
    const c = classifyStatement("VACUUM FULL users");
    expect(c.severity).toBe("amber");
  });
});

describe("splitStatements", () => {
  it("splits multiple statements and strips comments", () => {
    const sql = `
      -- add a column
      ALTER TABLE users ADD COLUMN a int;
      DROP TABLE tmp; /* cleanup */
    `;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("does not split on a semicolon inside a string literal", () => {
    const sql = `UPDATE users SET note = 'a;b' WHERE id = 1;`;
    expect(splitStatements(sql)).toHaveLength(1);
  });
});

describe("classifyMigration — overall = worst statement", () => {
  it("a green + a red statement rolls up to red / irreversible", () => {
    const result = classifyMigration(`
      ALTER TABLE users ADD COLUMN a int;
      ALTER TABLE users DROP COLUMN legacy_notes;
    `);
    expect(result.overallSeverity).toBe("red");
    expect(result.reversibility).toBe("irreversible");
    expect(result.statements).toHaveLength(2);
  });
});

describe("splitUpDownSql — up/down section splitter", () => {
  it("splits at a bare -- sentinel:down marker", () => {
    const { up, down } = splitUpDownSql(
      "CREATE INDEX CONCURRENTLY i ON t (c);\n-- sentinel:down\nDROP INDEX CONCURRENTLY IF EXISTS i;",
    );
    expect(up).toBe("CREATE INDEX CONCURRENTLY i ON t (c);");
    expect(down).toBe("DROP INDEX CONCURRENTLY IF EXISTS i;");
  });

  it("accepts dbmate (-- migrate:down) and goose (-- +goose Down) markers", () => {
    for (const marker of ["-- migrate:down", "-- +goose Down", "--sentinel:down", "-- DOWN"]) {
      const { up, down } = splitUpDownSql(`ALTER TABLE t ADD COLUMN c int;\n${marker}\nALTER TABLE t DROP COLUMN c;`);
      expect(up).toBe("ALTER TABLE t ADD COLUMN c int;");
      expect(down).toBe("ALTER TABLE t DROP COLUMN c;");
    }
  });

  it("no marker → whole input is up, down is empty", () => {
    const { up, down } = splitUpDownSql("ALTER TABLE t DROP COLUMN legacy;");
    expect(up).toBe("ALTER TABLE t DROP COLUMN legacy;");
    expect(down).toBe("");
  });

  it("does NOT split on a marker-looking line inside a dollar-quoted body", () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS void AS $$",
      "BEGIN",
      "  -- down",              // marker text INSIDE the function body — must be ignored
      "  PERFORM 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "-- sentinel:down",       // the REAL delimiter
      "DROP FUNCTION f();",
    ].join("\n");
    const { up, down } = splitUpDownSql(sql);
    expect(up).toContain("CREATE FUNCTION f()");
    expect(up).toContain("-- down"); // still part of the up body, not a split point
    expect(down).toBe("DROP FUNCTION f();");
  });

  it("does NOT split on marker text inside a block comment or a string literal", () => {
    const blk = splitUpDownSql("/*\n-- down\n*/\nSELECT 1;\n-- migrate:down\nSELECT 2;");
    expect(blk.down).toBe("SELECT 2;");
    const str = splitUpDownSql("INSERT INTO t (note) VALUES (e'x\\n-- down\\n');\n-- down\nDELETE FROM t WHERE note LIKE 'x%';");
    expect(str.up).toContain("INSERT INTO t");
    expect(str.down).toBe("DELETE FROM t WHERE note LIKE 'x%';");
  });

  it("a descriptive comment is not mistaken for the marker", () => {
    const { up, down } = splitUpDownSql("-- Down migration (for reference)\nCREATE TABLE t (id int);");
    expect(down).toBe("");
    expect(up).toContain("CREATE TABLE t (id int);");
  });
});
