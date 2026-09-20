// @vitest-environment jsdom
import {
  ApiHttpError,
  type CommerceClient,
  type OrderDetailResponse,
  type ReturnDetailResponse,
  type ReturnEligibilityResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReturnDesk } from "./ReturnDesk";
import { CONNECTION_REQUIRED, ReturnCommands, type ReturnIntent } from "./commands.mjs";

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
const intent: ReturnIntent = {
  orderId: order.header.id,
  lines: [
    {
      orderLineId: "line-secret",
      quantity: 1,
      reason: "Size did not fit",
      disposition: "non_restock",
    },
  ],
  inventoryLocationId: null,
  refundMode: "pending",
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
  render(<ReturnDesk client={client} health={health} register={register} onLocked={vi.fn()} />);
  return { client, createReturn, settleRefund };
}
async function selectLine() {
  await waitFor(() =>
    expect((screen.getByText("Load connected orders") as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("Load connected orders"));
  fireEvent.click(await screen.findByText(/Order POS-42 ·/));
  const checkbox = await screen.findByLabelText("Linen shirt · SHIRT-M");
  await waitFor(() =>
    expect((checkbox.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false),
  );
  fireEvent.click(checkbox);
}
async function review() {
  fireEvent.change(screen.getByLabelText("Reason for line 1"), {
    target: { value: "Size did not fit" },
  });
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
    fireEvent.change(screen.getByLabelText("Disposition for line 1"), {
      target: { value: "restock" },
    });
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
    expect(screen.getByLabelText("Reason for line 1").tagName).toBe("SELECT");
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
    await screen.findByText("Retry exact return");
    expect((screen.getByText("Edit return") as HTMLButtonElement).disabled).toBe(true);
    fireEvent(window, new Event("online"));
    await waitFor(() =>
      expect((screen.getByText("Retry exact return") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Retry exact return"));
    await screen.findByText(/Refund:.*pending/);
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });
});
describe("return command idempotency", () => {
  it("gives a separately started identical partial return its own key", async () => {
    const createReturn = vi.fn().mockResolvedValue(result);
    const client = { createReturn } as unknown as TenantCommerceClient;
    const commands = new ReturnCommands();
    await commands.create(client, intent, true);
    commands.newReturnIntent();
    await commands.create(client, intent, true);
    expect(createReturn.mock.calls[0][0].idempotencyKey).not.toBe(
      createReturn.mock.calls[1][0].idempotencyKey,
    );
  });
  it("retains exact requests across lost/500 responses, deduplicates double clicks, and changes keys with intent", async () => {
    const createReturn = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue(result);
    const client = { createReturn } as unknown as TenantCommerceClient;
    const keys = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const commands = new ReturnCommands(keys);
    const first = commands.create(client, intent, true);
    expect(commands.create(client, intent, true)).toBe(first);
    await expect(first).rejects.toThrow("lost");
    await commands.create(client, intent, true);
    expect(createReturn.mock.calls[0][0]).toEqual(createReturn.mock.calls[1][0]);
    await commands.create(
      client,
      { ...intent, lines: [{ ...intent.lines[0], reason: "Damaged" }] },
      true,
    );
    expect(createReturn.mock.calls[2][0].idempotencyKey).toBe("second");
  });
  it("never invokes canonical commands while offline", async () => {
    const client = {
      createReturn: vi.fn(),
      settleRefund: vi.fn(),
    } as unknown as TenantCommerceClient;
    const commands = new ReturnCommands();
    await expect(commands.create(client, intent, false)).rejects.toThrow(CONNECTION_REQUIRED);
    await expect(commands.settle(client, "return", "cash", false)).rejects.toThrow(
      CONNECTION_REQUIRED,
    );
    expect(client.createReturn).not.toHaveBeenCalled();
    expect(client.settleRefund).not.toHaveBeenCalled();
  });
  it("retains settlement key/evidence on exact retry", async () => {
    const settleRefund = vi
      .fn()
      .mockRejectedValueOnce(new ApiHttpError("Unavailable", 503, "UNAVAILABLE", "test"))
      .mockResolvedValue(result);
    const client = { settleRefund } as unknown as TenantCommerceClient;
    const commands = new ReturnCommands();
    await expect(commands.settle(client, result.id, "Cash given", true)).rejects.toBeTruthy();
    await commands.settle(client, result.id, "Cash given", true);
    expect(settleRefund.mock.calls[0][0]).toEqual(settleRefund.mock.calls[1][0]);
  });
});
