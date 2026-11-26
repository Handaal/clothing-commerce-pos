// @vitest-environment jsdom

import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalReturnsState, OfflineReturnGrantView } from "../../shared/offline";
import { I18nProvider } from "../shell/i18n";
import { OfflineReturnPanel, type OfflineReturnBridge } from "./OfflineReturnPanel";

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

afterEach(cleanup);

const grant: OfflineReturnGrantView = {
  returnGrantId: "grant-1",
  orderId: "order-1",
  orderNumber: "POS-1001",
  currency: "USD",
  issuedAt: "2026-09-08T11:55:00.000Z",
  expiresAt: "2099-09-08T20:00:00.000Z",
  allowedReasons: null,
  requiresAdminCredentials: false,
  lines: [
    {
      orderLineId: "line-1",
      lineNumber: 1,
      variantId: "variant-1",
      productName: "Foundation Tee",
      sku: "TEE-BLK-M",
      optionSummary: null,
      grantedQuantity: 2,
      remainingQuantity: 2,
    },
    {
      orderLineId: "line-2",
      lineNumber: 2,
      variantId: "variant-1",
      productName: "Foundation Tee",
      sku: "TEE-BLK-L",
      optionSummary: null,
      grantedQuantity: 1,
      remainingQuantity: 0,
    },
  ],
};

function bridge(overrides: Partial<OfflineReturnBridge> = {}): OfflineReturnBridge {
  const empty: LocalReturnsState = { pending: 0, recent: [] };
  return {
    getReturnGrants: vi.fn(async () => [grant]),
    getLocalReturns: vi.fn(async () => empty),
    recordReturn: vi.fn(async () => ({
      lifecycle: "accepted_pending_sync" as const,
      localReturnId: "local-1",
      syncCommandId: "sync-1",
      orderId: "order-1",
      orderNumber: "POS-1001",
      acceptedAt: "2026-09-08T12:00:00.000Z",
    })),
    ...overrides,
  };
}

describe("OfflineReturnPanel", () => {
  it("explains that nothing is prepared when no grant is cached", async () => {
    render(
      <OfflineReturnPanel
        bridge={bridge({ getReturnGrants: vi.fn(async () => []) })}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/No orders are prepared for offline return/)).toBeTruthy();
  });

  it("captures only granted lines and confirms a refund REQUEST, never a payment", async () => {
    const offline = bridge();
    render(<OfflineReturnPanel bridge={offline} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /POS-1001/ }));

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // A line with nothing remaining under the grant cannot be selected.
    expect(boxes[1]!.disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    fireEvent.change(screen.getByLabelText(/Reason for line 1/i), {
      target: { value: "Too small" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Review return/i }));
    expect(screen.getByText(/Do not hand back cash or card refunds now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Record return \(refund pending\)/ }));

    await waitFor(() =>
      expect(offline.recordReturn).toHaveBeenCalledWith({
        returnGrantId: "grant-1",
        lines: [
          { orderLineId: "line-1", quantity: 1, reason: "Too small", disposition: "non_restock" },
        ],
      }),
    );
    expect(await screen.findByText(/Refund requested — settle on reconnect/)).toBeTruthy();
    expect(screen.getByText(/No refund was paid/)).toBeTruthy();
  });

  it("shows the server-computed refund only after sync", async () => {
    const offline = bridge({
      getLocalReturns: vi.fn(async () => ({
        pending: 0,
        recent: [
          {
            localReturnId: "local-1",
            orderId: "order-1",
            orderNumber: "POS-1001",
            currency: "USD",
            acceptedAt: "2026-09-08T12:00:00.000Z",
            lifecycle: "synced" as const,
            serverReturnId: "return-1",
            refund: {
              id: "refund-1",
              amountMinor: 2_499,
              currency: "USD",
              status: "pending" as const,
            },
            reconciliationReason: null,
            lines: [
              {
                orderLineId: "line-1",
                lineNumber: 1,
                productName: "Foundation Tee",
                sku: "TEE-BLK-M",
                quantity: 1,
                reason: "Too small",
                disposition: "non_restock" as const,
              },
            ],
          },
        ],
      })),
    });
    render(<OfflineReturnPanel bridge={offline} onClose={() => {}} />);
    expect(await screen.findByText(/Synced · refund .*24\.99.* pending settlement/)).toBeTruthy();
  });
});
