import type { OrderDetailResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useEffect, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { ReceiptDocument, type ReceiptLine } from "../pos/ReceiptDocument";
import type { ReceiptIdentity } from "../pos/receipt-identity";
import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useModalA11y } from "../shell/useModalA11y";

// Shows a historical order's full line items and lets the operator reprint its receipt. Opened from a
// customer's purchase history. The receipt body is isolated for printing via the `.receipt-print`
// overlay (see the `@media print` rules in styles.css), so `window.print()` emits only the receipt.
export function OrderReceiptModal({
  client,
  orderId,
  identity,
  onClose,
}: {
  client: TenantCommerceClient;
  orderId: string;
  identity: ReceiptIdentity | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [order, setOrder] = useState<OrderDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    /* eslint-disable react-hooks/set-state-in-effect -- reset the loading transition for a new order */
    setOrder(null);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    void client
      .getOrder(orderId)
      .then((detail) => active && setOrder(detail))
      .catch((err) => active && setError(classifyCommerceError(err).message));
    return () => {
      active = false;
    };
  }, [client, orderId]);

  const lines: readonly ReceiptLine[] = order
    ? order.lines.map((line) => ({
        key: String(line.lineNumber),
        productName: line.productName,
        sku: line.sku,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
      }))
    : [];

  return (
    <div
      className="modal-overlay receipt-print-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="modal-card receipt-print"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <div className="notice notice--error no-print" role="alert">
            {error}
          </div>
        ) : !order ? (
          <SkeletonLines lines={6} label={t("customers.loadingReceipt")} />
        ) : (
          <ReceiptDocument
            identity={identity}
            orderNumber={order.header.orderNumber}
            placedAt={order.header.placedAt}
            lines={lines}
            totalMinor={order.header.totalMinor}
            currency={order.header.currency}
          />
        )}
        <div className="staff-modal__actions no-print">
          <button className="button button--quiet" onClick={onClose}>
            {t("vouchers.close")}
          </button>
          <button className="button" onClick={() => window.print()} disabled={!order}>
            {t("customers.reprint")}
          </button>
        </div>
      </div>
    </div>
  );
}
