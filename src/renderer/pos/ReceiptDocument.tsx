import { formatMoney } from "../money";
import { formatDateTime } from "../format";
import { useI18n } from "../shell/i18n";
import type { ReceiptIdentity } from "./receipt-identity";

export interface ReceiptLine {
  readonly key: string;
  readonly productName: string;
  readonly sku: string;
  readonly detail?: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
}

/**
 * Presentational receipt body, shared by the live post-sale receipt and historical reprints. It is a
 * fixed layout (not a template engine): the branded identity header is rendered when available, then
 * the lines and canonical totals. Monetary figures are always passed in by the caller from the
 * authoritative sale/order — never recomputed here beyond the gross/discount split.
 */
export function ReceiptDocument({
  identity,
  orderNumber,
  placedAt,
  statusLabel,
  lines,
  totalMinor,
  currency,
}: {
  identity: ReceiptIdentity | null;
  orderNumber: string;
  placedAt?: string | null;
  statusLabel?: string | null;
  lines: readonly ReceiptLine[];
  totalMinor: number;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const grossSubtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const discountMinor = grossSubtotalMinor - totalMinor;

  return (
    <div className="receipt-card">
      {identity ? (
        <div className="receipt-identity">
          <strong className="receipt-business-name">{identity.businessName}</strong>
          {identity.legalName ? <span>{identity.legalName}</span> : null}
          {identity.taxIdentifier ? (
            <span>{t("receipt.taxId", { id: identity.taxIdentifier })}</span>
          ) : null}
          <span className="receipt-branch-name">{identity.branchName}</span>
          {identity.branchAddressLines.map((line, index) => (
            <span key={`address-${index}`}>{line}</span>
          ))}
          {identity.branchContactLines.map((line, index) => (
            <span key={`contact-${index}`}>{line}</span>
          ))}
        </div>
      ) : null}
      <h1>{t("receipt.order", { number: orderNumber })}</h1>
      {placedAt ? <p className="muted">{formatDateTime(placedAt, locale)}</p> : null}
      {statusLabel ? <p className="receipt-status">{statusLabel}</p> : null}
      <div className="receipt-lines">
        {lines.map((line) => (
          <div key={line.key} className="receipt-line">
            <div>
              <strong>{line.productName}</strong>
              <span>
                {line.detail ? `${line.detail} · ` : ""}
                {t("cashier.sku", { sku: line.sku })}
              </span>
              <span>
                {line.quantity} × {formatMoney(line.unitPriceMinor, currency, locale)}
              </span>
            </div>
            <strong>{formatMoney(line.lineTotalMinor, currency, locale)}</strong>
          </div>
        ))}
      </div>
      <div className="receipt-totals">
        <div>
          <span>{t("pos.grossSubtotal")}</span>
          <strong>{formatMoney(grossSubtotalMinor, currency, locale)}</strong>
        </div>
        {discountMinor > 0 ? (
          <div className="receipt-discount">
            <span>{t("pos.promotionDiscount")}</span>
            <strong>−{formatMoney(discountMinor, currency, locale)}</strong>
          </div>
        ) : null}
        <div className="receipt-total-due">
          <span>{t("cashier.total")}</span>
          <strong>{formatMoney(totalMinor, currency, locale)}</strong>
        </div>
      </div>
      {identity?.receiptFooter ? <p className="receipt-footer">{identity.receiptFooter}</p> : null}
    </div>
  );
}
