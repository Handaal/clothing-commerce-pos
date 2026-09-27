// @vitest-environment jsdom

import type {
  CommerceClient,
  CreatePosSaleResponse,
  PosQuoteResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { ApiHttpError, ApiNetworkError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfflineBridge } from "../shared/offline";
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
  options: {
    prices?: number[];
    createPosSale?: TenantCommerceClient["createPosSale"];
    posQuote?: TenantCommerceClient["posQuote"];
    keys?: string[];
  } = {},
) {
  const prices = options.prices ?? [2599];
  let priceIndex = 0;
  // Track the price of the most recent catalog load so the default quote mirrors the displayed gross.
  let lastLoadedPrice = prices[0];
  const createPosSale = options.createPosSale
    ? vi.fn<TenantCommerceClient["createPosSale"]>(options.createPosSale)
    : vi.fn<TenantCommerceClient["createPosSale"]>(async () => receipt);
  const posQuote =
    options.posQuote ??
    (async (body) => {
      const gross = body.lines.reduce((sum, line) => sum + line.quantity * lastLoadedPrice, 0);
      return {
        currency: "USD",
        grossSubtotalMinor: gross,
        discountTotalMinor: 0,
        totalMinor: gross,
        codeStatus: "none" as const,
        promotion: null,
      };
    });
  const posQuoteFn = vi.fn<TenantCommerceClient["posQuote"]>(posQuote);
  const tenantClient = {
    tenantId: "tenant-1",
    getPosContext: vi.fn(async () => ({
      business: {
        tenant: {
          displayName: "Dev Store",
          legalName: "Dev Store LLC",
          taxIdentifier: "EG-123456789",
        },
      },
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
          branch: {
            displayName: "Flagship Store",
            addressLine1: "12 Nile Corniche",
            addressLine2: null,
            city: "Cairo",
            region: null,
            postalCode: null,
            countryCode: "EG",
            contactEmail: null,
            contactPhone: "+20 2 1234 5678",
            receiptFooter: "Thank you for shopping with us!",
          },
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
          amountMinor: (lastLoadedPrice = prices[Math.min(priceIndex++, prices.length - 1)]),
        },
      ],
    })),
    posQuote: posQuoteFn,
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
  // A faithful stand-in for the durable main-process connected-sale journal: it mints the
  // idempotency key (renderer intent never carries one), persists the "workflow" before dispatch,
  // keeps an uncertain result unresolved for same-key replay, and closes on a definite rejection.
  const salesGateway = makeFakeSalesGateway(createPosSale, options.keys);
  return {
    auth,
    clientFactory,
    rootClient,
    tenantClient,
    createPosSale,
    posQuote: posQuoteFn,
    salesGateway,
  };
}

function classifyForFixture(error: unknown): import("../shared/sales").ConnectedSaleError {
  const base = { authoritativeTotalMinor: null as number | null };
  if (error instanceof ApiNetworkError)
    return { ...base, kind: "network", code: "NETWORK_ERROR", message: "offline", uncertain: true };
  if (error instanceof ApiHttpError) {
    if (error.status >= 500 || error.code === "IDEMPOTENCY_CONFLICT")
      return {
        ...base,
        kind: error.code === "IDEMPOTENCY_CONFLICT" ? "conflict" : "server",
        code: error.code,
        message: error.message,
        uncertain: true,
      };
    if (error.code === "PRICE_CHANGED" || error.code === "CURRENCY_CHANGED")
      return {
        kind: "price-changed",
        code: error.code,
        message: error.message,
        authoritativeTotalMinor:
          (error.details?.find((d) => d.path.includes("expectedTotalMinor"))?.value as number) ??
          null,
        uncertain: false,
      };
    if (error.code === "PROMOTION_UNAVAILABLE")
      return {
        ...base,
        kind: "promotion",
        code: error.code,
        message: error.message,
        uncertain: false,
      };
    return {
      ...base,
      kind: error.status === 400 ? "validation" : "server",
      code: error.code,
      message: error.message,
      uncertain: false,
    };
  }
  return { ...base, kind: "server", code: "UNKNOWN_ERROR", message: "unknown", uncertain: true };
}

function makeFakeSalesGateway(
  createPosSale: TenantCommerceClient["createPosSale"],
  keys?: string[],
): import("./checkout/sale-executor").SalesGateway {
  const queue = [...(keys ?? [])];
  let counter = 0;
  const nextKey = () => queue.shift() ?? `key-${++counter}`;
  let pending: {
    id: string;
    key: string;
    intent: import("../shared/sales").ConnectedSaleIntent;
  } | null = null;

  async function dispatch(
    workflow: { id: string; key: string; intent: import("../shared/sales").ConnectedSaleIntent },
    firstAttempt: boolean,
  ): Promise<import("../shared/sales").ConnectedSaleOutcome> {
    pending = workflow;
    try {
      const receipt = await createPosSale({ ...workflow.intent, idempotencyKey: workflow.key });
      return { status: "accepted", workflowId: workflow.id, receipt };
    } catch (error) {
      const classified = classifyForFixture(error);
      if (firstAttempt && !classified.uncertain) {
        pending = null;
        return { status: "rejected", workflowId: workflow.id, error: classified };
      }
      return { status: "ambiguous", workflowId: workflow.id, error: classified };
    }
  }

  return {
    hasPending: async () => pending !== null,
    submit: async (intent) => {
      if (pending) return dispatch(pending, false);
      const key = nextKey();
      return dispatch({ id: `wf-${key}`, key, intent }, true);
    },
    recover: async () => (pending ? dispatch(pending, false) : null),
    acknowledge: async () => {
      pending = null;
    },
  };
}

function offlineEnablementFixture(): OfflineBridge {
  let ready = false;
  return {
    getReadiness: vi.fn(async () =>
      ready
        ? {
            ready: true as const,
            deviceId: "device-1",
            registerId: "register-1",
            inventoryLocationId: "location-1",
            currency: "USD",
            acceptedUntil: "2026-09-08T20:00:00.000Z",
            catalogValidUntil: "2026-09-08T20:00:00.000Z",
          }
        : {
            ready: false as const,
            reason: "DEVICE_NOT_ENROLLED" as const,
            message: "This register has not been enabled for offline sales.",
          },
    ),
    getCachedCatalog: vi.fn(async () => []),
    getProjectedInventory: vi.fn(async () => []),
    acceptCashSale: vi.fn(),
    getLocalReceipt: vi.fn(),
    getUnacknowledgedSales: vi.fn(async () => []),
    acknowledgeSale: vi.fn(),
    getPendingSyncSummary: vi.fn(async () => ({ pending: 0, leased: 0, retryWait: 0, blocked: 0 })),
    getSyncStatus: vi.fn(async () => ({
      pending: 0,
      leased: 0,
      retryWait: 0,
      blocked: 0,
      synced: 0,
      needsReconciliation: 0,
      networkOnline: true,
      synchronizing: false,
      lastAttemptAt: null,
      lastError: null,
    })),
    requestSync: vi.fn(),
    bootstrap: vi.fn(async () => {
      ready = true;
      return {
        deviceId: "device-1",
        registerId: "register-1",
        grantId: "grant-1",
        snapshotId: "snapshot-1",
        acceptedUntil: "2026-09-08T20:00:00.000Z",
        catalogValidUntil: "2026-09-08T20:00:00.000Z",
        catalogItemCount: 1,
        releasedProjectionCount: 0,
      };
    }),
  };
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

  it("uses the real Clerk token and selected register to enable offline selling", async () => {
    const fixture = connectedFixture();
    const offlineBridge = offlineEnablementFixture();
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        offlineBridge={offlineBridge}
      />,
    );
    await screen.findByRole("heading", { name: "Products" });
    fireEvent.click(screen.getByRole("button", { name: "Enable offline selling" }));
    await waitFor(() =>
      expect(offlineBridge.bootstrap).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        registerId: "register-1",
        displayName: "Front register",
        accessToken: "token",
      }),
    );
    expect(await screen.findByText(/Offline selling is ready/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work offline" })).toBeTruthy();
  });

  it("combines cart lines, submits only sale intent, shows receipt, and resets", async () => {
    const fixture = connectedFixture({ keys: ["sale-key-1"] });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        salesGateway={fixture.salesGateway}
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
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Complete sale" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));

    expect(await screen.findByRole("heading", { name: "Order POS-0001" })).toBeTruthy();
    expect(screen.getByText("Cash captured · Fulfilled")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    // Configured business/branch identity is rendered on the receipt from POS context.
    expect(screen.getByText("Dev Store")).toBeTruthy();
    expect(screen.getByText("Dev Store LLC")).toBeTruthy();
    expect(screen.getByText("Tax ID: EG-123456789")).toBeTruthy();
    expect(screen.getByText("Flagship Store")).toBeTruthy();
    expect(screen.getByText("12 Nile Corniche")).toBeTruthy();
    expect(screen.getByText("+20 2 1234 5678")).toBeTruthy();
    expect(screen.getByText("Thank you for shopping with us!")).toBeTruthy();
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
    const fixture = connectedFixture({
      prices: [2599, 2799],
      createPosSale,
      keys: ["stale-key", "confirmed-key"],
    });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        salesGateway={fixture.salesGateway}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Linen Shirt/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "3000" },
    });
    const complete = () => screen.getByRole("button", { name: "Complete sale" });
    await waitFor(() => expect((complete() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(complete());

    const confirm = await screen.findByRole("button", { name: "Confirm updated total" });
    expect(screen.getByText(/server reports/)).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect((complete() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(complete());
    await screen.findByRole("heading", { name: "Order POS-0001" });

    expect(createPosSale.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ idempotencyKey: "stale-key", expectedTotalMinor: 2599 }),
      expect.objectContaining({ idempotencyKey: "confirmed-key", expectedTotalMinor: 2799 }),
    ]);
  });
});

const UNIT = 2599;

function breakdown(
  overrides: Partial<PosQuoteResponse> & { lines?: { quantity: number }[] } = {},
): PosQuoteResponse {
  const { lines, ...rest } = overrides;
  const quantity = lines?.reduce((sum, line) => sum + line.quantity, 0) ?? 1;
  const gross = quantity * UNIT;
  const base: PosQuoteResponse = {
    currency: "USD",
    grossSubtotalMinor: gross,
    discountTotalMinor: 0,
    totalMinor: gross,
    codeStatus: "none",
    promotion: null,
  };
  return { ...base, ...rest };
}

function discountedReceipt(grossLineTotal: number, netTotal: number): CreatePosSaleResponse {
  return {
    ...receipt,
    order: {
      ...receipt.order,
      totalMinor: netTotal,
      lines: [{ ...receipt.order.lines[0], quantity: 1, lineTotalMinor: grossLineTotal }],
    },
    payment: {
      ...receipt.payment,
      amountMinor: netTotal,
      cashReceivedMinor: netTotal,
      changeMinor: 0,
    },
  };
}

function readyOfflineBridge(): OfflineBridge {
  return {
    getReadiness: vi.fn(async () => ({
      ready: true as const,
      deviceId: "device-1",
      registerId: "register-1",
      inventoryLocationId: "location-1",
      currency: "USD",
      acceptedUntil: "2026-09-08T20:00:00.000Z",
      catalogValidUntil: "2026-09-08T20:00:00.000Z",
    })),
    getCachedCatalog: vi.fn(async () => []),
    getProjectedInventory: vi.fn(async () => []),
    acceptCashSale: vi.fn(),
    getLocalReceipt: vi.fn(),
    getUnacknowledgedSales: vi.fn(async () => []),
    acknowledgeSale: vi.fn(),
    getPendingSyncSummary: vi.fn(async () => ({ pending: 0, leased: 0, retryWait: 0, blocked: 0 })),
    getSyncStatus: vi.fn(async () => ({
      pending: 0,
      leased: 0,
      retryWait: 0,
      blocked: 0,
      synced: 0,
      needsReconciliation: 0,
      networkOnline: true,
      synchronizing: false,
      lastAttemptAt: null,
      lastError: null,
    })),
    requestSync: vi.fn(),
    bootstrap: vi.fn(),
  };
}

async function addOneAndReady() {
  fireEvent.click(await screen.findByRole("button", { name: /Linen Shirt/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
}

function completeButton() {
  return screen.getByRole("button", { name: "Complete sale" }) as HTMLButtonElement;
}

describe("connected POS promotions", () => {
  it("applies an automatic promotion, tenders net, and shows the discount on the receipt", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      breakdown({
        lines: body.lines,
        discountTotalMinor: 500,
        totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 500,
        promotion: {
          promotionId: "promo-1",
          name: "Summer Sale",
          benefitType: "percentage",
          activation: "automatic",
          code: null,
          discountTotalMinor: 500,
        },
      }),
    );
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockResolvedValue(discountedReceipt(2599, 2099));
    const fixture = connectedFixture({ posQuote, createPosSale });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        salesGateway={fixture.salesGateway}
      />,
    );
    await addOneAndReady();
    expect(await screen.findByText("Summer Sale")).toBeTruthy();
    expect(screen.getByText(/Automatic promotion/)).toBeTruthy();
    expect(screen.getByText("Promotion discount")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "2099" },
    });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());

    await screen.findByRole("heading", { name: "Order POS-0001" });
    const submitted = createPosSale.mock.calls[0][0];
    expect(submitted).toMatchObject({ expectedTotalMinor: 2099 });
    expect(submitted).not.toHaveProperty("promotionCode");
    // Receipt derives discount from the immutable sale: gross 2599 − net 2099 = 500.
    expect(screen.getByText("Gross subtotal")).toBeTruthy();
    expect(screen.getByText("Promotion discount")).toBeTruthy();
    // The sale response carries no applied-promotion identity, so the quote-derived name/code is
    // never rendered on the receipt — only the canonical discount amount is shown.
    expect(screen.queryByText(/Summer Sale/)).toBeNull();
  });

  it("applies a valid entered code and threads it into the sale request", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      body.promotionCode === "SAVE10"
        ? breakdown({
            lines: body.lines,
            discountTotalMinor: 1000,
            totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 1000,
            codeStatus: "valid",
            promotion: {
              promotionId: "promo-2",
              name: "Ten Off",
              benefitType: "fixed_amount",
              activation: "code",
              code: "SAVE10",
              discountTotalMinor: 1000,
            },
          })
        : breakdown({ lines: body.lines }),
    );
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockResolvedValue(discountedReceipt(2599, 1599));
    const fixture = connectedFixture({ posQuote, createPosSale });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        salesGateway={fixture.salesGateway}
      />,
    );
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Ten Off")).toBeTruthy();
    await waitFor(() =>
      expect(posQuote.mock.calls.some(([body]) => body.promotionCode === "SAVE10")).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "1599" },
    });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await screen.findByRole("heading", { name: "Order POS-0001" });
    expect(createPosSale.mock.calls[0][0]).toMatchObject({
      expectedTotalMinor: 1599,
      promotionCode: "SAVE10",
    });
  });

  it("shows a concise error for an invalid code without blocking the undiscounted sale", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      body.promotionCode
        ? breakdown({ lines: body.lines, codeStatus: "invalid" })
        : breakdown({ lines: body.lines }),
    );
    const fixture = connectedFixture({ posQuote });
    render(<PosApplication auth={fixture.auth} clientFactory={fixture.clientFactory} />);
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "NOPE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/isn.t available/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "3000" },
    });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  it("removes an applied code and requotes to the undiscounted total", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      body.promotionCode === "SAVE10"
        ? breakdown({
            lines: body.lines,
            discountTotalMinor: 1000,
            totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 1000,
            codeStatus: "valid",
            promotion: {
              promotionId: "promo-2",
              name: "Ten Off",
              benefitType: "fixed_amount",
              activation: "code",
              code: "SAVE10",
              discountTotalMinor: 1000,
            },
          })
        : breakdown({ lines: body.lines }),
    );
    const fixture = connectedFixture({ posQuote });
    render(<PosApplication auth={fixture.auth} clientFactory={fixture.clientFactory} />);
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Ten Off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Ten Off")).toBeNull());
    expect(screen.queryByText("Promotion discount")).toBeNull();
    await waitFor(() =>
      expect(posQuote.mock.calls.at(-1)?.[0]).not.toHaveProperty("promotionCode"),
    );
  });

  it("keeps a better automatic promotion applied over a valid entered code", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      breakdown({
        lines: body.lines,
        codeStatus: body.promotionCode ? "valid" : "none",
        discountTotalMinor: 800,
        totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 800,
        promotion: {
          promotionId: "promo-auto",
          name: "Members Twenty",
          benefitType: "percentage",
          activation: "automatic",
          code: null,
          discountTotalMinor: 800,
        },
      }),
    );
    const fixture = connectedFixture({ posQuote });
    render(<PosApplication auth={fixture.auth} clientFactory={fixture.clientFactory} />);
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Members Twenty")).toBeTruthy();
    expect(screen.getByText(/better automatic promotion applied/)).toBeTruthy();
  });

  it("blocks a silent finalize when the promotion changes at the final sale", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      body.promotionCode === "LAST1"
        ? breakdown({
            lines: body.lines,
            discountTotalMinor: 1000,
            totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 1000,
            codeStatus: "valid",
            promotion: {
              promotionId: "promo-voucher",
              name: "Last Voucher",
              benefitType: "fixed_amount",
              activation: "code",
              code: "LAST1",
              discountTotalMinor: 1000,
            },
          })
        : breakdown({ lines: body.lines }),
    );
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockRejectedValueOnce(
        new ApiHttpError("Voucher exhausted", 409, "PROMOTION_UNAVAILABLE", "request-1"),
      )
      .mockResolvedValueOnce(receipt);
    const fixture = connectedFixture({ posQuote, createPosSale, keys: ["stale", "confirmed"] });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        salesGateway={fixture.salesGateway}
      />,
    );
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "LAST1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Last Voucher")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash received in minor units"), {
      target: { value: "3000" },
    });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());

    expect(await screen.findByRole("button", { name: "Confirm updated total" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Order POS-0001" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm updated total" }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await screen.findByRole("heading", { name: "Order POS-0001" });
    expect(createPosSale.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "stale",
      "confirmed",
    ]);
  });

  it("reports that promotions require a connection when the quote cannot be reached", async () => {
    const posQuote = vi
      .fn<TenantCommerceClient["posQuote"]>()
      .mockRejectedValue(new ApiNetworkError("offline"));
    const fixture = connectedFixture({ posQuote });
    render(<PosApplication auth={fixture.auth} clientFactory={fixture.clientFactory} />);
    await addOneAndReady();
    expect(await screen.findByText("Promotions require a connection.")).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });

  it("invalidates connected promotion pricing when switching to offline selling", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(async (body) =>
      body.promotionCode === "SAVE10"
        ? breakdown({
            lines: body.lines,
            discountTotalMinor: 1000,
            totalMinor: body.lines.reduce((s, l) => s + l.quantity * UNIT, 0) - 1000,
            codeStatus: "valid",
            promotion: {
              promotionId: "promo-2",
              name: "Ten Off",
              benefitType: "fixed_amount",
              activation: "code",
              code: "SAVE10",
              discountTotalMinor: 1000,
            },
          })
        : breakdown({ lines: body.lines }),
    );
    const fixture = connectedFixture({ posQuote });
    render(
      <PosApplication
        auth={fixture.auth}
        clientFactory={fixture.clientFactory}
        offlineBridge={readyOfflineBridge()}
      />,
    );
    await addOneAndReady();
    fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Ten Off")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Work offline" }));
    expect(await screen.findByText("Offline cashier")).toBeTruthy();
    expect(screen.queryByText("Ten Off")).toBeNull();
    expect(screen.queryByText("Promotion discount")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use connected" }));
    const codeInput = (await screen.findByLabelText("Promotion code")) as HTMLInputElement;
    expect(codeInput.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
