// @vitest-environment jsdom

import type {
  CommerceClient,
  CreatePosSaleResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PosApplication, type PosAuth } from "./App";
import type { CommerceClientFactory } from "./commerce/client";

afterEach(cleanup);

const signedOutAuth: PosAuth = {
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  sessionId: null,
  getToken: vi.fn(async () => null),
  signOut: vi.fn(async () => undefined),
};

const receipt: CreatePosSaleResponse = {
  saleStatus: "completed",
  order: {
    id: "order-1",
    orderNumber: "POS-0001",
    channel: "pos",
    status: "placed",
    brandId: "brand-1",
    branchId: "branch-1",
    registerId: "register-1",
    currency: "USD",
    totalMinor: 5198,
    actorMembershipId: "member-1",
    placedAt: "2026-09-04T12:00:00.000Z",
    cancelledAt: null,
    cancelledByMembershipId: null,
    cancellationReason: null,
    notes: null,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    lines: [
      {
        id: "line-1",
        lineNumber: 1,
        variantId: "variant-1",
        quantity: 2,
        unitPriceMinor: 2599,
        lineTotalMinor: 5198,
        productName: "Linen Shirt",
        variantName: "Medium",
        sku: "LS-M",
        optionSummary: "Size: M",
      },
    ],
  },
  payment: {
    id: "payment-1",
    orderId: "order-1",
    method: "cash",
    status: "captured",
    currency: "USD",
    amountMinor: 5198,
    cashReceivedMinor: 6000,
    changeMinor: 802,
    capturedByMembershipId: "member-1",
    capturedAt: "2026-09-04T12:00:00.000Z",
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  },
  fulfillment: {
    id: "fulfillment-1",
    orderId: "order-1",
    inventoryLocationId: "location-1",
    inventoryOperationId: "operation-1",
    actorMembershipId: "member-1",
    fulfilledAt: "2026-09-04T12:00:00.000Z",
    createdAt: "2026-09-04T12:00:00.000Z",
    lines: [
      {
        id: "fulfillment-line-1",
        lineNumber: 1,
        orderLineId: "line-1",
        variantId: "variant-1",
        quantity: 2,
      },
    ],
  },
};

function connectedFixture(
  options: { prices?: number[]; createPosSale?: TenantCommerceClient["createPosSale"] } = {},
) {
  const prices = options.prices ?? [2599];
  let priceIndex = 0;
  const createPosSale = options.createPosSale
    ? vi.fn<TenantCommerceClient["createPosSale"]>(options.createPosSale)
    : vi.fn<TenantCommerceClient["createPosSale"]>(async () => receipt);
  const tenantClient = {
    tenantId: "tenant-1",
    getPosContext: vi.fn(async () => ({
      registers: [
        {
          registerId: "register-1",
          registerName: "Front register",
          branchId: "branch-1",
          branchName: "Flagship",
          defaultInventoryLocationId: "location-1",
          defaultInventoryLocationName: "Stockroom",
          sellingCurrency: "USD",
          canSell: true as const,
        },
      ],
    })),
    listProducts: vi.fn(async () => ({
      items: [
        {
          id: "product-1",
          name: "Linen Shirt",
          styleCode: "LS-1",
          status: "active" as const,
          brandId: "brand-1",
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    })),
    getProduct: vi.fn(async () => ({
      product: {
        id: "product-1",
        name: "Linen Shirt",
        styleCode: "LS-1",
        status: "active" as const,
        brandId: "brand-1",
      },
      variants: [
        {
          id: "variant-1",
          sku: "LS-M",
          displayName: "Medium",
          status: "active" as const,
        },
      ],
      options: [],
      prices: [
        {
          variantId: "variant-1",
          currency: "USD",
          amountMinor: prices[Math.min(priceIndex++, prices.length - 1)],
        },
      ],
    })),
    createPosSale,
  } as unknown as TenantCommerceClient;
  const rootClient = {
    getMyTenants: vi.fn(async () => [
      { tenantId: "tenant-1", tenantName: "Dev Store", membershipId: "member-1" },
    ]),
    withTenant: vi.fn(() => tenantClient),
  } as unknown as CommerceClient;
  const clientFactory: CommerceClientFactory = vi.fn(() => rootClient);
  const auth: PosAuth = {
    isLoaded: true,
    isSignedIn: true,
    userId: "user-1",
    sessionId: "session-1",
    getToken: vi.fn(async () => "token"),
    signOut: vi.fn(async () => undefined),
  };
  return { auth, clientFactory, rootClient, tenantClient, createPosSale };
}

describe("connected cashier application", () => {
  it("renders a clear unauthenticated state without bootstrapping tenants", () => {
    const getMyTenants = vi.fn();
    const clientFactory: CommerceClientFactory = () =>
      ({ getMyTenants }) as unknown as CommerceClient;
    render(
      <PosApplication
        auth={signedOutAuth}
        clientFactory={clientFactory}
        signedOutContent={<div>Real Clerk sign in</div>}
      />,
    );
    expect(screen.getByText("Real Clerk sign in")).toBeTruthy();
    expect(getMyTenants).not.toHaveBeenCalled();
  });

  it("restores an authenticated session, resolves tenant/register, and signs out", async () => {
    const fixture = connectedFixture();
    render(<PosApplication auth={fixture.auth} clientFactory={fixture.clientFactory} />);
    expect(await screen.findByRole("heading", { name: "Products" })).toBeTruthy();
    expect(fixture.rootClient.getMyTenants).toHaveBeenCalledTimes(1);
    expect(fixture.rootClient.withTenant).toHaveBeenCalledWith("tenant-1");
    expect(fixture.tenantClient.getPosContext).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Front register")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(fixture.auth.signOut).toHaveBeenCalledTimes(1));
  });

  it("combines cart lines, submits only sale intent, shows receipt, and resets", async () => {
    const fixture = connectedFixture();
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        createKey={() => "sale-key-1"}
      />,
    );
    const productButton = await screen.findByRole("button", { name: /Linen Shirt/ });
    fireEvent.click(productButton);
    const addButton = await screen.findByRole("button", { name: "Add" });
    fireEvent.click(addButton);
    fireEvent.click(addButton);
    expect((screen.getByLabelText(/Quantity for Linen Shirt/) as HTMLInputElement).value).toBe("2");
    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "6000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));

    expect(await screen.findByRole("heading", { name: "Order POS-0001" })).toBeTruthy();
    expect(screen.getByText("Cash captured · Fulfilled")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(fixture.createPosSale).toHaveBeenCalledWith({
      idempotencyKey: "sale-key-1",
      registerId: "register-1",
      expectedTotalMinor: 5198,
      cashReceivedMinor: 6000,
      lines: [{ variantId: "variant-1", quantity: 2 }],
    });
    const submitted = fixture.createPosSale.mock.calls[0][0];
    expect(submitted).not.toHaveProperty("unitPriceMinor");
    expect(submitted).not.toHaveProperty("branchId");
    expect(submitted).not.toHaveProperty("inventoryLocationId");
    expect(submitted).not.toHaveProperty("currency");

    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    expect(await screen.findByText("Your cart is empty.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Complete sale" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fixture.createPosSale).toHaveBeenCalledTimes(1);
  });

  it("refreshes and requires confirmation after PRICE_CHANGED before using a new key", async () => {
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockRejectedValueOnce(
        new ApiHttpError("Price changed", 409, "PRICE_CHANGED", "request-1", [
          { path: ["expectedTotalMinor"], message: "Refresh", value: 2799 },
        ]),
      )
      .mockResolvedValueOnce(receipt);
    const fixture = connectedFixture({ prices: [2599, 2799], createPosSale });
    const keys = ["stale-key", "confirmed-key"];
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        createKey={() => keys.shift() ?? "unexpected"}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Linen Shirt/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));

    const confirm = await screen.findByRole("button", { name: "Confirm updated total" });
    expect(screen.getByText(/server reports/)).toBeTruthy();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await screen.findByRole("heading", { name: "Order POS-0001" });

    expect(createPosSale.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ idempotencyKey: "stale-key", expectedTotalMinor: 2599 }),
      expect.objectContaining({ idempotencyKey: "confirmed-key", expectedTotalMinor: 2799 }),
    ]);
  });
});
