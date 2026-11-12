// @vitest-environment jsdom

import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfflineBridge, OfflineLocalReport as LocalReport } from "../../shared/offline";
import { I18nProvider } from "../shell/i18n";
import { OfflineLocalReport } from "./OfflineLocalReport";

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

afterEach(cleanup);

function emptyReport(): LocalReport {
  return {
    generatedAt: "2026-11-11T10:00:00.000Z",
    currency: null,
    coverageFrom: null,
    coverageTo: null,
    sales: { count: 0, grossMinor: 0, collectedMinor: 0, outstandingMinor: 0 },
    lifecycle: { acceptedPendingSync: 0, synced: 0, needsReconciliation: 0 },
    customerPayments: { count: 0, totalMinor: 0 },
    unacknowledged: 0,
    pending: 0,
    blocked: 0,
  };
}

function bridgeReturning(report: LocalReport): OfflineBridge {
  return { getLocalReport: vi.fn(async () => report) } as unknown as OfflineBridge;
}

describe("OfflineLocalReport", () => {
  it("shows an honest empty state with no on-device activity", async () => {
    render(<OfflineLocalReport bridge={bridgeReturning(emptyReport())} />);
    await waitFor(() =>
      expect(
        screen.getByText("No sales or payments have been recorded on this device."),
      ).toBeTruthy(),
    );
    // Always labeled device-only and disclaimed as non-canonical.
    expect(screen.getByText("This till only")).toBeTruthy();
    expect(screen.getByText(/not a company-wide report/)).toBeTruthy();
  });

  it("separates device-local figures and server confirmation when there is activity", async () => {
    const report: LocalReport = {
      ...emptyReport(),
      currency: "EGP",
      coverageFrom: "2026-11-11T08:00:00.000Z",
      coverageTo: "2026-11-11T09:30:00.000Z",
      sales: { count: 3, grossMinor: 150000, collectedMinor: 120000, outstandingMinor: 30000 },
      lifecycle: { acceptedPendingSync: 2, synced: 1, needsReconciliation: 0 },
      customerPayments: { count: 1, totalMinor: 5000 },
      unacknowledged: 2,
      pending: 2,
      blocked: 0,
    };
    render(<OfflineLocalReport bridge={bridgeReturning(report)} />);
    await waitFor(() => expect(screen.getByText("Sales on device")).toBeTruthy());
    // Device-local sales count surfaced.
    expect(screen.getByText("3")).toBeTruthy();
    // Server-confirmation breakdown keeps provisional separate from confirmed.
    expect(screen.getByText("2 awaiting sync")).toBeTruthy();
    expect(screen.getByText("1 confirmed by server")).toBeTruthy();
  });

  it("shows an unavailable state when the bridge call fails", async () => {
    const bridge = {
      getLocalReport: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as unknown as OfflineBridge;
    render(<OfflineLocalReport bridge={bridge} />);
    await waitFor(() =>
      expect(screen.getByText("The on-device summary is unavailable on this host.")).toBeTruthy(),
    );
  });

  it("renders nothing without a bridge (non-Electron host)", () => {
    const { container } = render(<OfflineLocalReport bridge={undefined} />);
    expect(container.textContent).toBe("");
  });
});
