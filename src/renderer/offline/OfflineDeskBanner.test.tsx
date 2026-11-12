// @vitest-environment jsdom

import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { OfflineReadiness, OfflineSyncStatus } from "../../shared/offline";
import { I18nProvider } from "../shell/i18n";
import { OfflineDeskBanner } from "./OfflineDeskBanner";

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

afterEach(cleanup);

const READY: OfflineReadiness = {
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

function banner() {
  return screen.getByRole("status");
}

describe("OfflineDeskBanner", () => {
  it("renders a connected state when online", () => {
    render(
      <OfflineDeskBanner
        capability="online-only"
        reasonKey="desk.reason.inventory"
        networkOnline
        readiness={READY}
        sync={sync({ networkOnline: true })}
      />,
    );
    expect(banner().dataset.state).toBe("online");
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("renders offline-ready for a durable-write desk with a valid grant", () => {
    render(
      <OfflineDeskBanner
        capability="offline-writes"
        networkOnline={false}
        readiness={READY}
        sync={sync()}
      />,
    );
    expect(banner().dataset.state).toBe("offline-ready");
    expect(screen.getByText("Available offline")).toBeTruthy();
  });

  it("renders a blocked-authority state with the precise reason when the grant expired", () => {
    render(
      <OfflineDeskBanner
        capability="offline-writes"
        networkOnline={false}
        readiness={{ ready: false, reason: "GRANT_EXPIRED", message: "expired" }}
        sync={sync()}
      />,
    );
    expect(banner().dataset.state).toBe("blocked-authority");
    expect(
      screen.getByText("This till's offline authorization has expired — reconnect to renew it."),
    ).toBeTruthy();
  });

  it("renders a queued state with the pending count when offline work is waiting", () => {
    render(
      <OfflineDeskBanner
        capability="offline-writes"
        networkOnline={false}
        readiness={READY}
        sync={sync({ pending: 2, lastAttemptAt: "2026-11-11T08:00:00.000Z" })}
      />,
    );
    expect(banner().dataset.state).toBe("queued");
    expect(screen.getByText("2 waiting to sync")).toBeTruthy();
  });

  it("renders a cached read-only state with snapshot age for a cached desk", () => {
    render(
      <OfflineDeskBanner
        capability="cached-read"
        reasonKey="desk.reason.orders"
        networkOnline={false}
        readiness={READY}
        sync={sync()}
        snapshotAt="2026-11-10T09:00:00.000Z"
      />,
    );
    expect(banner().dataset.state).toBe("cached-readonly");
    // "As of …" snapshot line is present.
    expect(screen.getByText(/^As of /)).toBeTruthy();
  });

  it("renders an online-only state with the desk's reason (does not hide it as ready)", () => {
    render(
      <OfflineDeskBanner
        capability="online-only"
        reasonKey="desk.reason.inventory"
        networkOnline={false}
        readiness={READY}
        sync={sync()}
      />,
    );
    expect(banner().dataset.state).toBe("online-only");
    expect(
      screen.getByText("Stock is tracked on the server ledger, so it cannot change offline."),
    ).toBeTruthy();
  });

  it("renders a local-only state for a device-local desk", () => {
    render(
      <OfflineDeskBanner
        capability="local-only"
        networkOnline={false}
        readiness={READY}
        sync={sync()}
      />,
    );
    expect(banner().dataset.state).toBe("local-only");
  });
});
