/**
 * Migration test corpus.
 *
 * These four fixtures are the backbone of everything: they double as
 *   (1) the demo script (one of each color at the gate),
 *   (2) the expected-value table for the blast-classifier unit tests, and
 *   (3) the inputs for the rollback-verifier integration tests.
 *
 * `expected` encodes what a correct system MUST conclude. If the classifier
 * or verifier disagrees with these, that's a bug — not the fixture.
 */

export type Severity = "green" | "amber" | "red";
export type Reversibility = "reversible" | "lossy" | "irreversible";

export interface MigrationFixture {
  name: string;
  description: string;
  up: string;
  down: string;
  expected: {
    overallSeverity: Severity;
    reversibility: Reversibility;
    /** rollback proof (up→down) should restore the original schema */
    rollbackVerified: boolean;
  };
  /** data pre-flight expectation against the SEEDED demo target (ADR-011) */
  expectedPreflight?: {
    dataDependent: boolean;
    /** whether it would FAIL on the seeded target data */
    willFailOnSeededTarget: boolean;
  };
}

export const MIGRATION_FIXTURES: MigrationFixture[] = [
  {
    name: "add_last_login",
    description: "Additive, nullable column — the safe/boring case.",
    up: `ALTER TABLE public.users ADD COLUMN last_login_at timestamptz;`,
    down: `ALTER TABLE public.users DROP COLUMN last_login_at;`,
    expected: {
      overallSeverity: "green",
      reversibility: "reversible",
      rollbackVerified: true,
    },
  },
  {
    name: "backfill_full_name_notnull",
    description:
      "SET NOT NULL on a column with NO nulls in the seed — DDL passes AND data pre-flight passes.",
    up: `ALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;`,
    down: `ALTER TABLE public.users ALTER COLUMN full_name DROP NOT NULL;`,
    expected: {
      overallSeverity: "amber",
      reversibility: "reversible",
      rollbackVerified: true,
    },
    // full_name is populated for every seeded row → pre-flight finds 0 violations.
    expectedPreflight: { dataDependent: true, willFailOnSeededTarget: false },
  },
  {
    name: "require_legacy_notes_notnull",
    description:
      "SET NOT NULL on a column that HAS nulls in the seed — valid DDL, but the DATA pre-flight catches that it will FAIL without a backfill. The data-dependent case.",
    up: `ALTER TABLE public.users ALTER COLUMN legacy_notes SET NOT NULL;`,
    down: `ALTER TABLE public.users ALTER COLUMN legacy_notes DROP NOT NULL;`,
    expected: {
      overallSeverity: "amber",
      reversibility: "reversible",
      rollbackVerified: true,
    },
    // ~2/3 of seeded rows have NULL legacy_notes → pre-flight WILL fail → agent
    // must ask for a backfill value and regenerate a two-phase migration.
    expectedPreflight: { dataDependent: true, willFailOnSeededTarget: true },
  },
  {
    name: "drop_legacy_notes",
    description:
      "DROP COLUMN — schema is reversible but the DATA is gone forever. The RED case.",
    up: `ALTER TABLE public.users DROP COLUMN legacy_notes;`,
    // The down re-adds the column but CANNOT restore the dropped values.
    down: `ALTER TABLE public.users ADD COLUMN legacy_notes text;`,
    expected: {
      overallSeverity: "red",
      reversibility: "irreversible",
      // The down re-adds the column so the SCHEMA fingerprint matches — but the
      // honest rollbackVerified is FALSE, because the dropped data is gone.
      // This fixture exists specifically to prove the verifier does not treat
      // schema-restored as data-restored.
      rollbackVerified: false,
    },
  },
  {
    name: "deactivate_all_users",
    description:
      "Unbounded UPDATE (no WHERE) — mass data mutation, no way back. RED.",
    up: `UPDATE public.users SET is_active = false;`,
    down: `-- No rollback: prior per-row values are not recoverable.`,
    expected: {
      overallSeverity: "red",
      reversibility: "irreversible",
      rollbackVerified: false,
    },
  },
];

/** Convenience lookups for tests. */
export const fixtureByName = (name: string): MigrationFixture => {
  const f = MIGRATION_FIXTURES.find((m) => m.name === name);
  if (!f) throw new Error(`Unknown fixture: ${name}`);
  return f;
};
