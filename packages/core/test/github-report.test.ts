import { describe, it, expect } from "vitest";
import { buildVerdictComment, VERDICT_MARKER } from "../src/github-report";

const BASE = {
  requestId: "11111111-2222-3333-4444-555555555555",
  title: "Drop legacy_notes from users",
  severity: "red" as const,
  environment: "prod" as const,
  rollbackVerified: false,
  reversibility: "irreversible" as const,
  rowsAffected: 1204338,
  findings: [
    { statement: "ALTER TABLE users DROP COLUMN legacy_notes", severity: "red" as const, note: "Drops a column — data unrecoverable." },
  ],
  qodo: { verdict: "passed_with_warnings", findings: ["Consider a two-phase drop."] },
  consoleUrl: "http://localhost:3000/requests/11111111-2222-3333-4444-555555555555",
};

describe("buildVerdictComment — deterministic PR verdict markdown", () => {
  it("starts with the idempotent-update marker", () => {
    expect(buildVerdictComment(BASE).startsWith(VERDICT_MARKER)).toBe(true);
  });

  it("is deterministic — same input, same output", () => {
    expect(buildVerdictComment(BASE)).toBe(buildVerdictComment({ ...BASE }));
  });

  it("renders severity, rollback verdict, qodo verdict and the findings", () => {
    const md = buildVerdictComment(BASE);
    expect(md).toMatch(/RED/);
    expect(md).toMatch(/rollback/i);
    expect(md).toMatch(/not\s+proven|unrecoverable|failed/i);
    expect(md).toMatch(/passed_with_warnings|passed with warnings/i);
    expect(md).toContain("Drops a column — data unrecoverable.");
    expect(md).toContain("Consider a two-phase drop.");
  });

  it("links back to the approval console when a URL is given", () => {
    expect(buildVerdictComment(BASE)).toContain(BASE.consoleUrl);
  });

  it("a green, rollback-proven verdict reads as safe", () => {
    const md = buildVerdictComment({
      ...BASE,
      severity: "green",
      rollbackVerified: true,
      reversibility: "reversible",
      findings: [{ statement: "ALTER TABLE users ADD COLUMN x int", severity: "green", note: "Metadata-only." }],
      qodo: { verdict: "passed", findings: [] },
    });
    expect(md).toMatch(/GREEN/);
    expect(md).toMatch(/proven|verified/i);
  });
});
