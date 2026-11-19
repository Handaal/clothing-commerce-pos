// @vitest-environment jsdom

import type { OrderDetailResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import {
  OnlineOrdersPanel,
  orderView,
  remainingByLine,
  type OnlineOrdersClient,
} from "./OnlineOrdersPanel";
import { WebsiteDesk } from "./WebsiteDesk";

afterEach(cleanup);

const BRAND = "11111111-1111-4111-8111-111111111111";
const OPEN = "a1111111-1111-4111-8111-111111111111";
const DONE = "a2222222-2222-4222-8222-222222222222";
const VOID = "a3333333-3333-4333-8333-333333333333";
const VARIANT = "b1111111-1111-4111-8111-111111111111";

function summary(
  id: string,
  orderNumber: string,
  status: "placed" | "cancelled",
  placedAt: string,
) {
  return {
    id,
    orderNumber,
    channel: "online" as const,
    status,
    brandId: BRAND,
    branchId: null,
    currency: "EGP",
    totalMinor: 50000,
    placedAt,
  };
}

function detail(
  id: string,
  orderNumber: string,
  fulfilled: [number, number],
  status: "placed" | "cancelled" = "placed",
): OrderDetailResponse {
  const lineStatus = (done: number, qty: number) =>
    done === 0 ? "unfulfilled" : done === qty ? "fulfilled" : "partially_fulfilled";
  const total = fulfilled[0] + fulfilled[1];
  return {
    header: { ...summary(id, orderNumber, status, "2026-11-18T09:00:00.000Z") },
    lines: [
      {
        lineNumber: 1,
        variantId: VARIANT,
        productName: "Linen Shirt",
        sku: "LS-M",
        quantity: 2,
        unitPriceMinor: 15000,
        lineTotalMinor: 30000,
      },
      {
        lineNumber: 2,
        variantId: VARIANT,
        productName: "Chino",
        sku: "CH-32",
        quantity: 1,
        unitPriceMinor: 20000,
        lineTotalMinor: 20000,
      },
    ],
    cancellation:
      status === "cancelled"
        ? { cancelledAt: "2026-11-18T10:00:00.000Z", reason: "Customer asked" }
        : null,
    fulfillmentProgress: {
      status: total === 0 ? "unfulfilled" : total === 3 ? "fulfilled" : "partially_fulfilled",
      lines: [
        {
          lineNumber: 1,
          variantId: VARIANT,
          orderedQuantity: 2,
          fulfilledQuantity: fulfilled[0],
          status: lineStatus(fulfilled[0], 2),
        },
        {
          lineNumber: 2,
          variantId: VARIANT,
          orderedQuantity: 1,
          fulfilledQuantity: fulfilled[1],
          status: lineStatus(fulfilled[1], 1),
        },
      ],
    },
    commerce: {
      customerId: null,
      customer: { name: "Mona Adel", phone: "+201000000001", email: null },
      delivery: {
        recipientName: "Mona Adel",
        phone: "+201000000001",
        line1: "12 Nile St",
        line2: null,
        city: "Giza",
        region: null,
        postalCode: null,
        countryCode: "EG",
        notes: null,
      },
      payment: {
        method: "cash_on_delivery",
        provider: null,
        status: "pending",
        amountMinor: 50000,
        currency: "EGP",
      },
      reservations: [],
    },
  } as unknown as OrderDetailResponse;
}

function makeClient(overrides: Partial<Record<keyof OnlineOrdersClient, unknown>> = {}) {
  const details = new Map<string, OrderDetailResponse>([
    [OPEN, detail(OPEN, "W-1001", [0, 0])],
    [DONE, detail(DONE, "W-1000", [2, 1])],
    [VOID, detail(VOID, "W-0999", [0, 0], "cancelled")],
  ]);
  const base = {
    listOrders: vi.fn().mockResolvedValue({
      items: [
        summary(OPEN, "W-1001", "placed", "2026-11-18T09:00:00.000Z"),
        summary(DONE, "W-1000", "placed", "2026-11-17T09:00:00.000Z"),
        summary(VOID, "W-0999", "cancelled", "2026-11-16T09:00:00.000Z"),
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    getOrder: vi.fn(async (id: string) => details.get(id)),
    fulfillOrder: vi.fn().mockResolvedValue(detail(OPEN, "W-1001", [2, 1])),
    cancelOrder: vi.fn().mockResolvedValue(detail(OPEN, "W-1001", [0, 0], "cancelled")),
  };
  return { ...base, ...overrides } as typeof base;
}

function wrap(node: React.ReactNode) {
  return render(
    <I18nProvider>
      <ToastProvider>{node}</ToastProvider>
    </I18nProvider>,
  );
}

async function openOrder(id: string) {
  fireEvent.click(await screen.findByTestId(`website-order-open-${id}`));
  const dialog = await screen.findByTestId("website-order-detail");
  await within(dialog).findByText("12 Nile St");
  return dialog;
}

describe("online order helpers", () => {
  it("routes orders into the right queue", () => {
    expect(orderView({ status: "cancelled" }, "fulfilled")).toBe("cancelled");
    expect(orderView({ status: "placed" }, "fulfilled")).toBe("fulfilled");
    expect(orderView({ status: "placed" }, "partially_fulfilled")).toBe("toFulfil");
    expect(orderView({ status: "placed" }, null)).toBe("toFulfil");
  });

  it("computes what is left to ship per line", () => {
    expect([...remainingByLine(detail(OPEN, "W", [1, 1]))]).toEqual([[1, 1]]);
    expect(remainingByLine(detail(OPEN, "W", [2, 1])).size).toBe(0);
  });
});

describe("OnlineOrdersPanel", () => {
  it("lists only online orders and defaults to the to-fulfil queue with customer and city", async () => {
    const client = makeClient();
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    const row = await screen.findByTestId(`website-order-${OPEN}`);
    expect(client.listOrders).toHaveBeenCalledWith({ channel: "online", limit: 100 });
    await within(row).findByText("Mona Adel");
    expect(within(row).getByText("Giza")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId(`website-order-${DONE}`)).toBeNull());
    expect(screen.queryByTestId(`website-order-${VOID}`)).toBeNull();
    // Cancelled orders are complete as listed: no detail fetch for them.
    expect(client.getOrder).not.toHaveBeenCalledWith(VOID);

    fireEvent.click(screen.getByTestId("website-orders-view-fulfilled"));
    expect(await screen.findByTestId(`website-order-${DONE}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("website-orders-view-cancelled"));
    expect(await screen.findByTestId(`website-order-${VOID}`)).toBeTruthy();
  });

  it("searches by phone", async () => {
    wrap(<OnlineOrdersPanel client={makeClient() as never} canFulfill canCancel />);
    const row = await screen.findByTestId(`website-order-${OPEN}`);
    await within(row).findByText("Mona Adel");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nobody" } });
    expect(await screen.findByText("No orders match your search.")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "000001" } });
    expect(await screen.findByTestId(`website-order-${OPEN}`)).toBeTruthy();
  });

  it("offers a WhatsApp confirmation addressed to the customer, in the store's name", async () => {
    wrap(
      <OnlineOrdersPanel
        client={makeClient() as never}
        canFulfill
        canCancel
        storeName="Zee Store"
      />,
    );
    const dialog = await openOrder(OPEN);
    const link = within(dialog).getByTestId("website-order-whatsapp");
    const href = link.getAttribute("href")!;
    expect(href).toMatch(/^https:\/\/wa\.me\/[0-9]+\?text=/u);
    const text = decodeURIComponent(href.split("?text=")[1]!);
    expect(text).toContain("Hi Mona,");
    expect(text).toContain("Zee Store");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("fulfils every remaining item with one idempotency key and moves the order out of the queue", async () => {
    const client = makeClient();
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    const dialog = await openOrder(OPEN);
    expect(within(dialog).getByTestId("website-order-cod").textContent).toContain(
      "Cash on delivery",
    );
    fireEvent.click(within(dialog).getByTestId("website-order-fulfil"));
    fireEvent.click(await screen.findByTestId("website-confirm"));
    await waitFor(() => expect(client.fulfillOrder).toHaveBeenCalledTimes(1));
    const call = client.fulfillOrder.mock.calls[0]![0] as {
      orderId: string;
      idempotencyKey: string;
      lines: unknown;
    };
    expect(call.orderId).toBe(OPEN);
    expect(call.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    expect(call.lines).toEqual([
      { lineNumber: 1, quantity: 2 },
      { lineNumber: 2, quantity: 1 },
    ]);
    expect(await screen.findByText("Order #W-1001 fulfilled")).toBeTruthy();
    expect(within(dialog).queryByTestId("website-order-fulfil")).toBeNull();
    fireEvent.click(within(dialog).getByText("Close"));
    await waitFor(() => expect(screen.queryByTestId(`website-order-${OPEN}`)).toBeNull());
  });

  it("ships a partial quantity and rejects a quantity above what is left", async () => {
    const client = makeClient({
      fulfillOrder: vi.fn().mockResolvedValue(detail(OPEN, "W-1001", [1, 0])),
    });
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    const dialog = await openOrder(OPEN);
    fireEvent.change(within(dialog).getByTestId("website-order-ship-1"), {
      target: { value: "3" },
    });
    expect(within(dialog).getByRole("alert").textContent).toContain("whole number");
    expect((within(dialog).getByTestId("website-order-fulfil") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(within(dialog).getByTestId("website-order-ship-1"), {
      target: { value: "1" },
    });
    fireEvent.change(within(dialog).getByTestId("website-order-ship-2"), {
      target: { value: "0" },
    });
    expect(within(dialog).getByTestId("website-order-fulfil").textContent).toBe("Fulfil 1 items");
    fireEvent.click(within(dialog).getByTestId("website-order-fulfil"));
    fireEvent.click(await screen.findByTestId("website-confirm"));
    await waitFor(() =>
      expect(client.fulfillOrder).toHaveBeenCalledWith(
        expect.objectContaining({ lines: [{ lineNumber: 1, quantity: 1 }] }),
      ),
    );
    expect(await screen.findByText("Order #W-1001 partly shipped")).toBeTruthy();
  });

  it("reuses the same idempotency key when a failed fulfil is retried", async () => {
    const fulfillOrder = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(detail(OPEN, "W-1001", [2, 1]));
    const client = makeClient({ fulfillOrder });
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    await openOrder(OPEN);
    fireEvent.click(screen.getByTestId("website-order-fulfil"));
    fireEvent.click(await screen.findByTestId("website-confirm"));
    await waitFor(() => expect(fulfillOrder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByTestId("website-confirm") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("website-confirm"));
    await waitFor(() => expect(fulfillOrder).toHaveBeenCalledTimes(2));
    expect(fulfillOrder.mock.calls[1]![0].idempotencyKey).toBe(
      fulfillOrder.mock.calls[0]![0].idempotencyKey,
    );
  });

  it("cancels an unshipped order with a reason", async () => {
    const client = makeClient();
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    const dialog = await openOrder(OPEN);
    fireEvent.click(within(dialog).getByTestId("website-order-cancel"));
    fireEvent.change(await screen.findByTestId("website-order-cancel-reason"), {
      target: { value: "Customer changed mind" },
    });
    fireEvent.click(screen.getByTestId("website-confirm"));
    await waitFor(() =>
      expect(client.cancelOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: OPEN, reason: "Customer changed mind" }),
      ),
    );
    expect(await screen.findByText("Order #W-1001 cancelled")).toBeTruthy();
  });

  it("explains a server refusal in plain words", async () => {
    const client = makeClient({
      fulfillOrder: vi
        .fn()
        .mockRejectedValue(new ApiHttpError("x", 409, "INSUFFICIENT_STOCK", null)),
    });
    wrap(<OnlineOrdersPanel client={client as never} canFulfill canCancel />);
    await openOrder(OPEN);
    fireEvent.click(screen.getByTestId("website-order-fulfil"));
    fireEvent.click(await screen.findByTestId("website-confirm"));
    expect(
      await screen.findByText("There isn't enough stock at the order's location to ship this."),
    ).toBeTruthy();
  });

  it("hides fulfil and cancel without the grants", async () => {
    wrap(<OnlineOrdersPanel client={makeClient() as never} canFulfill={false} canCancel={false} />);
    expect(
      await screen.findByText("You can view online orders but not fulfil or cancel them."),
    ).toBeTruthy();
    const dialog = await openOrder(OPEN);
    expect(within(dialog).queryByTestId("website-order-fulfil")).toBeNull();
    expect(within(dialog).queryByTestId("website-order-cancel")).toBeNull();
    expect(within(dialog).getByText(/can't fulfil orders/)).toBeTruthy();
  });
});

describe("WebsiteDesk online orders tab", () => {
  it("shows the Online orders tab when the operator can read orders", async () => {
    const client = {
      ...makeClient(),
      getContext: vi.fn().mockResolvedValue({
        access: {
          catalog: { canRead: false, tenantWide: false, brands: [] },
          orders: {
            canRead: true,
            tenantWide: true,
            brands: [],
            branches: [],
            canFulfill: true,
            canCancel: false,
          },
        },
      }),
    } as unknown as TenantCommerceClient;
    wrap(<WebsiteDesk client={client} />);
    const tabs = await screen.findByRole("navigation", { name: "Website Management" });
    const labels = within(tabs)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["Overview", "Online orders"]);
    fireEvent.click(within(tabs).getByText("Online orders"));
    const dialog = await openOrder(OPEN);
    expect(within(dialog).getByTestId("website-order-fulfil")).toBeTruthy();
    expect(within(dialog).queryByTestId("website-order-cancel")).toBeNull();
  });
});
