import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import { loadSellableCatalog } from "./catalog";

describe("sellable catalog", () => {
  it("loads active products and only active variants priced in the register currency", async () => {
    const client = {
      listProducts: vi.fn(async () => ({
        items: [
          {
            id: "product-1",
            name: "Shirt",
            styleCode: "SH-1",
            status: "active",
            brandId: "brand-1",
          },
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      })),
      getProduct: vi.fn(async () => ({
        product: {
          id: "product-1",
          name: "Shirt",
          styleCode: "SH-1",
          status: "active",
          brandId: "brand-1",
        },
        variants: [
          { id: "active", sku: "SH-M", displayName: "Medium", status: "active" },
          { id: "draft", sku: "SH-L", displayName: "Large", status: "draft" },
        ],
        options: [{ id: "option-1", name: "Size", values: [{ id: "value-1", value: "M" }] }],
        prices: [
          { variantId: "active", currency: "USD", amountMinor: 2599 },
          { variantId: "active", currency: "EUR", amountMinor: 2399 },
          { variantId: "draft", currency: "USD", amountMinor: 2599 },
        ],
      })),
    } as unknown as TenantCommerceClient;

    await expect(loadSellableCatalog(client, "USD")).resolves.toEqual([
      expect.objectContaining({
        productName: "Shirt",
        variants: [expect.objectContaining({ sku: "SH-M", unitPriceMinor: 2599 })],
      }),
    ]);
    expect(client.listProducts).toHaveBeenCalledWith({ status: "active", limit: 100 });
  });
});
