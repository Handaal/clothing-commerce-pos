// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("offers All / POS / Online only (fulfillment lives in Website Management) and filters by channel", async () => {
    const orders = [
      makeOrder("11111111-1111-4111-8111-111111111101", "POS-1", "pos", "placed"),
      makeOrder("11111111-1111-4111-8111-111111111102", "WEB-1", "online", "placed"),
      makeOrder("11111111-1111-4111-8111-111111111103", "WEB-2", "online", "cancelled"),
    ];
    const listOrders = vi.fn(async ({ channel }: { channel?: string } = {}) => ({
      items: orders.filter((item) => !channel || item.channel === channel),
      pageInfo: { hasMore: false, nextCursor: null },
    }));
    const getOrder = vi.fn();
    const client = { listOrders, getOrder } as unknown as TenantCommerceClient;
    render(
      <I18nProvider>
        <OrdersDesk client={client} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /fulfil/i })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Online" }));
    expect(await screen.findByText(/WEB-1/)).toBeTruthy();
    expect(screen.getByText(/WEB-2/)).toBeTruthy();
    expect(screen.queryByText(/POS-1/)).toBeNull();
    expect(listOrders).toHaveBeenCalledWith(expect.objectContaining({ channel: "online" }));
    expect(getOrder).not.toHaveBeenCalled();
  });
});
