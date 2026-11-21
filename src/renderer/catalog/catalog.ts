import type { ProductDetailResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

import { sortBySize } from "./variant-order";

export interface SellableVariant {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  barcode?: string | null;
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
        barcode: variant.barcode ?? null,
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
    // S, M, L, XL — not creation order — wherever the register lists sizes.
    variants: sortBySize(variants, (variant) => variant.variantName ?? variant.sku),
  };
}

// Build the classification lookups the register needs. Products are grouped by their catalogue
// CATEGORIES (T-Shirts, Jeans… — the same tree the Storefront menu and Admin Mobile use) and labelled /
// searched by their VENDOR ("Brand": Zara, H&M…). Tenants that haven't set up categories or vendors
// keep the older behaviour: collections as categories and the tenant brand name. Every read degrades
// to empty so a missing lookup never blocks selling.
interface Classifier {
  brands: Map<string, string>;
  vendors: Map<string, string>;
  /** Category id -> { name, parentId } for active categories. */
  categories: Map<string, { name: string; parentId: string | null }>;
  collectionsByProduct: Map<string, string[]>;
}

async function loadClassification(client: TenantCommerceClient): Promise<Classifier> {
  const result: Classifier = {
    brands: new Map(),
    vendors: new Map(),
    categories: new Map(),
    collectionsByProduct: new Map(),
  };
  // Wrap each call in Promise.resolve().then(...) so even a synchronous throw (e.g. a client stub
  // without these methods) becomes a caught rejection and degrades to empty classification.
  await Promise.all([
    Promise.resolve()
      .then(() => client.listBrands({ status: "active", limit: 100 }))
      .then((response) => {
        for (const brand of response.items) result.brands.set(brand.id, brand.displayName);
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => client.listVendors())
      .then((response) => {
        for (const vendor of response.vendors) result.vendors.set(vendor.id, vendor.name);
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => client.listCategories())
      .then((response) => {
        for (const category of response.categories) {
          if (category.status === "active") {
            result.categories.set(category.id, {
              name: category.name,
              parentId: category.parentId,
            });
          }
        }
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => client.listCollections())
      .then(async (response) => {
        const visible = response.collections.filter((c) => c.status !== "archived");
        const details = await Promise.all(visible.map((c) => client.getCollection(c.id)));
        visible.forEach((collection, index) => {
          for (const productId of details[index].productIds) {
            result.collectionsByProduct.set(productId, [
              ...(result.collectionsByProduct.get(productId) ?? []),
              collection.name,
            ]);
          }
        });
      })
      // Collections are only the fallback grouping; log so a silent failure stays diagnosable.
      .catch((error) => console.error("[catalog] collection classification failed", error)),
  ]);
  return result;
}

/**
 * The register's grouping for one product: its most specific active categories (a product filed under
 * both "Men" and "T-Shirts" shows under "T-Shirts" only), or — when the tenant has no categories at
 * all — its collections. Brand label: the vendor when set, else the tenant brand.
 */
export function classifyProduct(
  detail: Pick<ProductDetailResponse, "product" | "categoryIds" | "vendorId">,
  classifier: Classifier,
): Classification {
  const assigned = (detail.categoryIds ?? []).filter((id) => classifier.categories.has(id));
  const ancestors = new Set<string>();
  for (const id of assigned) {
    let parent = classifier.categories.get(id)?.parentId ?? null;
    for (let depth = 0; parent && depth < 10; depth += 1) {
      ancestors.add(parent);
      parent = classifier.categories.get(parent)?.parentId ?? null;
    }
  }
  const categories =
    classifier.categories.size > 0
      ? assigned.filter((id) => !ancestors.has(id)).map((id) => classifier.categories.get(id)!.name)
      : (classifier.collectionsByProduct.get(detail.product.id) ?? []);
  const vendorName = detail.vendorId ? classifier.vendors.get(detail.vendorId) : undefined;
  return {
    brandName: vendorName ?? classifier.brands.get(detail.product.brandId) ?? null,
    categories: [...new Set(categories)],
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
  const [details, classification] = await Promise.all([
    Promise.all(productIds.map((productId) => client.getProduct(productId))),
    loadClassification(client),
  ]);
  const classify = (detail: ProductDetailResponse): Classification =>
    classifyProduct(detail, classification);
  return details.flatMap((detail) => {
    const product = sellableProduct(detail, currency, classify);
    return product && product.variants.length > 0 ? [product] : [];
  });
}
