import { describe, expect, it } from "vitest";

import type { SellableVariant } from "../catalog/catalog";
import { addVariant, cartTotal, refreshCartPrices, removeLine, updateQuantity } from "./cart";

const variant: SellableVariant = {
  variantId: "variant-1",
  productId: "product-1",
  productName: "Linen Shirt",
  variantName: "Medium",
  sku: "LS-M",
  unitPriceMinor: 2599,
};

describe("in-memory cart", () => {
  it("adds a line and combines the same variant", () => {
    const once = addVariant([], variant);
    const twice = addVariant(once, variant);
    expect(twice).toEqual([
      expect.objectContaining({
        variantId: "variant-1",
        quantity: 2,
        displayedUnitPriceMinor: 2599,
      }),
    ]);
    expect(cartTotal(twice)).toBe(5198);
  });

  it("updates only to positive whole-piece quantities and removes lines", () => {
    const lines = addVariant([], variant);
    expect(updateQuantity(lines, variant.variantId, 3)[0].quantity).toBe(3);
    expect(updateQuantity(lines, variant.variantId, 1.5)[0].quantity).toBe(1);
    expect(updateQuantity(lines, variant.variantId, 0)[0].quantity).toBe(1);
    expect(removeLine(lines, variant.variantId)).toEqual([]);
  });

  it("refreshes displayed prices from the latest catalog", () => {
    const lines = addVariant([], variant);
    const refreshed = refreshCartPrices(lines, [
      { variants: [{ ...variant, unitPriceMinor: 2899 }] },
    ]);
    expect(refreshed[0].displayedUnitPriceMinor).toBe(2899);
  });
});
