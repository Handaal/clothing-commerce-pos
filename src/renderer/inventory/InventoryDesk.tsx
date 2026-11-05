import type {
  InventoryListResponse,
  InventoryLocation,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { AddProductModal } from "./AddProductModal";
import { BUSINESS_CURRENCY, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { AdminGate } from "../shell/AdminGate";
import { Icons } from "../shell/icons";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonTable } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

type StockRow = InventoryListResponse["items"][number];

// Slug derived from the (possibly renamed) product. `updateProduct` is a PATCH that still requires a
// slug, and the POS cannot read the product's current slug back, so we regenerate a unique one from the
// name exactly as creation does. A short suffix keeps it collision-free across products.
function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "product"}-${Date.now().toString(36).slice(-4)}`;
}

// A pending write targets one variant at one location; the row supplies the known identity + version.
type ReceiveDraft = {
  kind: "receive";
  variantId: string;
  productName: string;
  sku: string;
  inventoryLocationId: string;
  quantity: string;
  supplierReference: string;
  note: string;
};
type AdjustDraft = {
  kind: "adjust";
  variantId: string;
  productName: string;
  sku: string;
  inventoryLocationId: string;
  expectedVersion: number;
  countedQuantity: string;
  note: string;
};
type TransferDraft = {
  kind: "transfer";
  variantId: string;
  productName: string;
  sku: string;
  sourceInventoryLocationId: string;
  destinationInventoryLocationId: string;
  quantity: string;
  note: string;
};
// Editing a record: product-level name (shared across variants) plus this variant's selling price and
// unit cost. SKU is immutable in the API. `original*` fields let the save skip untouched writes so a
// rename does not needlessly reprice, and vice versa.
type EditDraft = {
  kind: "edit";
  productId: string;
  variantId: string;
  sku: string;
  originalName: string;
  name: string;
  originalSellingMinor: number | null;
  sellingPrice: string;
  originalCostMinor: number | null;
  unitCost: string;
  // Category is modelled as a single collection membership (matching the Add-product flow). "" = none.
  // The current collection ids let the save reconcile membership only when the selection changes.
  currentCategoryIds: readonly string[];
  categoryId: string;
};
type Draft = ReceiveDraft | AdjustDraft | TransferDraft | EditDraft;

export function InventoryDesk({ client }: { client: TenantCommerceClient }) {
  const { t, locale } = useI18n();
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [list, setList] = useState<InventoryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addingProduct, setAddingProduct] = useState(false);
  // Stock valuation (selling value + cost value) is owner-only. Hidden until an admin unlocks it via
  // PIN; the reveal lasts for the session so the admin isn't re-prompted on every refresh.
  const [valuesRevealed, setValuesRevealed] = useState(false);
  const [valueGateOpen, setValueGateOpen] = useState(false);

  // Classification lookups: brandId -> name, and productId -> category names. Inventory rows carry
  // brandId + productId, so these are small in-memory joins built once per client.
  const [brandNames, setBrandNames] = useState<Map<string, string>>(new Map());
  const [categoriesByProduct, setCategoriesByProduct] = useState<Map<string, string[]>>(new Map());
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  // Id-based category data for the edit modal: the full collection list to choose from, and each
  // product's current collection ids so the save only rewrites membership that actually changed.
  const [categoryList, setCategoryList] = useState<{ id: string; name: string }[]>([]);
  const [categoryIdsByProduct, setCategoryIdsByProduct] = useState<Map<string, string[]>>(new Map());
  const [brandFilter, setBrandFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  // Which row's action menu is open (one at a time), keyed by variantId, plus the fixed-position anchor
  // computed from the trigger. The menu is positioned `fixed` because the table card clips overflow, so
  // an absolutely-positioned dropdown would be cut off.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  const locationName = useCallback(
    (id: string) => locations.find((loc) => loc.id === id)?.displayName ?? id,
    [locations],
  );

  // Locations are the scope selector for every read and write. Load active ones once up front.
  useEffect(() => {
    let active = true;
    void client
      .listInventoryLocations({ status: "active", limit: 100 })
      .then((response) => {
        if (!active) return;
        setLocations(response.items);
        setLocationId((current) => current ?? response.items[0]?.id ?? null);
      })
      .catch((err) => active && setError(classifyCommerceError(err).message));
    return () => {
      active = false;
    };
  }, [client]);

  // Brand names for the brand column + filter.
  useEffect(() => {
    let active = true;
    void client
      .listBrands({ status: "active", limit: 100 })
      .then((response) => {
        if (!active) return;
        setBrandNames(new Map(response.items.map((b) => [b.id, b.displayName])));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);

  // Category (collection) membership: build productId -> [category name]. Collections are few, so
  // fetching each one's product ids up front is cheap and avoids per-row lookups. Exposed as a callback
  // so an edit that repoints a product's category can refresh the column without a full remount.
  const loadCategories = useCallback(async () => {
    const response = await client.listCollections();
    const active_ = response.collections.filter((c) => c.status !== "archived");
    const details = await Promise.all(active_.map((c) => client.getCollection(c.id)));
    const byProduct = new Map<string, string[]>();
    const idsByProduct = new Map<string, string[]>();
    active_.forEach((collection, index) => {
      for (const productId of details[index].productIds) {
        byProduct.set(productId, [...(byProduct.get(productId) ?? []), collection.name]);
        idsByProduct.set(productId, [...(idsByProduct.get(productId) ?? []), collection.id]);
      }
    });
    setCategoriesByProduct(byProduct);
    setCategoryNames(active_.map((c) => c.name));
    setCategoryList(active_.map((c) => ({ id: c.id, name: c.name })));
    setCategoryIdsByProduct(idsByProduct);
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async external read, not a sync setState
    void loadCategories().catch((error) =>
      console.error("[inventory] category classification failed", error),
    );
  }, [loadCategories]);

  // Close the open row menu on Escape (the scrim handles outside-clicks), and on scroll/resize since the
  // fixed-position anchor would otherwise drift away from its row.
  useEffect(() => {
    if (!menuFor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    const close = () => setMenuFor(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuFor]);

  const loadLevels = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    try {
      setList(await client.listInventory({ inventoryLocationId: locationId, limit: 100 }));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client, locationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void loadLevels();
  }, [loadLevels]);

  const loadMore = useCallback(async () => {
    if (!list?.pageInfo.hasMore || !locationId) return;
    try {
      const next = await client.listInventory({
        inventoryLocationId: locationId,
        limit: 100,
        cursor: list.pageInfo.nextCursor ?? undefined,
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setError(classifyCommerceError(err).message);
    }
  }, [client, list, locationId]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await action();
        setDraft(null);
        toast.success(done);
        await loadLevels();
      } catch (err) {
        toast.error(classifyCommerceError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [loadLevels, toast],
  );

  const submitDraft = () => {
    if (!draft) return;
    if (draft.kind === "receive") {
      const quantity = Number(draft.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        toast.error(t("inventory.err.qtyPositive"));
        return;
      }
      void run(
        () =>
          client.receiveInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            inventoryLocationId: draft.inventoryLocationId,
            quantity,
            ...(draft.supplierReference.trim()
              ? { supplierReference: draft.supplierReference.trim() }
              : {}),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        t("inventory.ok.received", {
          quantity,
          location: locationName(draft.inventoryLocationId),
        }),
      );
    } else if (draft.kind === "adjust") {
      const countedQuantity = Number(draft.countedQuantity);
      if (!Number.isInteger(countedQuantity) || countedQuantity < 0) {
        toast.error(t("inventory.err.countNonNeg"));
        return;
      }
      void run(
        () =>
          client.adjustInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            inventoryLocationId: draft.inventoryLocationId,
            countedQuantity,
            expectedVersion: draft.expectedVersion,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        t("inventory.ok.counted", { count: countedQuantity, sku: draft.sku }),
      );
    } else if (draft.kind === "edit") {
      const name = draft.name.trim();
      if (name === "") {
        toast.error(t("inventory.add.err.name"));
        return;
      }
      const priceTyped = draft.sellingPrice.trim() !== "";
      const sellingMinor = priceTyped ? parseMajorToMinor(draft.sellingPrice) : null;
      if (priceTyped && (sellingMinor === null || sellingMinor <= 0)) {
        toast.error(t("inventory.err.priceInvalid"));
        return;
      }
      const costTyped = draft.unitCost.trim() !== "";
      const costMinor = costTyped ? parseMajorToMinor(draft.unitCost) : null;
      if (costTyped && costMinor === null) {
        toast.error(t("inventory.err.costInvalid"));
        return;
      }
      void run(
        async () => {
          if (name !== draft.originalName) {
            await client.updateProduct({
              idempotencyKey: crypto.randomUUID(),
              productId: draft.productId,
              name,
              slug: slugify(name),
            });
          }
          if (sellingMinor !== null && sellingMinor !== draft.originalSellingMinor) {
            await client.setVariantPrice({
              idempotencyKey: crypto.randomUUID(),
              variantId: draft.variantId,
              currency: BUSINESS_CURRENCY,
              amountMinor: sellingMinor,
            });
          }
          if (costMinor !== null && costMinor !== draft.originalCostMinor) {
            await client.setVariantCost({
              idempotencyKey: crypto.randomUUID(),
              variantId: draft.variantId,
              unitCostMinor: costMinor,
            });
          }
          // Category change: reconcile collection membership. `setCollectionProducts` replaces a
          // collection's whole member set, so read each affected collection and add/remove just this
          // product. Only runs when the single-select value actually changed, so multi-category
          // products are left untouched unless the operator deliberately repoints the category.
          const originalCategoryId = draft.currentCategoryIds[0] ?? "";
          if (draft.categoryId !== originalCategoryId) {
            for (const collectionId of draft.currentCategoryIds) {
              if (collectionId === draft.categoryId) continue;
              const detail = await client.getCollection(collectionId);
              await client.setCollectionProducts({
                idempotencyKey: crypto.randomUUID(),
                collectionId,
                productIds: detail.productIds.filter((id) => id !== draft.productId),
              });
            }
            if (draft.categoryId && !draft.currentCategoryIds.includes(draft.categoryId)) {
              const detail = await client.getCollection(draft.categoryId);
              await client.setCollectionProducts({
                idempotencyKey: crypto.randomUUID(),
                collectionId: draft.categoryId,
                productIds: [...detail.productIds, draft.productId],
              });
            }
            await loadCategories();
          }
        },
        t("inventory.ok.updated", { name }),
      );
    } else {
      const quantity = Number(draft.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        toast.error(t("inventory.err.qtyPositive"));
        return;
      }
      if (draft.destinationInventoryLocationId === draft.sourceInventoryLocationId) {
        toast.error(t("inventory.err.differentDest"));
        return;
      }
      void run(
        () =>
          client.transferInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            sourceInventoryLocationId: draft.sourceInventoryLocationId,
            destinationInventoryLocationId: draft.destinationInventoryLocationId,
            quantity,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        t("inventory.ok.transferred", { quantity, sku: draft.sku }),
      );
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows: readonly StockRow[] =
    list === null
      ? []
      : list.items.filter((row) => {
          if (
            normalizedQuery !== "" &&
            !row.productName.toLowerCase().includes(normalizedQuery) &&
            !row.sku.toLowerCase().includes(normalizedQuery)
          ) {
            return false;
          }
          if (brandFilter !== "" && row.brandId !== brandFilter) return false;
          if (categoryFilter !== "") {
            const cats = categoriesByProduct.get(row.productId) ?? [];
            if (!cats.includes(categoryFilter)) return false;
          }
          return true;
        });

  const totalOnHand = visibleRows.reduce((sum, row) => sum + row.onHand, 0);
  // Valuation over the visible rows: stock value uses cost basis, selling value uses the active price;
  // rows with an unset cost/price simply contribute nothing to that total.
  const totalStockValueMinor = visibleRows.reduce(
    (sum, row) => sum + (row.unitCostMinor ?? 0) * row.onHand,
    0,
  );
  const totalSellingValueMinor = visibleRows.reduce(
    (sum, row) => sum + (row.sellingPriceMinor ?? 0) * row.onHand,
    0,
  );
  const categoryLabel = (row: StockRow): string => {
    const cats = categoriesByProduct.get(row.productId) ?? [];
    return cats.length === 0 ? t("inventory.uncategorized") : cats.join(", ");
  };
  const transferTargets = useMemo(
    () => locations.filter((loc) => loc.isTransferDestinationEnabled),
    [locations],
  );

  return (
    <main className="staff-shell">
      <header className="staff-topbar staff-topbar--inventory">
        <div>
          <p className="eyebrow">{t("inventory.stock")}</p>
          <h1>{t("nav.inventory")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            {t("inventory.location")}
            <Select
              ariaLabel={t("inventory.location")}
              value={locationId ?? ""}
              onChange={(value) => setLocationId(value)}
              disabled={locations.length === 0}
              options={locations.map((loc) => ({ value: loc.id, label: loc.displayName }))}
            />
          </label>
          <label className="staff-filters__search">
            {t("inventory.searchLabel")}
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            {t("inventory.brand")}
            <Select
              ariaLabel={t("inventory.brand")}
              value={brandFilter}
              onChange={setBrandFilter}
              options={[
                { value: "", label: t("inventory.allBrands") },
                ...[...brandNames.entries()].map(([id, name]) => ({ value: id, label: name })),
              ]}
            />
          </label>
          <label>
            {t("inventory.category")}
            <Select
              ariaLabel={t("inventory.category")}
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[
                { value: "", label: t("inventory.allCategories") },
                ...categoryNames.map((name) => ({ value: name, label: name })),
              ]}
            />
          </label>
          <button
            className="button button--quiet"
            onClick={() => void loadLevels()}
            disabled={busy}
          >
            {t("orders.refresh")}
          </button>
          <button
            className="button button--icon"
            onClick={() => setAddingProduct(true)}
            disabled={busy}
            title={t("inventory.add.title")}
            aria-label={t("inventory.add.title")}
          >
            <Icons.plus />
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void loadLevels()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>{t("inventory.trackedSkus")}</span>
          <strong>{list ? list.items.length : "—"}</strong>
        </div>
        <div className="staff-stat staff-stat--accent">
          <span>
            {normalizedQuery ? t("inventory.unitsOnHandFiltered") : t("inventory.unitsOnHand")}
          </span>
          <strong>{totalOnHand}</strong>
        </div>
        <div className="staff-stat">
          <span>{t("inventory.sellingValue")}</span>
          {valuesRevealed ? (
            <strong>{formatMoney(totalSellingValueMinor, BUSINESS_CURRENCY, locale)}</strong>
          ) : (
            <strong className="staff-stat__hidden" aria-label={t("inventory.valueHidden")}>
              ••••
            </strong>
          )}
          <button
            type="button"
            className="staff-stat__eye"
            aria-pressed={valuesRevealed}
            aria-label={valuesRevealed ? t("inventory.hideValues") : t("inventory.revealValues")}
            title={valuesRevealed ? t("inventory.hideValues") : t("inventory.revealValues")}
            onClick={() => (valuesRevealed ? setValuesRevealed(false) : setValueGateOpen(true))}
          >
            {valuesRevealed ? <Icons.eye /> : <Icons.eyeOff />}
          </button>
        </div>
        <div className="staff-stat">
          <span>{t("inventory.stockValue")}</span>
          {valuesRevealed ? (
            <strong>{formatMoney(totalStockValueMinor, BUSINESS_CURRENCY, locale)}</strong>
          ) : (
            <strong className="staff-stat__hidden" aria-label={t("inventory.valueHidden")}>
              ••••
            </strong>
          )}
          <button
            type="button"
            className="staff-stat__eye"
            aria-pressed={valuesRevealed}
            aria-label={valuesRevealed ? t("inventory.hideValues") : t("inventory.revealValues")}
            title={valuesRevealed ? t("inventory.hideValues") : t("inventory.revealValues")}
            onClick={() => (valuesRevealed ? setValuesRevealed(false) : setValueGateOpen(true))}
          >
            {valuesRevealed ? <Icons.eye /> : <Icons.eyeOff />}
          </button>
        </div>
        <div className="staff-stat">
          <span>{t("inventory.locations")}</span>
          <strong>{locations.length}</strong>
        </div>
      </div>

      {valueGateOpen ? (
        <AdminGate
          title={t("inventory.revealValues")}
          onVerified={() => {
            setValuesRevealed(true);
            setValueGateOpen(false);
          }}
          onCancel={() => setValueGateOpen(false)}
        />
      ) : null}

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            {t("inventory.stockLevels")} · {locationId ? locationName(locationId) : "—"}
          </h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>{t("orders.product")}</th>
                <th>{t("inventory.brand")}</th>
                <th>{t("inventory.category")}</th>
                <th className="end">{t("inventory.onHand")}</th>
                <th className="end">{t("inventory.version")}</th>
                <th className="end">{t("staff.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.variantId}>
                  <td>
                    <strong>{row.productName}</strong>
                    <small>{t("cashier.sku", { sku: row.sku })}</small>
                  </td>
                  <td className="muted">{brandNames.get(row.brandId) ?? "—"}</td>
                  <td className="muted">{categoryLabel(row)}</td>
                  <td className="end">
                    <strong>{row.onHand}</strong>
                  </td>
                  <td className="end muted">{row.version}</td>
                  <td className="end">
                    <div className="row-menu-wrap">
                      <button
                        className="row-action row-action--trigger"
                        disabled={busy}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === row.variantId}
                        title={t("inventory.actions")}
                        aria-label={t("inventory.actions")}
                        onClick={(event) => {
                          if (menuFor === row.variantId) {
                            setMenuFor(null);
                            return;
                          }
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenuPos({
                            top: rect.bottom + 4,
                            right: window.innerWidth - rect.right,
                          });
                          setMenuFor(row.variantId);
                        }}
                      >
                        <Icons.edit />
                      </button>
                      {menuFor === row.variantId ? (
                        <>
                          <button
                            type="button"
                            className="row-menu__scrim"
                            aria-hidden="true"
                            tabIndex={-1}
                            onClick={() => setMenuFor(null)}
                          />
                          <div
                            className="row-menu"
                            role="menu"
                            style={{ top: menuPos.top, right: menuPos.right }}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu__item"
                              onClick={() => {
                                setMenuFor(null);
                                const currentCategoryIds =
                                  categoryIdsByProduct.get(row.productId) ?? [];
                                setDraft({
                                  kind: "edit",
                                  productId: row.productId,
                                  variantId: row.variantId,
                                  sku: row.sku,
                                  originalName: row.productName,
                                  name: row.productName,
                                  originalSellingMinor: row.sellingPriceMinor ?? null,
                                  sellingPrice:
                                    row.sellingPriceMinor != null
                                      ? minorToMajorInput(row.sellingPriceMinor)
                                      : "",
                                  originalCostMinor: row.unitCostMinor ?? null,
                                  unitCost:
                                    row.unitCostMinor != null
                                      ? minorToMajorInput(row.unitCostMinor)
                                      : "",
                                  currentCategoryIds,
                                  categoryId: currentCategoryIds[0] ?? "",
                                });
                              }}
                            >
                              <Icons.edit />
                              {t("inventory.editDetails")}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu__item"
                              onClick={() => {
                                setMenuFor(null);
                                setDraft({
                                  kind: "receive",
                                  variantId: row.variantId,
                                  productName: row.productName,
                                  sku: row.sku,
                                  inventoryLocationId: row.inventoryLocationId,
                                  quantity: "",
                                  supplierReference: "",
                                  note: "",
                                });
                              }}
                            >
                              <Icons.receive />
                              {t("inventory.receive")}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu__item"
                              onClick={() => {
                                setMenuFor(null);
                                setDraft({
                                  kind: "adjust",
                                  variantId: row.variantId,
                                  productName: row.productName,
                                  sku: row.sku,
                                  inventoryLocationId: row.inventoryLocationId,
                                  expectedVersion: row.version,
                                  countedQuantity: String(row.onHand),
                                  note: "",
                                });
                              }}
                            >
                              <Icons.adjust />
                              {t("staff.adjust")}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu__item"
                              disabled={transferTargets.length === 0}
                              onClick={() => {
                                setMenuFor(null);
                                setDraft({
                                  kind: "transfer",
                                  variantId: row.variantId,
                                  productName: row.productName,
                                  sku: row.sku,
                                  sourceInventoryLocationId: row.inventoryLocationId,
                                  destinationInventoryLocationId:
                                    transferTargets.find((loc) => loc.id !== row.inventoryLocationId)
                                      ?.id ?? "",
                                  quantity: "",
                                  note: "",
                                });
                              }}
                            >
                              <Icons.transfer />
                              {t("inventory.transfer")}
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? <SkeletonTable rows={6} cols={6} label={t("inventory.loading")} /> : null}
        {!loading && visibleRows.length === 0 ? (
          <p className="staff-empty">
            {normalizedQuery === "" ? t("inventory.noStock") : t("inventory.noMatch", { query })}
          </p>
        ) : null}
        {list?.pageInfo.hasMore ? (
          <div className="staff-card__head">
            <button
              className="button button--quiet"
              onClick={() => void loadMore()}
              disabled={busy}
            >
              {t("inventory.loadMore")}
            </button>
          </div>
        ) : null}
      </section>

      {addingProduct ? (
        <AddProductModal
          client={client}
          locations={locations}
          defaultLocationId={locationId}
          onClose={() => setAddingProduct(false)}
          onCreated={(productName, warning) => {
            setAddingProduct(false);
            if (warning) toast.error(warning);
            else toast.success(t("inventory.ok.productCreated", { name: productName }));
            void loadLevels();
            // The new product's category membership lives in the collections map, not the stock list, so
            // refresh it too — otherwise a product created WITH a category shows as "Uncategorized".
            void loadCategories().catch(() => {});
          }}
        />
      ) : null}

      {draft ? (
        <Modal
          title={
            draft.kind === "receive"
              ? t("inventory.receiveTitle", { sku: draft.sku })
              : draft.kind === "adjust"
                ? t("inventory.adjustTitle", { sku: draft.sku })
                : draft.kind === "edit"
                  ? t("inventory.editTitle", { sku: draft.sku })
                  : t("inventory.transferTitle", { sku: draft.sku })
          }
          onClose={() => setDraft(null)}
          onSave={submitDraft}
          busy={busy}
          saveLabel={
            draft.kind === "receive"
              ? t("inventory.receive")
              : draft.kind === "adjust"
                ? t("inventory.setCount")
                : draft.kind === "edit"
                  ? t("inventory.saveChanges")
                  : t("inventory.transfer")
          }
        >
          {draft.kind !== "edit" ? <p className="muted">{draft.productName}</p> : null}
          {draft.kind === "edit" ? (
            <>
              <p className="muted">{t("cashier.sku", { sku: draft.sku })}</p>
              <label className="field">
                {t("inventory.add.name")}
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                {t("inventory.add.price")}
                <input
                  inputMode="decimal"
                  value={draft.sellingPrice}
                  onChange={(e) => setDraft({ ...draft, sellingPrice: e.target.value })}
                  placeholder="0.00"
                />
              </label>
              <label className="field">
                {t("inventory.add.cost")}
                <input
                  inputMode="decimal"
                  value={draft.unitCost}
                  onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })}
                  placeholder="0.00"
                />
              </label>
              <label className="field">
                {t("inventory.add.category")}
                <Select
                  ariaLabel={t("inventory.add.category")}
                  value={draft.categoryId}
                  onChange={(value) => setDraft({ ...draft, categoryId: value })}
                  options={[
                    { value: "", label: t("inventory.add.chooseCategory") },
                    ...categoryList.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </label>
            </>
          ) : draft.kind === "receive" ? (
            <>
              <p className="muted">
                {t("inventory.into", { location: locationName(draft.inventoryLocationId) })}
              </p>
              <label className="field">
                {t("inventory.quantityReceived")}
                <input
                  inputMode="numeric"
                  value={draft.quantity}
                  onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                  placeholder="0"
                />
              </label>
              <label className="field">
                {t("inventory.supplierRef")}
                <input
                  value={draft.supplierReference}
                  onChange={(e) => setDraft({ ...draft, supplierReference: e.target.value })}
                />
              </label>
              <label className="field">
                {t("inventory.note")}
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          ) : draft.kind === "adjust" ? (
            <>
              <p className="muted">
                {t("inventory.atVersion", {
                  location: locationName(draft.inventoryLocationId),
                  version: draft.expectedVersion,
                })}
              </p>
              <label className="field">
                {t("inventory.countedQuantity")}
                <input
                  inputMode="numeric"
                  value={draft.countedQuantity}
                  onChange={(e) => setDraft({ ...draft, countedQuantity: e.target.value })}
                />
              </label>
              <label className="field">
                {t("inventory.note")}
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <p className="muted">
                {t("inventory.from", { location: locationName(draft.sourceInventoryLocationId) })}
              </p>
              <label className="field">
                {t("inventory.destination")}
                <Select
                  ariaLabel={t("inventory.destination")}
                  placeholder={t("inventory.chooseDestination")}
                  value={draft.destinationInventoryLocationId}
                  onChange={(value) =>
                    setDraft({ ...draft, destinationInventoryLocationId: value })
                  }
                  options={transferTargets
                    .filter((loc) => loc.id !== draft.sourceInventoryLocationId)
                    .map((loc) => ({ value: loc.id, label: loc.displayName }))}
                />
              </label>
              <label className="field">
                {t("inventory.quantityToMove")}
                <input
                  inputMode="numeric"
                  value={draft.quantity}
                  onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                  placeholder="0"
                />
              </label>
              <label className="field">
                {t("inventory.note")}
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          )}
        </Modal>
      ) : null}
    </main>
  );
}

function Modal({
  title,
  children,
  onClose,
  onSave,
  busy,
  saveLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  saveLabel: string;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
