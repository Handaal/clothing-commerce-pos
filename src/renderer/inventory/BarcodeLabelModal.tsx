import { useState } from "react";
import JsBarcode from "jsbarcode";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { useModalA11y } from "../shell/useModalA11y";

export function BarcodeLabelModal({
  name,
  sku,
  barcode,
  priceMinor,
  onClose,
}: {
  name: string;
  sku: string;
  barcode: string;
  priceMinor: number | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [quantity, setQuantity] = useState(1);
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const count = Math.max(1, Math.min(100, Number.isFinite(quantity) ? Math.floor(quantity) : 1));
  return (
    <div
      className="modal-overlay barcode-label-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("inventory.barcodeLabel")}
      onClick={onClose}
    >
      <div
        className="modal-card barcode-label-modal"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="variant-dialog__head">
          <h3>{t("inventory.barcodeLabel")}</h3>
          <button className="button button--quiet" onClick={onClose}>
            {t("cashier.closeVariants")}
          </button>
        </div>
        <label className="field barcode-label-quantity">
          {t("inventory.labelQuantity")}
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
          />
        </label>
        <div className="barcode-print-sheet">
          {Array.from({ length: count }, (_, index) => (
            <section className="barcode-label" key={index}>
              <strong>{name}</strong>
              <small>{sku}</small>
              <svg
                ref={(element) => {
                  if (element)
                    JsBarcode(element, barcode, {
                      format: "CODE128",
                      width: 2,
                      height: 54,
                      displayValue: true,
                      fontSize: 12,
                      margin: 4,
                    });
                }}
              />
              {priceMinor !== null ? (
                <strong>{formatMoney(priceMinor, "EGP", locale)}</strong>
              ) : null}
            </section>
          ))}
        </div>
        <button className="button" onClick={() => window.print()}>
          {t("inventory.printLabels")}
        </button>
      </div>
    </div>
  );
}
