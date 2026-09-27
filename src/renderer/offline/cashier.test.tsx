// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalReceipt, OfflineBridge, OfflineSyncStatus } from "../../shared/offline";
import { OfflineCashier, syncLabel, waitingSyncCount } from "./cashier";

afterEach(cleanup);

const status: OfflineSyncStatus = {
  pending: 1,
  leased: 0,
  retryWait: 0,
  blocked: 0,
  synced: 0,
  needsReconciliation: 0,
  networkOnline: false,
  synchronizing: false,
  lastAttemptAt: null,
  lastError: null,
};

const receipt: LocalReceipt = {
  localSaleId: "local-sale-1",
  localReceiptId: "A123-000001",
  lifecycle: "accepted_pending_sync",
  acceptedAt: "2026-09-08T12:00:00.000Z",
  acknowledgedAt: null,
  currency: "USD",
  totalMinor: 2_599,
  cashReceivedMinor: 3_000,
  changeMinor: 401,
  lines: [
    {
      lineNumber: 1,
      productName: "Foundation Tee",
      variantName: "Black / M",
      variantId: "variant-1",
      sku: "TEE-BLK-M",
      optionSummary: "Black / M",
      quantity: 1,
      unitPriceMinor: 2_599,
      lineTotalMinor: 2_599,
    },
  ],
};

function bridge(): OfflineBridge {
  return {
    getReadiness: vi.fn(),
    getCachedCatalog: vi.fn(),
    getProjectedInventory: vi.fn(),
    acceptCashSale: vi.fn(async () => ({
      lifecycle: "accepted_pending_sync" as const,
      localSaleId: receipt.localSaleId,
      localReceiptId: receipt.localReceiptId,
      syncCommandId: "sync-1",
      acceptedAt: receipt.acceptedAt,
      currency: receipt.currency,
      totalMinor: receipt.totalMinor,
      cashReceivedMinor: receipt.cashReceivedMinor,
      changeMinor: receipt.changeMinor,
    })),
    getLocalReceipt: vi.fn(async () => receipt),
    getUnacknowledgedSales: vi.fn(async () => []),
    acknowledgeSale: vi.fn(async () => ({
      ...receipt,
      acknowledgedAt: "2026-09-08T12:05:00.000Z",
    })),
    getPendingSyncSummary: vi.fn(),
    getSyncStatus: vi.fn(),
    requestSync: vi.fn(async () => status),
    bootstrap: vi.fn(),
  };
}

describe("offline cashier", () => {
  it("accepts cash through the main bridge and immediately shows the durable local receipt", async () => {
    const offline = bridge();
    render(
      <OfflineCashier
        bridge={offline}
        currency="USD"
        catalog={[
          {
            productId: "product-1",
            productName: "Foundation Tee",
            brandId: "brand-1",
            variantId: "variant-1",
            sku: "TEE-BLK-M",
            optionSummary: "Black / M",
            currency: "USD",
            unitPriceMinor: 2_599,
            priceId: "price-1",
            priceVersion: "2026-09-08T10:00:00.000Z",
          },
        ]}
        inventory={[
          {
            variantId: "variant-1",
            sku: "TEE-BLK-M",
            snapshotOnHand: 10,
            pendingQuantity: 0,
            projectedAvailable: 10,
            version: 1,
            asOf: "2026-09-08T10:00:00.000Z",
            advisory: true,
          },
        ]}
        syncStatus={status}
        onRefresh={vi.fn(async () => undefined)}
        onUseConnected={vi.fn()}
        onSignOut={vi.fn(async () => undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Foundation Tee/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Offline cash received in minor units"), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept offline cash sale" }));
    expect(await screen.findByRole("heading", { name: "Receipt A123-000001" })).toBeTruthy();
    expect(screen.getByText("Saved locally · Pending synchronization")).toBeTruthy();
    await waitFor(() =>
      expect(offline.acceptCashSale).toHaveBeenCalledWith({
        lines: [{ variantId: "variant-1", quantity: 1 }],
        cashReceivedMinor: 3_000,
      }),
    );
  });

  it("recovers an unacknowledged sale on restart and requires acknowledgement before new selling", async () => {
    const offline = bridge();
    offline.getUnacknowledgedSales = vi.fn(async () => [receipt]);
    render(
      <OfflineCashier
        bridge={offline}
        currency="USD"
        catalog={[]}
        inventory={[]}
        syncStatus={status}
        onRefresh={vi.fn(async () => undefined)}
        onUseConnected={vi.fn()}
        onSignOut={vi.fn(async () => undefined)}
      />,
    );
    // The specific committed receipt is surfaced, not an aggregate "N waiting" count, and the normal
    // selling surface (with its "Accept offline cash sale" button) is not reachable until resolved.
    expect(await screen.findByRole("heading", { name: "Receipt A123-000001" })).toBeTruthy();
    expect(screen.getByText(/interrupted before it was acknowledged/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept offline cash sale" })).toBeNull();

    (offline.getUnacknowledgedSales as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge recovered sale" }));
    await waitFor(() => expect(offline.acknowledgeSale).toHaveBeenCalledWith("local-sale-1"));
    // Once acknowledged, ordinary selling resumes.
    expect(await screen.findByRole("button", { name: "Accept offline cash sale" })).toBeTruthy();
  });

  it("prioritizes reconciliation and blocked statuses for cashier attention", () => {
    expect(syncLabel({ ...status, needsReconciliation: 1 })).toBe("Needs attention");
    expect(syncLabel({ ...status, pending: 0, blocked: 1 })).toBe("Sync blocked");
    expect(syncLabel({ ...status, pending: 0, synchronizing: true })).toBe("Synchronizing");
    expect(waitingSyncCount({ ...status, pending: 2, leased: 1, retryWait: 3 })).toBe(6);
  });
});
