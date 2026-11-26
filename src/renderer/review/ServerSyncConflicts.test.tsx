// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ServerSyncConflicts } from "./ServerSyncConflicts";

afterEach(cleanup);

const REGISTER = "30000000-0000-4000-8000-000000000001";
const status = {
  networkOnline: true,
  pending: 2,
  blocked: 0,
  needsReconciliation: 1,
  lastAttemptAt: "2026-11-15T09:00:00.000Z",
  lastError: null,
};
const shortfall = {
  id: "c0000000-0000-4000-8000-000000000001",
  kind: "stock_shortfall" as const,
  reasonCode: "STOCK_SHORTFALL_AT_SYNC",
  status: "open" as const,
  branchId: null,
  inventoryLocationId: null,
  deviceId: null,
  registerId: REGISTER,
  syncCommandId: "s0000000-0000-4000-8000-000000000001",
  localReference: "local-sale-1",
  references: {
    orderId: "o0000000-0000-4000-8000-000000000001",
    paymentId: null,
    customerId: null,
    promotionId: null,
    membershipId: null,
    variantId: "v0000000-0000-4000-8000-000000000001",
  },
  quantity: 2,
  amountMinor: null,
  currency: "EGP",
  localEvidence: { sku: "TEE-BLK-M", requestedQuantity: 2, cachedOnHand: 2 },
  serverEvidence: { canonicalOnHandAtSync: 0 },
  localEventAt: "2026-11-15T08:00:00.000Z",
  detectedAt: "2026-11-15T09:00:01.000Z",
};

function renderPanel(client: unknown, online = true) {
  return render(
    <I18nProvider>
      <ServerSyncConflicts
        client={client as never}
        registerId={REGISTER}
        syncStatus={{ ...status, networkOnline: online }}
      />
    </I18nProvider>,
  );
}

describe("ServerSyncConflicts (ADR-042 §13.5)", () => {
  it("shows this register's conflicts with SKU, quantities, references and a next step — and no approve action", async () => {
    const listPosSyncConflicts = vi.fn(async () => ({
      generatedAt: "2026-11-15T09:00:02.000Z",
      summary: { open: 1, informational: 0 },
      items: [shortfall],
    }));
    renderPanel({ listPosSyncConflicts });
    await waitFor(() => expect(screen.getAllByTestId("sync-conflict")).toHaveLength(1));
    expect(listPosSyncConflicts).toHaveBeenCalledWith({ registerId: REGISTER, limit: 100 });
    const row = screen.getByTestId("sync-conflict");
    expect(row.textContent).toContain("TEE-BLK-M");
    expect(row.textContent).toMatch(/sold 2 · till estimate 2 · server had 0 · short 2/);
    expect(row.textContent).toContain("local-sale-1");
    expect(row.textContent).toMatch(/Inventory \/ Orders/);
    expect(screen.getByTestId("conflicts-open").textContent).toBe("1");
    expect(screen.getByTestId("conflicts-pending").textContent).toBe("2");
    expect(screen.queryByRole("button", { name: /approve|reject|accept|override/i })).toBeNull();
  });

  it("shows an offline voucher conflict: observed vs server usage, the sale stands, linked to the order, no approve/reprice control", async () => {
    const voucher = {
      ...shortfall,
      id: "c0000000-0000-4000-8000-000000000002",
      kind: "voucher" as const,
      reasonCode: "VX_USAGE_EXHAUSTED",
      quantity: null,
      amountMinor: 259,
      references: {
        ...shortfall.references,
        variantId: null,
        promotionId: "p0000000-0000-4000-8000-000000000001",
      },
      localEvidence: { observedRemaining: 1, discountTotalMinor: 259 },
      serverEvidence: {
        serverRemaining: 0,
        saleStandsAtPricePaid: true,
        redemptionRecorded: false,
      },
    };
    const listPosSyncConflicts = vi.fn(async () => ({
      generatedAt: "2026-11-15T09:00:02.000Z",
      summary: { open: 1, informational: 0 },
      items: [voucher],
    }));
    renderPanel({ listPosSyncConflicts });
    await waitFor(() => expect(screen.getAllByTestId("sync-conflict")).toHaveLength(1));
    const row = screen.getByTestId("sync-conflict");
    expect(row.textContent).toContain("till last saw 1 left · server had 0 left at sync");
    expect(row.textContent).toContain("The sale stands at the price paid");
    expect(row.textContent).toContain("o0000000-0000-4000-8000-000000000001");
    expect(
      screen.queryByRole("button", { name: /approve|reject|accept|override|reprice|edit/i }),
    ).toBeNull();
  });

  it("offline: shows connection state and pending uploads without calling the server", () => {
    const listPosSyncConflicts = vi.fn();
    renderPanel({ listPosSyncConflicts }, false);
    expect(screen.getByTestId("conflicts-connection").textContent).toBe("Offline");
    expect(screen.getByText(/needs a connection/)).toBeTruthy();
    expect(listPosSyncConflicts).not.toHaveBeenCalled();
  });

  it("reports a load failure without inventing data", async () => {
    renderPanel({
      listPosSyncConflicts: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not load/));
    expect(screen.queryAllByTestId("sync-conflict")).toHaveLength(0);
  });
});
