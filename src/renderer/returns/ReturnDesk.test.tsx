// @vitest-environment jsdom
import {
  type CommerceClient,
  type OrderDetailResponse,
  type ReturnDetailResponse,
  type ReturnEligibilityResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReturnsBridge, ReturnWorkflow } from "../../shared/returns";
import { ReturnDesk } from "./ReturnDesk";
import { CONNECTION_REQUIRED } from "./commands.mjs";

const order: OrderDetailResponse = {
  header: {
    id: "order-secret",
    orderNumber: "POS-42",
    channel: "pos",
    status: "placed",
    brandId: "brand-secret",
    branchId: "branch-secret",
    currency: "USD",
    totalMinor: 5000,
    placedAt: "2026-09-20T10:00:00Z",
  },
  lines: [
    {
      lineNumber: 1,
      variantId: "variant-secret",
      productName: "Linen shirt",
      sku: "SHIRT-M",
      quantity: 2,
      unitPriceMinor: 2500,
      lineTotalMinor: 5000,
    },
  ],
  cancellation: null,
  fulfillmentProgress: { status: "fulfilled", lines: [] },
};
const eligibility: ReturnEligibilityResponse = {
  orderId: order.header.id,
  currency: "USD",
  eligible: true,
  reason: null,
  maxRefundableMinor: 5000,
  policy: {
    allowedReasons: null,
    manualRefundsEnabled: true,
    maxManualRefundMinor: null,
    windowDays: 30,
  },
  lines: [
    {
      orderLineId: "line-secret",
      lineNumber: 1,
      variantId: "variant-secret",
      purchasedQuantity: 2,
      fulfilledQuantity: 2,
      returnedQuantity: 0,
      eligibleQuantity: 2,
      unitPriceMinor: 2500,
    },
  ],
};
const result: ReturnDetailResponse = {
  id: "return-secret",
  orderId: order.header.id,
  channel: "pos",
  source: "pos",
  actorMembershipId: "actor-secret",
  status: "accepted",
  currency: "USD",
  amountMinor: 2500,
  inventoryLocationId: null,
  inventoryOperationId: null,
  createdAt: "2026-09-20T12:00:00Z",
  lines: [
    {
      orderLineId: "line-secret",
      lineNumber: 1,
      variantId: "variant-secret",
      quantity: 1,
      reason: "Size did not fit",
      disposition: "non_restock",
      amountMinor: 2500,
    },
  ],
  refund: {
    id: "refund-secret",
    returnId: "return-secret",
    paymentId: "payment-secret",
    method: "cash",
    status: "pending",
    amountMinor: 2500,
    currency: "USD",
    settlementReference: null,
    settledAt: null,
  },
};
const register = {
  registerId: "register-secret",
  registerName: "Front",
  branchId: "branch-secret",
  branchName: "Main",
  defaultInventoryLocationId: "location-secret",
  defaultInventoryLocationName: "Sellable floor",
  sellingCurrency: "USD",
  canSell: true as const,
  branch: {
    displayName: "Main",
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    countryCode: null,
    contactEmail: null,
    contactPhone: null,
    receiptFooter: null,
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture(eligible = eligibility, returned = result) {
  const createReturn = vi.fn(async () => returned);
  const settleRefund = vi.fn(async () => ({
    ...returned,
    refund: { ...returned.refund, status: "succeeded" as const },
  }));
  const client = {
    listOrders: vi.fn(async () => ({
      items: [order.header],
      pageInfo: { hasMore: false, nextCursor: null },
    })),
    getOrder: vi.fn(async () => order),
    getReturnEligibility: vi.fn(async () => eligible),
    listReturns: vi.fn(async () => ({ items: [], pageInfo: { hasMore: false, nextCursor: null } })),
    createReturn,
    settleRefund,
    getReturn: vi.fn(async () => returned),
  } as unknown as TenantCommerceClient;
  const health = vi.fn(async () => ({})) as unknown as CommerceClient["getHealth"];
  let workflow: ReturnWorkflow | null = null;
  let saved: Parameters<TenantCommerceClient["createReturn"]>[0];
  const bridge: ReturnsBridge = {
    hasPending: async () => workflow !== null,
    inspect: async () => ({ workflow }),
    start: async (_session, intent) => {
      saved = { ...intent, idempotencyKey: "main-owned-key" };
      workflow = {
        id: "workflow",
        orderId: order.header.id,
        orderReference: "POS-42",
        stage: "prepared",
        createdAt: result.createdAt,
        result: null,
        outcome: null,
      };
      try {
        const value = await client.createReturn(saved);
        workflow = { ...workflow, stage: "return_acknowledged", result: value };
        return { workflow };
      } catch {
        return {
          workflow,
          error: { code: "UNKNOWN", message: "Recover saved return", uncertain: true },
        };
      }
    },
    recover: async () => {
      const value = await client.createReturn(saved);
      workflow = { ...workflow!, stage: "return_acknowledged", result: value };
      return { workflow };
    },
    settle: async (_session, id, reference) => {
      const value = await client.settleRefund({
        returnId: id,
        settlementReference: reference,
        idempotencyKey: "settlement-key",
      });
      workflow = { ...workflow!, stage: "completed", result: value, outcome: "acknowledged" };
      return { workflow };
    },
    finish: async () => {
      workflow = { ...workflow!, stage: "completed" };
      return { workflow };
    },
  };
  render(
    <ReturnDesk
      client={client}
      health={health}
      register={register}
      onLocked={vi.fn()}
      bridge={bridge}
      getToken={async () => "test-session"}
    />,
  );
  return { client, createReturn, settleRefund };
}
async function selectLine() {
  await waitFor(() =>
    expect(
      (screen.getByText("Load connected orders").closest("fieldset") as HTMLFieldSetElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByText("Load connected orders"));
  fireEvent.click(await screen.findByText(/Order POS-42 ·/));
  const checkbox = await screen.findByLabelText("Linen shirt · SHIRT-M");
  await waitFor(() =>
    expect((checkbox.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false),
  );
  fireEvent.click(checkbox);
}
// The reason control is the themed Select (a button + listbox) when the policy supplies reasons, and a
// free-text input otherwise; pick the value whichever it is.
async function chooseReason(reason: string) {
  const control = screen.getByLabelText("Reason for line 1");
  if (control.tagName === "BUTTON") {
    fireEvent.click(control);
    fireEvent.mouseDown(await screen.findByRole("option", { name: reason }));
  } else {
    fireEvent.change(control, { target: { value: reason } });
  }
}
async function review() {
  await chooseReason("Size did not fit");
  fireEvent.click(screen.getByText("Review return"));
}

describe("connected return cashier", () => {
  it("shows server eligibility, limits quantities, submits no amount and settles only after cash attestation", async () => {
    const { createReturn, settleRefund } = fixture();
    await selectLine();
    expect(
      screen.getByText(/Purchased: 2 · Previously returned: 0 · Remaining eligible: 2/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "3" } });
    await review();
    expect((screen.getByText("Review return") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("Disposition for line 1"));
    fireEvent.mouseDown(
      screen.getByRole("option", { name: /returns units to sellable inventory/ }),
    );
    fireEvent.click(screen.getByText("Review return"));
    fireEvent.click(screen.getByText("Confirm return"));
    await screen.findByText(/Refund:.*pending/);
    expect(createReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryLocationId: "location-secret",
        refundMode: "pending",
        lines: [
          {
            orderLineId: "line-secret",
            quantity: 1,
            disposition: "restock",
            reason: "Size did not fit",
          },
        ],
      }),
    );
    expect(JSON.stringify(createReturn.mock.calls)).not.toMatch(/amountMinor|expectedTotal/);
    expect(
      (screen.getByText("Record cash refund", { selector: "button" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Settlement reference"), {
      target: { value: "Till log 42" },
    });
    fireEvent.click(screen.getByLabelText("I have handed back the displayed cash amount."));
    fireEvent.click(screen.getByText("Record cash refund", { selector: "button" }));
    await screen.findByText(/Refund:.*succeeded/);
    expect(settleRefund).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("-secret");
  });
  it("uses policy reasons and forbids electronic settlement", async () => {
    fixture(
      {
        ...eligibility,
        policy: { ...eligibility.policy, allowedReasons: ["Size did not fit", "Damaged"] },
      },
      { ...result, refund: { ...result.refund, method: "electronic" } },
    );
    await selectLine();
    const reasonControl = screen.getByLabelText("Reason for line 1");
    expect(reasonControl.tagName).toBe("BUTTON");
    expect(reasonControl.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(reasonControl);
    expect(screen.getByRole("option", { name: "Size did not fit" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Damaged" })).toBeTruthy();
    fireEvent.keyDown(reasonControl, { key: "Escape" });
    await review();
    fireEvent.click(screen.getByText("Confirm return"));
    await screen.findByText(/Electronic refunds await provider processing/);
    expect(screen.queryByText("Record cash refund")).toBeNull();
  });
  it("disables submission on disconnect and sends nothing", async () => {
    const { createReturn } = fixture();
    await selectLine();
    await review();
    fireEvent(window, new Event("offline"));
    expect(screen.getByText(CONNECTION_REQUIRED)).toBeTruthy();
    expect((screen.getByText("Confirm return") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Confirm return"));
    expect(createReturn).not.toHaveBeenCalled();
  });
  it("locks an unknown result and retries the exact command after reconnecting", async () => {
    const { client } = fixture();
    const create = vi
      .spyOn(client, "createReturn")
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(result);
    await selectLine();
    await review();
    fireEvent.click(screen.getByText("Confirm return"));
    await screen.findByText("Recover saved return/refund");
    expect((screen.getByText("Edit return") as HTMLButtonElement).disabled).toBe(true);
    fireEvent(window, new Event("online"));
    await waitFor(() =>
      expect((screen.getByText("Recover saved return/refund") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByText("Recover saved return/refund"));
    await screen.findByText(/Refund:.*pending/);
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });
});
