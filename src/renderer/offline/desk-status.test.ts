import { describe, expect, it } from "vitest";

import type { OfflineReadiness, OfflineSyncStatus } from "../../shared/offline";
import { deskStatus, readinessReasonKey, type DeskOfflineCapability } from "./desk-status";

const READY: Extract<OfflineReadiness, { ready: true }> = {
  ready: true,
  deviceId: "dev-1",
  registerId: "reg-1",
  inventoryLocationId: "loc-1",
  currency: "EGP",
  acceptedUntil: "2026-11-12T00:00:00.000Z",
  catalogValidUntil: "2026-11-12T00:00:00.000Z",
  offlineLoginAvailable: true,
  offlineInstallmentsAvailable: false,
  offlineCreditRemainingMinor: 0,
};

const EXPIRED: OfflineReadiness = {
  ready: false,
  reason: "GRANT_EXPIRED",
  message: "The grant has expired.",
};

function sync(overrides: Partial<OfflineSyncStatus> = {}): OfflineSyncStatus {
  return {
    pending: 0,
    leased: 0,
    retryWait: 0,
    blocked: 0,
    synced: 0,
    needsReconciliation: 0,
    networkOnline: false,
    synchronizing: false,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

function statusFor(
  capability: DeskOfflineCapability,
  overrides: {
    networkOnline?: boolean;
    readiness?: OfflineReadiness;
    sync?: OfflineSyncStatus;
    reasonKey?: string;
    snapshotAt?: string | null;
  } = {},
) {
  return deskStatus({
    capability,
    networkOnline: overrides.networkOnline ?? false,
    readiness: overrides.readiness ?? READY,
    sync: overrides.sync ?? sync(),
    reasonKey: overrides.reasonKey,
    snapshotAt: overrides.snapshotAt,
  });
}

describe("deskStatus", () => {
  it("reports online with live data when connected and nothing is pending", () => {
    const result = statusFor("online-only", {
      networkOnline: true,
      sync: sync({ networkOnline: true }),
      reasonKey: "desk.reason.inventory",
    });
    expect(result.kind).toBe("online");
    expect(result.tone).toBe("good");
  });

  it("surfaces needs-attention even while connected when work is unreconciled", () => {
    const result = statusFor("offline-writes", {
      networkOnline: true,
      sync: sync({ networkOnline: true, needsReconciliation: 2 }),
    });
    expect(result.kind).toBe("queued");
    expect(result.tone).toBe("warn");
    expect(result.unresolvedCount).toBe(2);
  });

  it("shows an offline-writes desk as offline-ready when the grant is valid and nothing queued", () => {
    const result = statusFor("offline-writes");
    expect(result.kind).toBe("offline-ready");
    expect(result.tone).toBe("good");
  });

  it("shows queued when an offline-writes desk has pending outbox work", () => {
    const result = statusFor("offline-writes", { sync: sync({ pending: 3 }) });
    expect(result.kind).toBe("queued");
    expect(result.pendingCount).toBe(3);
  });

  it("degrades an offline-writes desk to blocked-authority with the precise reason when the grant expired", () => {
    const result = statusFor("offline-writes", { readiness: EXPIRED });
    expect(result.kind).toBe("blocked-authority");
    expect(result.tone).toBe("bad");
    // The readiness reason always wins — never a false "ready".
    expect(result.reasonKey).toBe(readinessReasonKey("GRANT_EXPIRED"));
  });

  it("shows a cached-read desk as read-only with the snapshot age", () => {
    const result = statusFor("cached-read", { snapshotAt: "2026-11-10T09:00:00.000Z" });
    expect(result.kind).toBe("cached-readonly");
    expect(result.snapshotAt).toBe("2026-11-10T09:00:00.000Z");
  });

  it("shows a local-only desk as available offline from on-device data", () => {
    const result = statusFor("local-only");
    expect(result.kind).toBe("local-only");
  });

  it("keeps an online-only desk online-only offline (never hides the error as ready)", () => {
    const result = statusFor("online-only", { reasonKey: "desk.reason.inventory" });
    expect(result.kind).toBe("online-only");
    expect(result.reasonKey).toBe("desk.reason.inventory");
  });

  it("treats a policy-blocked desk as online-only with its fail-closed reason", () => {
    const result = statusFor("blocked", { reasonKey: "desk.reason.returns" });
    expect(result.kind).toBe("online-only");
    expect(result.tone).toBe("bad");
    expect(result.reasonKey).toBe("desk.reason.returns");
  });

  it("carries pending/unresolved counts and last-sync in the status", () => {
    const result = statusFor("offline-writes", {
      sync: sync({
        pending: 2,
        leased: 1,
        needsReconciliation: 1,
        lastAttemptAt: "2026-11-11T08:00:00.000Z",
      }),
    });
    expect(result.pendingCount).toBe(3);
    expect(result.unresolvedCount).toBe(1);
    expect(result.lastSyncAt).toBe("2026-11-11T08:00:00.000Z");
  });
});
