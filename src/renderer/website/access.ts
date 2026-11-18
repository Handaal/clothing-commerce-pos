import type {
  MeContextResponse,
  ProductListResponse,
  PromotionSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";

// Website Management affordances, derived from the operator's server-resolved `/me/context` guidance —
// the same signal Admin Mobile's Storefront hub uses. These booleans only shape the UI (what is shown and
// which buttons are enabled); the Commerce API still authorizes every read and write independently.
export interface WebsiteAccess {
  /** Home-page content + catalog publication (the API enforces catalog.author / catalog write). */
  catalogRead: boolean;
  /** Item sales + promotions list. */
  promotionsRead: boolean;
  promotionsManage: boolean;
  /** Per-brand checkout settings + returns policy. */
  settingsRead: boolean;
  settingsManage: boolean;
  /** Online (Storefront) orders queue (orders.read); fulfil / cancel are separate grants. */
  ordersRead: boolean;
  ordersFulfill: boolean;
  ordersCancel: boolean;
}

export const NO_WEBSITE_ACCESS: WebsiteAccess = {
  catalogRead: false,
  promotionsRead: false,
  promotionsManage: false,
  settingsRead: false,
  settingsManage: false,
  ordersRead: false,
  ordersFulfill: false,
  ordersCancel: false,
};

export function websiteAccess(context: Pick<MeContextResponse, "access">): WebsiteAccess {
  const { catalog, promotions, settings } = context.access;
  // `orders` is always present on a current server; tolerate its absence (older payloads, test stubs).
  const orders = (context.access as Partial<MeContextResponse["access"]>).orders;
  return {
    catalogRead: catalog.canRead,
    // Deliberately independent: manage never implies read (mirrors Admin Mobile capabilities).
    promotionsRead: promotions?.canRead ?? false,
    promotionsManage: promotions?.canManage ?? false,
    settingsRead: settings?.canRead ?? false,
    settingsManage: settings?.canManage ?? false,
    ordersRead: orders?.canRead ?? false,
    ordersFulfill: (orders?.canRead ?? false) && (orders?.canFulfill ?? false),
    ordersCancel: (orders?.canRead ?? false) && (orders?.canCancel ?? false),
  };
}

export function hasAnyWebsiteAccess(access: WebsiteAccess): boolean {
  return access.catalogRead || access.promotionsRead || access.settingsRead || access.ordersRead;
}

/** Safety bound for cursor/offset pagination so a misbehaving server can never loop the desk forever. */
export const MAX_PAGES = 50;

export type ProductItem = ProductListResponse["items"][number];

/** Every catalog product, following the cursor contract to completion (fails closed at the bound). */
export async function loadAllProducts(
  client: Pick<TenantCommerceClient, "listProducts">,
  maxPages = MAX_PAGES,
): Promise<ProductItem[]> {
  const items: ProductItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await client.listProducts({ limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...response.items);
    if (!response.pageInfo.hasMore || response.pageInfo.nextCursor === null) return items;
    cursor = response.pageInfo.nextCursor;
  }
  throw new Error("The product list is larger than this screen can load.");
}

/** Every promotion through the offset list (fails closed at the bound). */
export async function loadAllPromotions(
  client: Pick<TenantCommerceClient, "listPromotions">,
  maxPages = MAX_PAGES,
): Promise<PromotionSummary[]> {
  const items: PromotionSummary[] = [];
  for (let page = 0; page < maxPages; page++) {
    const response = await client.listPromotions({ limit: 100, offset: items.length });
    items.push(...response.items);
    if (items.length >= response.total) return items;
    if (response.items.length === 0) {
      throw new Error("Promotion pagination stopped before the reported total was loaded.");
    }
  }
  throw new Error("The promotion list is larger than this screen can load.");
}
