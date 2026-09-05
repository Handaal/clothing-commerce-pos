import type { ProductDetailResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

export interface SellableVariant {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  unitPriceMinor: number;
}

export interface SellableProduct {
  productId: string;
  productName: string;
  styleCode: string | null;
  variants: readonly SellableVariant[];
}

function sellableProduct(detail: ProductDetailResponse, currency: string): SellableProduct | null {
  if (detail.product.status !== "active") return null;
  const prices = new Map(
    detail.prices
      .filter((price) => price.currency === currency)
      .map((price) => [price.variantId, price.amountMinor]),
  );
  const variants = detail.variants.flatMap<SellableVariant>((variant) => {
    const unitPriceMinor = prices.get(variant.id);
    if (variant.status !== "active" || unitPriceMinor === undefined) return [];
    return [
      {
        variantId: variant.id,
        productId: detail.product.id,
        productName: detail.product.name,
        variantName: variant.displayName,
        sku: variant.sku,
        unitPriceMinor,
      },
    ];
  });
  return {
    productId: detail.product.id,
    productName: detail.product.name,
    styleCode: detail.product.styleCode,
    variants,
  };
}

export async function loadSellableCatalog(
  client: TenantCommerceClient,
  currency: string,
): Promise<readonly SellableProduct[]> {
  const productIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await client.listProducts({
      status: "active",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    productIds.push(
      ...response.items.filter((item) => item.status === "active").map((item) => item.id),
    );
    if (!response.pageInfo.hasMore || !response.pageInfo.nextCursor) break;
    cursor = response.pageInfo.nextCursor;
    if (page === 19) throw new Error("The product catalog exceeded the safe pagination limit.");
  }
  const details = await Promise.all(productIds.map((productId) => client.getProduct(productId)));
  return details.flatMap((detail) => {
    const product = sellableProduct(detail, currency);
    return product && product.variants.length > 0 ? [product] : [];
  });
}
