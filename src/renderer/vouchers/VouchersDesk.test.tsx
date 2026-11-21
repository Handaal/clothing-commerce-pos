// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { VouchersDesk } from "./VouchersDesk";

afterEach(cleanup);

const voucher = (id: string, code: string, status: "active" | "inactive") => ({
  id,
  activationType: "code",
  status,
  codes: [{ id: `${id}-code`, code, status: "active" }],
  benefitType: "percentage",
  benefitPercentBp: 1000,
  benefitAmountMinor: null,
  benefitCurrency: null,
  minSubtotalMinor: null,
  globalRedemptionLimit: null,
  redemptionCount: 0,
  remainingRedemptions: null,
  startsAt: "2026-11-01T00:00:00.000Z",
  endsAt: null,
  channel: null,
  economicsLocked: false,
});

function setup() {
  let items = [
    voucher("p-active", "SUMMER10", "active"),
    voucher("p-inactive", "OLD5", "inactive"),
  ];
  const deletePromotion = vi.fn(async (id: string) => {
    items = items.filter((item) => item.id !== id);
    return { promotionId: id, outcome: "deleted" as const };
  });
  const client = {
    listPromotions: vi.fn(async () => ({
      items: items.map(({ id }) => ({ id, activationType: "code" })),
    })),
    getPromotion: vi.fn(async (id: string) => items.find((item) => item.id === id)),
    deletePromotion,
  } as unknown as TenantCommerceClient;
  render(
    <I18nProvider>
      <ToastProvider>
        <VouchersDesk client={client} currency="EGP" />
      </ToastProvider>
    </I18nProvider>,
  );
  return { deletePromotion };
}

const card = async (code: string) =>
  (await screen.findByText(code)).closest("article") as HTMLElement;

describe("VouchersDesk delete", () => {
  it("offers Delete only on inactive vouchers and deletes after confirmation", async () => {
    const { deletePromotion } = setup();
    expect(within(await card("SUMMER10")).queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.click(within(await card("OLD5")).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete voucher OLD5?");
    expect(deletePromotion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletePromotion).toHaveBeenCalledWith("p-inactive"));
    await waitFor(() => expect(screen.queryByText("OLD5")).toBeNull());
    expect(screen.getByText("SUMMER10")).toBeTruthy();
  });

  it("cancelling the confirmation deletes nothing", async () => {
    const { deletePromotion } = setup();
    fireEvent.click(within(await card("OLD5")).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deletePromotion).not.toHaveBeenCalled();
  });

  it("voucher details no longer show the technical API note", async () => {
    setup();
    fireEvent.click(within(await card("OLD5")).getByRole("button", { name: "Details" }));
    expect(screen.getByRole("dialog").textContent).not.toMatch(
      /promotions API|redemption history/i,
    );
  });
});
