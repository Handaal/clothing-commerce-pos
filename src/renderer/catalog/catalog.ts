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
  // Classification for POS grouping/search. A retail floor browses by category and searches by brand
  // (Zara, Bershka, …), so both travel with the sellable product. `categories` may be empty.
  brandId: string;
  brandName: string | null;
  categories: readonly string[];
  variants: readonly SellableVariant[];
}

interface Classification {
  readonly brandName: string | null;
  readonly categories: readonly string[];
}

export interface CatalogGroup {
  readonly category: string;
  readonly products: readonly SellableProduct[];
}

// Group sellable products by category for the register's category-first layout. A product that belongs
// to several collections is listed under each; products with no category fall into a single trailing
// group labelled by `uncategorizedLabel`. Named groups sort alphabetically; the uncategorized group is
// always last. When nothing is categorized the result is a single uncategorized group (a flat list).
export function groupByCategory(
  products: readonly SellableProduct[],
  uncategorizedLabel: string,
): readonly CatalogGroup[] {
  const byCategory = new Map<string, SellableProduct[]>();
  const uncategorized: SellableProduct[] = [];
  for (const product of products) {
    if (product.categories.length === 0) {
      uncategorized.push(product);
      continue;
    }
    for (const category of product.categories) {
      const bucket = byCategory.get(category);
      if (bucket) bucket.push(product);
      else byCategory.set(category, [product]);
    }
  }
  const groups: CatalogGroup[] = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({ category, products: items }));
  if (uncategorized.length > 0)
    groups.push({ category: uncategorizedLabel, products: uncategorized });
  return groups;
}

function sellableProduct(
  detail: ProductDetailResponse,
  currency: string,
  classify: (detail: ProductDetailResponse) => Classification,
): SellableProduct | null {
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
  const { brandName, categories } = classify(detail);
  return {
    productId: detail.product.id,
    productName: detail.product.name,
    styleCode: detail.product.styleCode,
    brandId: detail.product.brandId,
    brandName,
    categories,
    variants,
  };
}

// Build the two classification lookups the register needs: brandId -> display name, and
// productId -> category (collection) names. Both are small tenant-wide reads; failures degrade
// gracefully to empty maps so a missing brand/collection never blocks selling.
async function loadClassification(client: TenantCommerceClient): Promise<{
  brands: Map<string, string>;
  categoriesByProduct: Map<string, string[]>;
}> {
  const brands = new Map<string, string>();
  const categoriesByProduct = new Map<string, string[]>();
  // Wrap each call in Promise.resolve().then(...) so even a synchronous throw (e.g. a client stub
  // without these methods) becomes a caught rejection and degrades to empty classification.
  await Promise.all([
    Promise.resolve()
      .then(() => client.listBrands({ status: "active", limit: 100 }))
      .then((response) => {
        for (const brand of response.items) brands.set(brand.id, brand.displayName);
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => client.listCollections())
      .then(async (response) => {
        const visible = response.collections.filter((c) => c.status !== "archived");
        const details = await Promise.all(visible.map((c) => client.getCollection(c.id)));
        visible.forEach((collection, index) => {
          for (const productId of details[index].productIds) {
            categoriesByProduct.set(productId, [
              ...(categoriesByProduct.get(productId) ?? []),
              collection.name,
            ]);
          }
        });
      })
      // Categories degrade gracefully to "uncategorized", but log so a silent collections/getCollection
      // failure (permission, contract drift) is diagnosable rather than invisibly hiding every category.
      .catch((error) => console.error("[catalog] category classification failed", error)),
  ]);
  return { brands, categoriesByProduct };
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
  const [details, classification] = await Promise.all([
    Promise.all(productIds.map((productId) => client.getProduct(productId))),
    loadClassification(client),
  ]);
  const classify = (detail: ProductDetailResponse): Classification => ({
    brandName: classification.brands.get(detail.product.brandId) ?? null,
    categories: classification.categoriesByProduct.get(detail.product.id) ?? [],
  });
  return details.flatMap((detail) => {
    const product = sellableProduct(detail, currency, classify);
    return product && product.variants.length > 0 ? [product] : [];
  });
}
