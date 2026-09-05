import type { SellableVariant } from "../catalog/catalog";

export interface CartLine {
  variantId: string;
  label: string;
  sku: string;
  quantity: number;
  displayedUnitPriceMinor: number;
}

export function addVariant(lines: readonly CartLine[], variant: SellableVariant): CartLine[] {
  const existing = lines.find((line) => line.variantId === variant.variantId);
  if (existing) {
    return lines.map((line) =>
      line.variantId === variant.variantId ? { ...line, quantity: line.quantity + 1 } : line,
    );
  }
  return [
    ...lines,
    {
      variantId: variant.variantId,
      label: `${variant.productName} — ${variant.variantName ?? variant.sku}`,
      sku: variant.sku,
      quantity: 1,
      displayedUnitPriceMinor: variant.unitPriceMinor,
    },
  ];
}

export function updateQuantity(
  lines: readonly CartLine[],
  variantId: string,
  quantity: number,
): CartLine[] {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return [...lines];
  return lines.map((line) => (line.variantId === variantId ? { ...line, quantity } : line));
}

export function removeLine(lines: readonly CartLine[], variantId: string): CartLine[] {
  return lines.filter((line) => line.variantId !== variantId);
}

export function cartTotal(lines: readonly CartLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.displayedUnitPriceMinor, 0);
}

export function refreshCartPrices(
  lines: readonly CartLine[],
  products: readonly { variants: readonly SellableVariant[] }[],
): CartLine[] {
  const prices = new Map(
    products.flatMap((product) =>
      product.variants.map((variant) => [variant.variantId, variant.unitPriceMinor] as const),
    ),
  );
  return lines.flatMap((line) => {
    const price = prices.get(line.variantId);
    return price === undefined ? [] : [{ ...line, displayedUnitPriceMinor: price }];
  });
}
