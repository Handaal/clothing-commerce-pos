import {
  ApiHttpError,
  ApiNetworkError,
  type CreatePosSaleResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import { SaleExecutor, type SaleIntent } from "./sale-executor";

const receipt = { saleStatus: "completed" } as CreatePosSaleResponse;
const intent: SaleIntent = {
  registerId: "register-1",
  expectedTotalMinor: 2599,
  cashReceivedMinor: 3000,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

function tenantClient(createPosSale: TenantCommerceClient["createPosSale"]): TenantCommerceClient {
  return { createPosSale } as TenantCommerceClient;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sale idempotency lifecycle", () => {
  it("submits the narrow sale intent once and blocks duplicate taps", async () => {
    let resolveSale: (value: CreatePosSaleResponse) => void = () => undefined;
    const createPosSale = vi.fn<TenantCommerceClient["createPosSale"]>(
      () => new Promise<CreatePosSaleResponse>((resolve) => (resolveSale = resolve)),
    );
    const executor = new SaleExecutor(() => "key-1");
    expect(executor.submit(tenantClient(createPosSale), intent)).toBe(true);
    expect(executor.submit(tenantClient(createPosSale), intent)).toBe(false);
    expect(createPosSale).toHaveBeenCalledTimes(1);
    expect(createPosSale).toHaveBeenCalledWith({ ...intent, idempotencyKey: "key-1" });
    expect(createPosSale.mock.calls[0][0]).not.toHaveProperty("unitPriceMinor");
    expect(createPosSale.mock.calls[0][0]).not.toHaveProperty("branchId");
    expect(createPosSale.mock.calls[0][0]).not.toHaveProperty("inventoryLocationId");
    expect(createPosSale.mock.calls[0][0]).not.toHaveProperty("currency");
    resolveSale(receipt);
    await settle();
    expect(executor.snapshot()).toEqual({ phase: "success", receipt });
  });

  it("retries an ambiguous failure with the same arguments and key", async () => {
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockRejectedValueOnce(new ApiNetworkError("connection lost"))
      .mockResolvedValueOnce(receipt);
    const executor = new SaleExecutor(() => "stable-key");
    executor.submit(tenantClient(createPosSale), intent);
    await settle();
    expect(executor.snapshot().phase).toBe("ambiguous");
    expect(executor.retry(tenantClient(createPosSale))).toBe(true);
    await settle();
    expect(createPosSale).toHaveBeenCalledTimes(2);
    expect(createPosSale.mock.calls[1][0]).toEqual(createPosSale.mock.calls[0][0]);
  });

  it("mints a new key after cart or cash intent changes", async () => {
    const keys = ["key-1", "key-2", "key-3"];
    const createPosSale = vi.fn<TenantCommerceClient["createPosSale"]>().mockResolvedValue(receipt);
    const executor = new SaleExecutor(() => keys.shift() ?? "unexpected");

    executor.submit(tenantClient(createPosSale), intent);
    await settle();
    executor.invalidate();
    executor.submit(tenantClient(createPosSale), {
      ...intent,
      lines: [{ variantId: "variant-1", quantity: 2 }],
    });
    await settle();
    executor.invalidate();
    executor.submit(tenantClient(createPosSale), { ...intent, cashReceivedMinor: 4000 });
    await settle();

    expect(createPosSale.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "key-1",
      "key-2",
      "key-3",
    ]);
  });

  it("requires a new operation after PRICE_CHANGED and exposes the authoritative total", async () => {
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockRejectedValueOnce(
        new ApiHttpError("Price changed", 409, "PRICE_CHANGED", "request-1", [
          { path: ["expectedTotalMinor"], message: "Refresh", value: 2799 },
        ]),
      )
      .mockResolvedValueOnce(receipt);
    const keys = ["stale-key", "confirmed-key"];
    const executor = new SaleExecutor(() => keys.shift() ?? "unexpected");
    executor.submit(tenantClient(createPosSale), intent);
    await settle();
    expect(executor.snapshot()).toMatchObject({
      phase: "price-changed",
      authoritativeTotalMinor: 2799,
    });
    expect(executor.retry(tenantClient(createPosSale))).toBe(false);
    executor.invalidate();
    executor.submit(tenantClient(createPosSale), { ...intent, expectedTotalMinor: 2799 });
    await settle();
    expect(createPosSale.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "stale-key",
      "confirmed-key",
    ]);
  });

  it.each([
    [401, "UNAUTHENTICATED", "auth"],
    [403, "PERMISSION_DENIED", "forbidden"],
    [400, "INSUFFICIENT_CASH", "validation"],
    [409, "INSUFFICIENT_STOCK", "inventory"],
    [409, "IDEMPOTENCY_CONFLICT", "conflict"],
    [500, "INTERNAL_ERROR", "server"],
  ] as const)("classifies %s %s without ambiguous retry", async (status, code, kind) => {
    const createPosSale = vi
      .fn<TenantCommerceClient["createPosSale"]>()
      .mockRejectedValue(new ApiHttpError(code, status, code, "request-1"));
    const executor = new SaleExecutor(() => "key");
    executor.submit(tenantClient(createPosSale), intent);
    await settle();
    expect(executor.snapshot()).toMatchObject({ phase: "error", error: { kind, code } });
    expect(executor.retry(tenantClient(createPosSale))).toBe(false);
  });
});
