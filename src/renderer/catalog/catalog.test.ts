import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import { classifyProduct, loadSellableCatalog } from "./catalog";

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

describe("classifyProduct", () => {
  const product = { id: "p1", brandId: "b1" } as never;
  const base = () => ({
    brands: new Map([["b1", "Zee Store"]]),
    vendors: new Map([["v1", "Zara"]]),
    categories: new Map<string, { name: string; parentId: string | null }>([
      ["men", { name: "Men", parentId: null }],
      ["tees", { name: "T-Shirts", parentId: "men" }],
    ]),
    collectionsByProduct: new Map([["p1", ["Summer edit"]]]),
  });

  it("groups by the most specific category and labels by vendor", () => {
    expect(
      classifyProduct({ product, categoryIds: ["men", "tees"], vendorId: "v1" }, base()),
    ).toEqual({ brandName: "Zara", categories: ["T-Shirts"] });
  });

  it("falls back to collections and the tenant brand when those aren't set up", () => {
    const classifier = { ...base(), categories: new Map(), vendors: new Map() };
    expect(classifyProduct({ product, categoryIds: [], vendorId: null }, classifier)).toEqual({
      brandName: "Zee Store",
      categories: ["Summer edit"],
    });
  });
});
