import { useEffect, useRef, useState, type ReactNode } from "react";

import { groupByCategory, type SellableProduct, type SellableVariant } from "../catalog/catalog";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";

/**
 * The cashier's catalog column, shared by the connected and the offline register so both behave the
 * same on the floor:
 *
 * - **Scanner-ready search.** A barcode scanner types the code then sends Enter; an exact SKU/barcode
 *   match is handed to `onScanMatch` (add to cart). Keystrokes that arrive while nothing editable has
 *   focus (e.g. right after a card, cart button or closed dialog took it) are routed into the search
 *   box, so a scan is never silently lost.
 * - **Persistent category bar.** "All" plus one chip per category stays visible above the grid, so
 *   switching category is one tap and products are always on screen (no drill-in / back step).
 * - **Price on every card**, so the cashier can answer "how much?" without opening the variant picker.
 */
export function CatalogBrowser({
  products,
  stockByVariant,
  currency,
  disabled = false,
  captureKeys = true,
  selectedProductId,
  onSelectProduct,
  onScanMatch,
  status,
  emptyNotice,
}: {
  products: readonly SellableProduct[];
  /** Remaining quantity per variant. A variant missing from the map has unknown stock (sellable). */
  stockByVariant: ReadonlyMap<string, number>;
  currency?: string;
  /** Disables the search box (catalog not ready). */
  disabled?: boolean;
  /** When false, scan keystrokes are not captured from outside the search box (cart locked, returns open). */
  captureKeys?: boolean;
  selectedProductId: string | null;
  onSelectProduct: (productId: string) => void;
  /** An exact SKU/barcode match from the search box (scanner Enter). */
  onScanMatch: (variant: SellableVariant) => void;
  /** Loading / error states rendered between the search box and the grid. */
  status?: ReactNode;
  /** Shown instead of the grid when there are no products at all. */
  emptyNotice?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizedQuery = query.trim().toLowerCase();
  // Search matches product name, brand, style code, and any variant name, SKU or barcode.
  const filteredProducts =
    normalizedQuery === ""
      ? products
      : products.filter(
          (product) =>
            product.productName.toLowerCase().includes(normalizedQuery) ||
            (product.brandName?.toLowerCase().includes(normalizedQuery) ?? false) ||
            (product.styleCode?.toLowerCase().includes(normalizedQuery) ?? false) ||
            product.variants.some(
              (variant) =>
                variant.sku.toLowerCase().includes(normalizedQuery) ||
                (variant.barcode?.toLowerCase().includes(normalizedQuery) ?? false) ||
                (variant.variantName?.toLowerCase().includes(normalizedQuery) ?? false),
            ),
        );
  // Categories come from the whole catalog (not the search result) so the bar does not jump while typing.
  const groups = groupByCategory(products, t("pos.uncategorized"));
  const activeGroup = groups.find((group) => group.category === category) ?? null;
  // A search always spans the whole catalog; the category chip narrows browsing only.
  const visibleProducts =
    normalizedQuery !== ""
      ? filteredProducts
      : activeGroup
        ? activeGroup.products
        : [...products].sort((a, b) => a.productName.localeCompare(b.productName));

  function submit() {
    if (normalizedQuery === "") return;
    const exact = products
      .flatMap((product) => product.variants)
      .find(
        (variant) =>
          variant.sku.toLowerCase() === normalizedQuery ||
          variant.barcode?.toLowerCase() === normalizedQuery,
      );
    if (exact) {
      onScanMatch(exact);
      setQuery("");
      return;
    }
    if (filteredProducts.length === 1) onSelectProduct(filteredProducts[0].productId);
  }

  // Route stray printable keystrokes (a scanner, or the cashier just typing) into the search box when
  // focus is on a non-editable element. Modals, form fields and modified shortcuts are left alone.
  const captureRef = useRef({ captureKeys, disabled });
  useEffect(() => {
    captureRef.current = { captureKeys, disabled };
  }, [captureKeys, disabled]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // F2 = jump to search from anywhere on the till (outside dialogs).
      if (event.key === "F2" && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      const { captureKeys: enabled, disabled: off } = captureRef.current;
      if (!enabled || off || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key.length !== 1 || event.key === " ") return;
      const target = event.target as HTMLElement | null;
      if (target && isEditable(target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const input = inputRef.current;
      if (!input) return;
      event.preventDefault();
      setQuery((current) => current + event.key);
      input.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <div className="catalog-search">
        <input
          ref={inputRef}
          className="catalog-search__input"
          aria-label={t("pos.searchAria")}
          placeholder={t("pos.searchPlaceholder")}
          value={query}
          disabled={disabled}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
        {query === "" ? (
          <kbd className="key-hint catalog-search__hint" aria-hidden="true">
            F2
          </kbd>
        ) : null}
        {query !== "" ? (
          <button
            type="button"
            className="catalog-search__clear"
            aria-label={t("pos.clearSearch")}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {status}
      {products.length === 0 ? (
        emptyNotice
      ) : (
        <>
          {groups.length > 0 ? (
            <div className="category-bar" role="group" aria-label={t("pos.categories")}>
              <button
                type="button"
                className={`category-chip${activeGroup === null ? " category-chip--active" : ""}`}
                aria-pressed={activeGroup === null}
                onClick={() => {
                  setCategory(null);
                  setQuery("");
                }}
              >
                {t("pos.allProducts")}
                <span className="category-chip__count">{products.length}</span>
              </button>
              {groups.map((group) => (
                <button
                  key={group.category}
                  type="button"
                  className={`category-chip${activeGroup?.category === group.category ? " category-chip--active" : ""}`}
                  aria-pressed={activeGroup?.category === group.category}
                  onClick={() => {
                    setCategory(group.category);
                    setQuery("");
                  }}
                >
                  {group.category}
                  <span className="category-chip__count">{group.products.length}</span>
                </button>
              ))}
            </div>
          ) : null}
          {normalizedQuery !== "" && filteredProducts.length === 0 ? (
            <p className="inline-state">{t("pos.noMatch", { query })}</p>
          ) : null}
          <div className="product-grid">
            {visibleProducts.map((product) => {
              const known = product.variants.every((variant) =>
                stockByVariant.has(variant.variantId),
              );
              const soldOut = product.variants.every(
                (variant) => (stockByVariant.get(variant.variantId) ?? Infinity) <= 0,
              );
              const remaining = product.variants.reduce(
                (sum, variant) => sum + (stockByVariant.get(variant.variantId) ?? 0),
                0,
              );
              return (
                <button
                  key={product.productId}
                  type="button"
                  className={`product-card${soldOut ? " product-card--out" : ""}${selectedProductId === product.productId ? " product-card--selected" : ""}`}
                  disabled={soldOut}
                  onClick={() => onSelectProduct(product.productId)}
                >
                  <span>{product.productName}</span>
                  {product.brandName ? (
                    <span className="product-card__brand">{product.brandName}</span>
                  ) : null}
                  <small>
                    {product.styleCode ??
                      t("cashier.variantCount", { count: product.variants.length })}
                  </small>
                  <div className="product-card__foot">
                    <strong className="product-card__price">
                      {priceLabel(product, currency, locale, t)}
                    </strong>
                    <small className="product-card__stock">
                      {soldOut
                        ? t("cashier.outOfStock")
                        : known
                          ? t("cashier.remainingCount", { count: remaining })
                          : t("cashier.stockUnknown")}
                    </small>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function isEditable(element: HTMLElement): boolean {
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable ||
    element.getAttribute("role") === "listbox"
  );
}

/** The card price: "EGP 450" for one price, "From EGP 450" when variants differ. */
function priceLabel(
  product: SellableProduct,
  currency: string | undefined,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (product.variants.length === 0) return "";
  const prices = product.variants.map((variant) => variant.unitPriceMinor);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const formatted = formatMoney(min, currency, locale);
  return min === max ? formatted : t("pos.priceFrom", { price: formatted });
}
