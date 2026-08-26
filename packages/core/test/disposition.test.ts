import { describe, it, expect } from "vitest";
import { gateDisposition, assertApproved, GateError } from "../src/index";

describe("gateDisposition — the deterministic gate policy (ADR-004)", () => {
  it("green + recoverable → auto", () => {
    expect(
      gateDisposition({ severity: "green", hasBlockingStatement: false, dataWillFail: false }),
    ).toBe("auto");
  });

  it("amber → approval (human approves, no typed confirm)", () => {
    expect(
      gateDisposition({ severity: "amber", hasBlockingStatement: false, dataWillFail: false }),
    ).toBe("approval");
  });

  it("red (scoped irreversible, e.g. DROP COLUMN) → typed_confirm", () => {
    expect(
      gateDisposition({ severity: "red", hasBlockingStatement: false, dataWillFail: false }),
    ).toBe("typed_confirm");
  });

  it("data pre-flight will fail → typed_confirm even when only amber", () => {
    expect(
      gateDisposition({ severity: "amber", hasBlockingStatement: false, dataWillFail: true }),
    ).toBe("typed_confirm");
  });

  it("data could not be proven (degraded probe) → typed_confirm, never silently auto/approval", () => {
    expect(
      gateDisposition({ severity: "amber", hasBlockingStatement: false, dataWillFail: false, dataUnknown: true }),
    ).toBe("typed_confirm");
  });

  it("blocking statement wins over everything → blocked", () => {
    expect(
      gateDisposition({ severity: "red", hasBlockingStatement: true, dataWillFail: true, dataUnknown: true }),
    ).toBe("blocked");
  });
});

describe("assertApproved — a BLOCKED migration cannot be applied", () => {
  it("throws even with a valid, typed-confirmed approval", () => {
    expect(() =>
      assertApproved({
        decision: "approved",
        requiresTypedConfirm: true,
        typedConfirmValue: "users",
        expectedConfirmValue: "users",
        blocked: true,
      }),
    ).toThrow(GateError);
  });

  it("a non-blocked, approved, typed-confirmed record passes", () => {
    expect(() =>
      assertApproved({
        decision: "approved",
        requiresTypedConfirm: true,
        typedConfirmValue: "users",
        expectedConfirmValue: "users",
        blocked: false,
      }),
    ).not.toThrow();
  });

  it("still rejects a pending decision when not blocked", () => {
    expect(() =>
      assertApproved({ decision: "pending", requiresTypedConfirm: false }),
    ).toThrow(GateError);
  });
});
