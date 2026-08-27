// Standalone verification of the blast classifier (no test framework needed).
// Run: node --experimental-strip-types scripts/verify_blast.ts
import { classifyStatement, classifyMigration, splitStatements } from "../packages/shadow/src/blast.ts";
import { MIGRATION_FIXTURES } from "../fixtures/migrations.ts";

let pass = 0;
let fail = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

console.log("Fixture corpus:");
for (const fx of MIGRATION_FIXTURES) {
  const r = classifyMigration(fx.up);
  eq(`${fx.name} severity`, r.overallSeverity, fx.expected.overallSeverity);
  eq(`${fx.name} reversibility`, r.reversibility, fx.expected.reversibility);
}

console.log("Statement cases:");
eq("DROP COLUMN severity", classifyStatement("ALTER TABLE users DROP COLUMN email").severity, "red");
eq("DROP COLUMN reversibility", classifyStatement("ALTER TABLE users DROP COLUMN email").reversibility, "irreversible");
eq("DROP TABLE", classifyStatement("DROP TABLE orders").severity, "red");
eq("TRUNCATE", classifyStatement("TRUNCATE users").severity, "red");
eq("UPDATE no WHERE", classifyStatement("UPDATE users SET is_active = false").severity, "red");
eq("DELETE no WHERE", classifyStatement("DELETE FROM sessions").severity, "red");
eq("UPDATE with WHERE severity", classifyStatement("UPDATE users SET is_active=false WHERE id=5").severity, "amber");
eq("UPDATE with WHERE dataMutating", classifyStatement("UPDATE users SET is_active=false WHERE id=5").dataMutating, true);
eq("SET NOT NULL severity", classifyStatement("ALTER TABLE users ALTER COLUMN full_name SET NOT NULL").severity, "amber");
eq("SET NOT NULL reversibility", classifyStatement("ALTER TABLE users ALTER COLUMN full_name SET NOT NULL").reversibility, "reversible");
eq("ALTER TYPE severity", classifyStatement("ALTER TABLE users ALTER COLUMN amount TYPE bigint").severity, "amber");
eq("ALTER TYPE reversibility", classifyStatement("ALTER TABLE users ALTER COLUMN amount TYPE bigint").reversibility, "lossy");
eq("CREATE INDEX non-concurrent", classifyStatement("CREATE INDEX idx ON users (email)").severity, "amber");
eq("ADD COLUMN volatile default", classifyStatement("ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid()").severity, "amber");
eq("ADD COLUMN nullable", classifyStatement("ALTER TABLE users ADD COLUMN last_login_at timestamptz").severity, "green");
eq("ADD COLUMN constant default", classifyStatement("ALTER TABLE users ADD COLUMN status text DEFAULT 'active'").severity, "green");
eq("CREATE INDEX CONCURRENTLY", classifyStatement("CREATE INDEX CONCURRENTLY idx ON users (email)").severity, "green");
eq("ADD CONSTRAINT NOT VALID", classifyStatement("ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID").severity, "green");
eq("RENAME", classifyStatement("ALTER TABLE users RENAME COLUMN full_name TO display_name").severity, "green");
eq("unknown -> amber", classifyStatement("VACUUM FULL users").severity, "amber");

console.log("Split / rollup:");
eq("split count", splitStatements("ALTER TABLE u ADD COLUMN a int; DROP TABLE t;").length, 2);
eq("no split inside literal", splitStatements("UPDATE u SET n='a;b' WHERE id=1;").length, 1);
const rollup = classifyMigration("ALTER TABLE users ADD COLUMN a int; ALTER TABLE users DROP COLUMN legacy_notes;");
eq("rollup severity", rollup.overallSeverity, "red");
eq("rollup reversibility", rollup.reversibility, "irreversible");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
