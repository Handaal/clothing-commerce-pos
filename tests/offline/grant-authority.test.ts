import { describe, expect, it } from "vitest";

import { bootstrapFixture } from "./fixtures";

// The offline grant authorizes SELLING only (bounded exposure/quantity limits). Phase 2R must not
// leak any settings-management authority into the signed offline bootstrap, and business/branch
// receipt identity must not become an unsigned mutable offline authority path.
describe("offline grant authority boundary", () => {
  const grant = bootstrapFixture();

  it("contains no settings-management authority", () => {
    const serialized = JSON.stringify(grant).toLowerCase();
    for (const forbidden of ["settings", "permission", "scope", "canmanage", "codenabled"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("bounds the offline policy to sale limits, not configuration authority", () => {
    expect(Object.keys(grant.policy).sort()).toEqual(
      [
        "catalogGrantSeconds",
        "enabled",
        "maxCumulativeExposureMinor",
        "maxPendingOfflineSales",
        "maxQuantityPerLine",
        "maxSaleAmountMinor",
        "operatorLeaseSeconds",
      ].sort(),
    );
  });

  it("does not carry business/branch receipt identity (identity is refreshed only online)", () => {
    // The grant carries operational routing ids and selling authority, never tenant/branch display
    // identity — so offline receipts omit optional identity rather than trusting a stale local copy.
    expect(grant).not.toHaveProperty("business");
    expect(grant).not.toHaveProperty("branch");
    expect(grant).not.toHaveProperty("receiptFooter");
    expect(grant).not.toHaveProperty("tenant");
  });
});
