import { describe, it, expect } from "vitest";
import {
  ENV_ORDER,
  envRank,
  nextEnv,
  escalateForEnvironment,
  normalizeSqlForPromotion,
  promotionEligible,
  type DbEnvironment,
  type GateDisposition,
} from "../src/index";

describe("ENV_ORDER / envRank / nextEnv — the promotion ladder", () => {
  it("orders local → dev → staging → prod", () => {
    expect(ENV_ORDER).toEqual(["local", "dev", "staging", "prod"]);
  });

  it("envRank is the index in the ladder", () => {
    expect(envRank("local")).toBe(0);
    expect(envRank("dev")).toBe(1);
    expect(envRank("staging")).toBe(2);
    expect(envRank("prod")).toBe(3);
  });

  it("nextEnv walks one rung up and stops at prod", () => {
    expect(nextEnv("local")).toBe("dev");
    expect(nextEnv("dev")).toBe("staging");
    expect(nextEnv("staging")).toBe("prod");
    expect(nextEnv("prod")).toBeNull();
  });
});

describe("escalateForEnvironment — gate strictness scales with environment (doc 11 §4)", () => {
  const ALL_ENVS: DbEnvironment[] = ["local", "dev", "staging", "prod"];
  const ALL_DISPOSITIONS: GateDisposition[] = ["auto", "approval", "typed_confirm", "blocked"];
  const rank: Record<GateDisposition, number> = {
    auto: 0,
    approval: 1,
    typed_confirm: 2,
    blocked: 3,
  };

  it("NEVER weakens a disposition, for any env × disposition × severity combination", () => {
    for (const env of ALL_ENVS) {
      for (const d of ALL_DISPOSITIONS) {
        for (const severity of ["green", "amber", "red"] as const) {
          const out = escalateForEnvironment(d, severity, env);
          expect(rank[out], `${d}/${severity}/${env} weakened to ${out}`).toBeGreaterThanOrEqual(
            rank[d],
          );
        }
      }
    }
  });

  it("prod forces typed_confirm for amber", () => {
    expect(escalateForEnvironment("approval", "amber", "prod")).toBe("typed_confirm");
    // defensive: even a mis-armed auto cannot stay auto for amber in prod
    expect(escalateForEnvironment("auto", "amber", "prod")).toBe("typed_confirm");
  });

  it("prod forces typed_confirm for red", () => {
    expect(escalateForEnvironment("typed_confirm", "red", "prod")).toBe("typed_confirm");
    expect(escalateForEnvironment("approval", "red", "prod")).toBe("typed_confirm");
    expect(escalateForEnvironment("auto", "red", "prod")).toBe("typed_confirm");
  });

  it("prod green keeps the base disposition — the forcing rule is amber/red only", () => {
    expect(escalateForEnvironment("auto", "green", "prod")).toBe("auto");
    expect(escalateForEnvironment("approval", "green", "prod")).toBe("approval");
    expect(escalateForEnvironment("typed_confirm", "green", "prod")).toBe("typed_confirm");
  });

  it("lower environments (local/dev/staging) never change the base disposition", () => {
    for (const env of ["local", "dev", "staging"] as const) {
      for (const d of ALL_DISPOSITIONS) {
        for (const severity of ["green", "amber", "red"] as const) {
          expect(escalateForEnvironment(d, severity, env)).toBe(d);
        }
      }
    }
  });

  it("blocked is absolute in EVERY environment — nothing downgrades it", () => {
    for (const env of ALL_ENVS) {
      for (const severity of ["green", "amber", "red"] as const) {
        expect(escalateForEnvironment("blocked", severity, env)).toBe("blocked");
      }
    }
  });
});

describe("normalizeSqlForPromotion — false-negative-safe SQL identity", () => {
  it("strips -- line comments", () => {
    expect(
      normalizeSqlForPromotion("ALTER TABLE users -- add the column\nADD COLUMN age int;"),
    ).toBe(normalizeSqlForPromotion("ALTER TABLE users ADD COLUMN age int;"));
  });

  it("strips /* */ block comments, including multi-line ones", () => {
    expect(
      normalizeSqlForPromotion("ALTER TABLE users /* reviewed\n   by ops */ ADD COLUMN age int;"),
    ).toBe(normalizeSqlForPromotion("ALTER TABLE users ADD COLUMN age int;"));
  });

  it("collapses runs of whitespace (spaces, tabs, newlines) to a single space and trims", () => {
    expect(normalizeSqlForPromotion("  ALTER   TABLE\tusers\n\n  ADD COLUMN age int;  ")).toBe(
      "ALTER TABLE users ADD COLUMN age int;",
    );
  });

  it("does NOT case-fold or otherwise rewrite tokens — different casing stays different (a false negative, which is the safe direction)", () => {
    expect(normalizeSqlForPromotion("alter table users add column age int;")).not.toBe(
      normalizeSqlForPromotion("ALTER TABLE users ADD COLUMN age int;"),
    );
  });

  it("preserves whitespace inside string literals (collapsing them would false-positive)", () => {
    const a = normalizeSqlForPromotion("UPDATE t SET note = 'keep  -- this';");
    expect(a).toContain("'keep  -- this'");
  });

  it("recognizes dollar-quote tags with digits like $tag1$", () => {
    const a = normalizeSqlForPromotion("SELECT $tag1$hello  world$tag1$;");
    expect(a).toContain("$tag1$hello  world$tag1$");
  });
});

describe("promotionEligible — the prod promotion lock (doc 11 §4)", () => {
  const upSql = "ALTER TABLE users ADD COLUMN age int;";

  it("non-prod environments are always eligible (single-gated sandbox story)", () => {
    for (const env of ["local", "dev", "staging"] as const) {
      expect(promotionEligible({ environment: env, upSql, siblings: [] })).toBe(true);
    }
  });

  it("prod with NO siblings is locked", () => {
    expect(promotionEligible({ environment: "prod", upSql, siblings: [] })).toBe(false);
  });

  it("prod unlocks when a LOWER-env sibling was APPLIED with normalized-equal upSql", () => {
    expect(
      promotionEligible({
        environment: "prod",
        upSql,
        siblings: [
          {
            environment: "staging",
            status: "applied",
            upSql: "ALTER TABLE users -- v2\n  ADD COLUMN age int;",
          },
        ],
      }),
    ).toBe(true);
  });

  it("a lower-env sibling that is not applied does NOT unlock prod", () => {
    for (const status of ["awaiting_approval", "approved", "applying", "failed", "rolled_back"] as const) {
      expect(
        promotionEligible({
          environment: "prod",
          upSql,
          siblings: [{ environment: "staging", status, upSql }],
        }),
      ).toBe(false);
    }
  });

  it("an applied sibling with DIFFERENT SQL does not unlock prod", () => {
    expect(
      promotionEligible({
        environment: "prod",
        upSql,
        siblings: [
          { environment: "staging", status: "applied", upSql: "DROP TABLE users;" },
        ],
      }),
    ).toBe(false);
  });

  it("an applied sibling in the SAME env (prod) does not unlock prod — it must be lower", () => {
    expect(
      promotionEligible({
        environment: "prod",
        upSql,
        siblings: [{ environment: "prod", status: "applied", upSql }],
      }),
    ).toBe(false);
  });

  it("missing upSql on either side locks prod (cannot prove identity)", () => {
    expect(
      promotionEligible({
        environment: "prod",
        upSql: null,
        siblings: [{ environment: "staging", status: "applied", upSql }],
      }),
    ).toBe(false);
    expect(
      promotionEligible({
        environment: "prod",
        upSql,
        siblings: [{ environment: "staging", status: "applied", upSql: null }],
      }),
    ).toBe(false);
  });
});
