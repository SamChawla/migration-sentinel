import type { GateDisposition } from "./disposition";
import type { DbEnvironment, RequestStatus, Severity } from "./types";

/**
 * Environment promotion policy (doc 11 §4).
 *
 * Changes climb a fixed ladder — local → dev → staging → prod — and the gate
 * gets STRICTER as they climb, never looser. This module is pure policy, the
 * same shape as `gateDisposition`: no I/O, no clock, fully table-testable.
 */

export const ENV_ORDER = ["local", "dev", "staging", "prod"] as const satisfies
  readonly DbEnvironment[];

export function envRank(env: DbEnvironment): number {
  return ENV_ORDER.indexOf(env);
}

/** The next rung up the ladder, or null when already at prod. */
export function nextEnv(env: DbEnvironment): DbEnvironment | null {
  const i = envRank(env);
  return i >= 0 && i < ENV_ORDER.length - 1 ? ENV_ORDER[i + 1] : null;
}

const DISPOSITION_RANK: Record<GateDisposition, number> = {
  auto: 0,
  approval: 1,
  typed_confirm: 2,
  blocked: 3,
};

/**
 * Scale a gate disposition to the target environment. Wraps — never forks —
 * `gateDisposition()`: callers compute the base disposition first, then pass
 * it through here with the environment of the target connection.
 *
 * Invariants:
 *  - never weakens: the result is at least as strict as the input;
 *  - prod forces `typed_confirm` for amber/red severities;
 *  - `blocked` is absolute in every environment.
 */
export function escalateForEnvironment(
  disposition: GateDisposition,
  severity: Severity,
  env: DbEnvironment,
): GateDisposition {
  if (disposition === "blocked") return "blocked";
  if (env === "prod" && severity !== "green") {
    return DISPOSITION_RANK[disposition] >= DISPOSITION_RANK.typed_confirm
      ? disposition
      : "typed_confirm";
  }
  return disposition;
}

/**
 * Normalize SQL just enough to recognize "the same migration" across a
 * promotion group: strip comments, collapse whitespace, trim. Deliberately
 * conservative — no case-folding, no token rewriting — because a false
 * NEGATIVE only keeps the prod rail locked (safe), while a false positive
 * would unlock prod for different SQL (unsafe).
 */
export function normalizeSqlForPromotion(sql: string): string {
  // Literal-aware scan: comments must NOT be stripped inside '…', "…" or
  // $tag$…$tag$ — otherwise two different literals containing "--" would
  // normalize equal (a false positive, the unsafe direction).
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") (depth += 1), (i += 2);
        else if (sql.slice(i, i + 2) === "*/") (depth -= 1), (i += 2);
        else i += 1;
      }
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) j += 2; // '' / "" escape
          else break;
        } else j += 1;
      }
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (sql[i] === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        out += sql.slice(i, stop);
        i = stop;
      } else {
        out += sql[i];
        i += 1;
      }
    } else if (/\s/.test(sql[i])) {
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
      i += 1;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out.trim();
}

export interface PromotionSibling {
  environment: DbEnvironment;
  status: RequestStatus;
  upSql: string | null;
}

export interface PromotionEligibilityInput {
  /** Environment of the request being approved/applied. */
  environment: DbEnvironment;
  /** The request's up migration SQL (latest artifact). */
  upSql: string | null;
  /** Other requests in the same promotion group. */
  siblings: PromotionSibling[];
}

/**
 * The prod promotion lock: a prod request is eligible only when some sibling
 * in the SAME promotion group ran in a LOWER environment, reached `applied`,
 * and carries normalized-equal upSql. Non-prod environments are always
 * eligible (single-gated sandbox story). Missing SQL on either side locks —
 * identity that cannot be proven is treated as not proven.
 */
export function promotionEligible(input: PromotionEligibilityInput): boolean {
  if (input.environment !== "prod") return true;
  if (!input.upSql) return false;
  const want = normalizeSqlForPromotion(input.upSql);
  if (!want) return false;
  return input.siblings.some(
    (s) =>
      s.status === "applied" &&
      envRank(s.environment) < envRank(input.environment) &&
      !!s.upSql &&
      normalizeSqlForPromotion(s.upSql) === want,
  );
}
