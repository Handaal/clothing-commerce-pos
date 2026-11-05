import { describe, expect, it } from "vitest";

import type { OfflineReadiness } from "../../shared/offline";
import { needsCommissioning } from "./commissioning";

function unavailable(
  reason: Extract<OfflineReadiness, { ready: false }>["reason"],
): OfflineReadiness {
  return { ready: false, reason, message: reason };
}

const ready: OfflineReadiness = {
  ready: true,
  deviceId: "device-1",
  registerId: "register-1",
  inventoryLocationId: "location-1",
  currency: "EGP",
  acceptedUntil: "2099-01-01T00:00:00.000Z",
  catalogValidUntil: "2099-01-01T00:00:00.000Z",
  offlineLoginAvailable: true,
  offlineInstallmentsAvailable: false,
  offlineCreditRemainingMinor: 0,
};

describe("needsCommissioning", () => {
  it("is true for a never-armed install that a connected arming would resolve", () => {
    expect(needsCommissioning(unavailable("DEVICE_NOT_ENROLLED"))).toBe(true);
    expect(needsCommissioning(unavailable("GRANT_MISSING"))).toBe(true);
  });

  it("is false once offline is ready — nothing to commission", () => {
    expect(needsCommissioning(ready)).toBe(false);
  });

  it("is false for a lapsed grant: the opportunistic auto-refresh owns those, not first-run arming", () => {
    expect(needsCommissioning(unavailable("GRANT_EXPIRED"))).toBe(false);
    expect(needsCommissioning(unavailable("CATALOG_EXPIRED"))).toBe(false);
  });

  it("is false for genuine faults a re-arm cannot fix", () => {
    expect(needsCommissioning(unavailable("DEVICE_NOT_ACTIVE"))).toBe(false);
    expect(needsCommissioning(unavailable("PRIVATE_KEY_UNAVAILABLE"))).toBe(false);
    expect(needsCommissioning(unavailable("BINDING_MISMATCH"))).toBe(false);
    expect(needsCommissioning(unavailable("CLOCK_ROLLBACK"))).toBe(false);
    expect(needsCommissioning(unavailable("POLICY_LIMIT_REACHED"))).toBe(false);
  });
});
