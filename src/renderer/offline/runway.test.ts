import { describe, expect, it } from "vitest";

import type { OfflineReadiness } from "../../shared/offline";
import {
  AUTO_REFRESH_MIN_INTERVAL_MS,
  RUNWAY_REFRESH_THRESHOLD_MS,
  offlineRunway,
  runwayLabel,
  shouldAutoRefreshOffline,
} from "./runway";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function ready(
  overrides: Partial<Extract<OfflineReadiness, { ready: true }>> = {},
): OfflineReadiness {
  return {
    ready: true,
    deviceId: "device-1",
    registerId: "register-1",
    inventoryLocationId: "location-1",
    currency: "EGP",
    acceptedUntil: new Date(NOW + 6 * 60 * 60 * 1_000).toISOString(),
    catalogValidUntil: new Date(NOW + 6 * 60 * 60 * 1_000).toISOString(),
    offlineLoginAvailable: true,
    offlineInstallmentsAvailable: false,
    offlineCreditRemainingMinor: 0,
    ...overrides,
  };
}

function notReady(reason: Extract<OfflineReadiness, { ready: false }>["reason"]): OfflineReadiness {
  return { ready: false, reason, message: reason };
}

describe("offlineRunway", () => {
  it("returns the earlier of the accept and catalog windows", () => {
    const runway = offlineRunway(
      ready({
        acceptedUntil: new Date(NOW + 5 * 60 * 60 * 1_000).toISOString(),
        catalogValidUntil: new Date(NOW + 3 * 60 * 60 * 1_000).toISOString(),
      }),
      NOW,
    );
    expect(runway?.validUntil).toBe(new Date(NOW + 3 * 60 * 60 * 1_000).toISOString());
    expect(runway?.millisRemaining).toBe(3 * 60 * 60 * 1_000);
    expect(runway?.low).toBe(false);
  });

  it("flags a low runway within the threshold and null when not ready", () => {
    const soon = offlineRunway(
      ready({
        acceptedUntil: new Date(NOW + RUNWAY_REFRESH_THRESHOLD_MS - 1).toISOString(),
        catalogValidUntil: new Date(NOW + RUNWAY_REFRESH_THRESHOLD_MS - 1).toISOString(),
      }),
      NOW,
    );
    expect(soon?.low).toBe(true);
    expect(offlineRunway(notReady("GRANT_EXPIRED"), NOW)).toBeNull();
  });
});

describe("runwayLabel", () => {
  it("describes hours, minutes, and the expired boundary", () => {
    expect(runwayLabel(5 * 60 * 60 * 1_000)).toEqual({ kind: "hours", value: 5 });
    expect(runwayLabel(45 * 60 * 1_000)).toEqual({ kind: "minutes", value: 45 });
    expect(runwayLabel(30 * 1_000)).toEqual({ kind: "minutes", value: 1 });
    expect(runwayLabel(0)).toEqual({ kind: "expired" });
    expect(runwayLabel(-1_000)).toEqual({ kind: "expired" });
  });
});

describe("shouldAutoRefreshOffline", () => {
  const base = {
    connected: true,
    networkOnline: true,
    refreshing: false,
    now: NOW,
    lastAttemptAt: null,
  };

  it("refreshes a ready grant only once its runway is low", () => {
    expect(shouldAutoRefreshOffline({ ...base, readiness: ready() })).toBe(false);
    expect(
      shouldAutoRefreshOffline({
        ...base,
        readiness: ready({
          acceptedUntil: new Date(NOW + 30 * 60 * 1_000).toISOString(),
          catalogValidUntil: new Date(NOW + 30 * 60 * 1_000).toISOString(),
        }),
      }),
    ).toBe(true);
  });

  it("recovers a lapsed grant but not an unrecoverable state", () => {
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("GRANT_EXPIRED") })).toBe(true);
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("CATALOG_EXPIRED") })).toBe(
      true,
    );
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("GRANT_MISSING") })).toBe(true);
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("DEVICE_NOT_ENROLLED") })).toBe(
      false,
    );
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("POLICY_LIMIT_REACHED") })).toBe(
      false,
    );
    expect(shouldAutoRefreshOffline({ ...base, readiness: notReady("CLOCK_ROLLBACK") })).toBe(
      false,
    );
  });

  it("never refreshes when disconnected, offline, already refreshing, or throttled", () => {
    const lapsed = notReady("GRANT_EXPIRED");
    expect(shouldAutoRefreshOffline({ ...base, readiness: lapsed, connected: false })).toBe(false);
    expect(shouldAutoRefreshOffline({ ...base, readiness: lapsed, networkOnline: false })).toBe(
      false,
    );
    expect(shouldAutoRefreshOffline({ ...base, readiness: lapsed, refreshing: true })).toBe(false);
    expect(
      shouldAutoRefreshOffline({
        ...base,
        readiness: lapsed,
        lastAttemptAt: NOW - (AUTO_REFRESH_MIN_INTERVAL_MS - 1),
      }),
    ).toBe(false);
    expect(
      shouldAutoRefreshOffline({
        ...base,
        readiness: lapsed,
        lastAttemptAt: NOW - AUTO_REFRESH_MIN_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});
