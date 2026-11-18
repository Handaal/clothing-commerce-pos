// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../shell/i18n";
import { OrdersDesk } from "./OrdersDesk";

const makeOrder = (
  id: string,
  number: string,
  channel: "pos" | "online",
  status: "placed" | "cancelled",
) => ({
  id,
  orderNumber: number,
  channel,
  status,
  brandId: "11111111-1111-4111-8111-111111111111",
  branchId: null,
  currency: "EGP",
  totalMinor: 10000,
  placedAt: "2026-11-13T12:00:00.000Z",
});

describe("OrdersDesk channel filter", () => {
  it("shows only placed online orders with work left in the fulfillment view", async () => {
    const orders = [
      makeOrder("11111111-1111-4111-8111-111111111101", "POS-1", "pos", "placed"),
      makeOrder("11111111-1111-4111-8111-111111111102", "WEB-1", "online", "placed"),
      makeOrder("11111111-1111-4111-8111-111111111103", "WEB-2", "online", "placed"),
      makeOrder("11111111-1111-4111-8111-111111111104", "WEB-3", "online", "cancelled"),
    ];
    const listOrders = vi.fn(async ({ channel }: { channel?: string } = {}) => ({
      items: orders.filter((item) => !channel || item.channel === channel),
      pageInfo: { hasMore: false, nextCursor: null },
    }));
    const getOrder = vi.fn(async (id: string) => ({
      fulfillmentProgress: { status: id.endsWith("102") ? "unfulfilled" : "fulfilled" },
    }));
    const client = { listOrders, getOrder } as unknown as TenantCommerceClient;
    render(
      <I18nProvider>
        <OrdersDesk client={client} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fulfillment" } });
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/WEB-1/)).toBeTruthy();
    expect(screen.queryByText(/WEB-2/)).toBeNull();
    expect(screen.queryByText(/WEB-3/)).toBeNull();
    expect(screen.queryByText(/POS-1/)).toBeNull();
    expect(listOrders).toHaveBeenCalledWith(expect.objectContaining({ channel: "online" }));
  });
});
