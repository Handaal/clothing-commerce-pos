import type { SellableProduct, SellableVariant } from "../catalog/catalog";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { useModalA11y } from "../shell/useModalA11y";

/**
 * Variant picker shown when the cashier taps a product. Mirrors the elder POS size-picker: a modal
 * that lists every variant with its unit price and the remaining (projected) quantity, plus the
 * product's total remaining across all variants. Adding a variant keeps the dialog open so several
 * sizes/colours can be rung up in one pass; the cashier closes it explicitly when done.
 */
export function VariantDialog({
  product,
  stockByVariant,
  submitting,
  onAdd,
  onClose,
}: {
  product: SellableProduct;
  // Projected available quantity per variant. A missing entry means stock is not yet known (e.g. the
  // offline projection has not been installed) — we show "stock unavailable" rather than blocking.
  stockByVariant: ReadonlyMap<string, number>;
  submitting: boolean;
  onAdd: (variant: SellableVariant) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const anyStockKnown = product.variants.some((variant) => stockByVariant.has(variant.variantId));
  const totalRemaining = product.variants.reduce(
    (sum, variant) => sum + (stockByVariant.get(variant.variantId) ?? 0),
    0,
  );

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("cashier.chooseVariant", { product: product.productName })}
      onClick={onClose}
    >
      <div
        className="modal-card variant-dialog"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="variant-dialog__head">
          <div>
            <p className="eyebrow">{t("cashier.variants")}</p>
            <h3>{product.productName}</h3>
            {product.styleCode ? <span className="muted">{product.styleCode}</span> : null}
          </div>
          <button
            type="button"
            className="pay-remove"
            aria-label={t("cashier.closeVariants")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {anyStockKnown ? (
          <div className="variant-dialog__total">
            <span>{t("cashier.totalRemaining")}</span>
            <strong>{t("cashier.unitsCount", { count: totalRemaining })}</strong>
          </div>
        ) : null}

        <div className="variant-dialog__list">
          {product.variants.map((variant) => {
            const remaining = stockByVariant.get(variant.variantId);
            const soldOut = remaining !== undefined && remaining <= 0;
            return (
              <div
                className={`variant-option${soldOut ? " variant-option--out" : ""}`}
                key={variant.variantId}
              >
                <div className="variant-option__info">
                  <strong>{variant.variantName ?? t("cashier.standard")}</strong>
                  <span>{t("cashier.sku", { sku: variant.sku })}</span>
                </div>
                <div className="variant-option__meta">
                  <span className="variant-option__price">
                    {formatMoney(variant.unitPriceMinor, undefined, locale)}
                  </span>
                  <span
                    className={`variant-option__stock${
                      soldOut ? " variant-option__stock--out" : ""
                    }`}
                  >
                    {remaining === undefined
                      ? t("cashier.stockUnknown")
                      : soldOut
                        ? t("cashier.outOfStock")
                        : t("cashier.remainingCount", { count: remaining })}
                  </span>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={submitting || soldOut}
                  onClick={() => onAdd(variant)}
                >
                  {t("cashier.add")}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
