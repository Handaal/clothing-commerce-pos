// @vitest-environment jsdom

import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../shell/Toast";
import { SuppliersDesk } from "./SuppliersDesk";

afterEach(cleanup);

describe("SuppliersDesk money workflow", () => {
  it("shows server-computed dues, due reminders and payment history", async () => {
    const now = "2026-10-09T08:00:00.000Z";
    const supplierId = "11111111-1111-4111-8111-111111111111";
    const purchaseId = "22222222-2222-4222-8222-222222222222";
    const client = {
      listSuppliers: vi.fn().mockResolvedValue({
        items: [
          {
            id: supplierId,
            tenantId: "33333333-3333-4333-8333-333333333333",
            name: "Textile House",
            code: "TH",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      listSupplierPurchases: vi.fn().mockResolvedValue({
        items: [
          {
            id: purchaseId,
            supplierId,
            supplierName: "Textile House",
            supplierCode: "TH",
            inventoryOperationId: "44444444-4444-4444-8444-444444444444",
            inventoryLocationId: "55555555-5555-4555-8555-555555555555",
            inventoryLocationName: "Main stock",
            supplierReference: "INV-9",
            currency: "EGP",
            totalMinor: 10_000,
            initialPaidMinor: 4_000,
            effectivePaidMinor: 4_000,
            outstandingMinor: 6_000,
            occurredAt: now,
            notes: null,
            actorMembershipId: "66666666-6666-4666-8666-666666666666",
            createdAt: now,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      supplierDues: vi.fn().mockResolvedValue({
        items: [
          {
            supplierId,
            supplierName: "Textile House",
            supplierCode: "TH",
            supplierStatus: "active",
            currency: "EGP",
            purchasedMinor: 10_000,
            paidMinor: 4_000,
            outstandingMinor: 6_000,
          },
        ],
      }),
      listSupplierReminders: vi.fn().mockResolvedValue({
        items: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            supplierId,
            supplierName: "Textile House",
            dueDate: "2026-10-09",
            amountMinor: 6_000,
            currency: "EGP",
            note: null,
            leadDays: 3,
            notify: true,
            status: "pending",
            isDue: true,
            isOverdue: false,
            actorMembershipId: "66666666-6666-4666-8666-666666666666",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
      listSupplierPayments: vi.fn().mockResolvedValue({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    } as unknown as TenantCommerceClient;

    render(
      <ToastProvider>
        <SuppliersDesk client={client} />
      </ToastProvider>,
    );

    expect(await screen.findByText("Payments due")).toBeTruthy();
    expect(
      (await screen.findAllByText(/Due\s+(?:60\.00\s*EGP|EGP\s*60\.00)/u)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("INV-9 ▸")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(screen.getByText("No standalone payments yet.")).toBeTruthy());
    expect(screen.getByDisplayValue("60.00")).toBeTruthy();
  });
});
