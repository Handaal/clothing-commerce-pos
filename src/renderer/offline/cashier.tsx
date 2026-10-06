import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CachedCatalogItem,
  LocalReceipt,
  OfflineBridge,
  OfflineSyncStatus,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { addVariant, cartTotal, removeLine, updateQuantity, type CartLine } from "../cart/cart";
import type { SellableProduct, SellableVariant } from "../catalog/catalog";
import { formatMoney } from "../money";
import { PayModal, type SaleTender } from "../checkout/PayModal";

export function cachedProducts(items: readonly CachedCatalogItem[]): readonly SellableProduct[] {
  const products = new Map<string, SellableProduct>();
  for (const item of items) {
    const variant: SellableVariant = {
      variantId: item.variantId,
      productId: item.productId,
      productName: item.productName,
      variantName: item.optionSummary,
      sku: item.sku,
      unitPriceMinor: item.unitPriceMinor,
    };
    const current = products.get(item.productId);
    if (current) {
      products.set(item.productId, { ...current, variants: [...current.variants, variant] });
    } else {
      products.set(item.productId, {
        productId: item.productId,
        productName: item.productName,
        styleCode: null,
        variants: [variant],
      });
    }
  }
  return [...products.values()];
}

export function syncLabel(status: OfflineSyncStatus): string {
  if (status.needsReconciliation > 0) return "Needs attention";
  if (status.blocked > 0) return "Sync blocked";
  if (status.synchronizing || status.leased > 0) return "Synchronizing";
  if (status.pending + status.retryWait > 0) return "Pending sync";
  if (status.synced > 0) return "All sales synchronized";
  return status.networkOnline ? "Connected" : "Offline ready";
}

export function waitingSyncCount(status: OfflineSyncStatus): number {
  return status.pending + status.leased + status.retryWait;
}

interface OfflineCashierProps {
  readonly bridge: OfflineBridge;
  readonly currency: string;
  readonly catalog: readonly CachedCatalogItem[];
  readonly inventory: readonly ProjectedInventoryItem[];
  readonly syncStatus: OfflineSyncStatus;
  readonly onRefresh: () => Promise<void>;
  readonly onUseConnected: () => void;
  readonly onSignOut: () => Promise<void>;
}

export function OfflineCashier({
  bridge,
  currency,
  catalog,
  inventory,
  syncStatus,
  onRefresh,
  onUseConnected,
  onSignOut,
}: OfflineCashierProps) {
  const products = useMemo(() => cachedProducts(catalog), [catalog]);
  const availability = useMemo(
    () => new Map(inventory.map((item) => [item.variantId, item.projectedAvailable])),
    [inventory],
  );
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [receipt, setReceipt] = useState<LocalReceipt | null>(null);
  const [recovered, setRecovered] = useState<readonly LocalReceipt[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Durable crash recovery: any locally accepted sale the cashier never acknowledged (e.g. the app
  // died after the SQLite commit but before the receipt was seen) is surfaced here as a specific
  // receipt awaiting acknowledgement — never as an aggregate "pending" count. It must be resolved
  // before ordinary selling resumes so the same economic sale is not rung twice.
  const refreshUnacknowledged = useCallback(async () => {
    const pending = await bridge.getUnacknowledgedSales();
    setRecovered(pending);
  }, [bridge]);

  useEffect(() => {
    // Deferred so the recovery load (which sets state) does not run synchronously in the effect body.
    const initial = window.setTimeout(() => void refreshUnacknowledged(), 0);
    return () => window.clearTimeout(initial);
  }, [refreshUnacknowledged]);
  const selectedProduct = products.find((item) => item.productId === selectedProductId) ?? null;
  const total = cartTotal(cart);

  // The receipt on screen is either the just-completed sale or, on restart, the oldest sale awaiting
  // acknowledgement. A fresh sale takes precedence; otherwise a recovered sale blocks new selling.
  const isRecovery = receipt === null && recovered.length > 0;
  const displayReceipt = receipt ?? recovered[0] ?? null;

  useEffect(() => {
    if (!displayReceipt || displayReceipt.lifecycle !== "accepted_pending_sync") return;
    const timer = window.setInterval(() => {
      void bridge.getLocalReceipt(displayReceipt.localSaleId).then((updated) => {
        if (!updated) return;
        setReceipt((current) =>
          current && current.localSaleId === updated.localSaleId ? updated : current,
        );
        setRecovered((current) =>
          current.map((item) => (item.localSaleId === updated.localSaleId ? updated : item)),
        );
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [bridge, displayReceipt]);

  function openPayment() {
    if (isRecovery) {
      setError("Acknowledge the recovered sale before ringing a new one.");
      return;
    }
    if (cart.length === 0) {
      setError("Add at least one item before checkout.");
      return;
    }
    setError(null);
    setPayOpen(true);
  }

  async function completeOfflineSale(tenders: SaleTender[]) {
    if (isRecovery || cart.length === 0) return;
    setPayOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await bridge.acceptCashSale({
        lines: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        cashReceivedMinor: 0,
        tenders: tenders.map((tender) => ({
          method: tender.method,
          amountMinor: tender.amountMinor,
          ...(tender.cashReceivedMinor !== undefined
            ? { cashReceivedMinor: tender.cashReceivedMinor }
            : {}),
        })),
      });
      const durableReceipt = await bridge.getLocalReceipt(accepted.localSaleId);
      if (!durableReceipt) throw new Error("The accepted local receipt could not be read back.");
      setReceipt(durableReceipt);
      setCart([]);
      await onRefresh();
      await refreshUnacknowledged();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The offline sale could not be accepted.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Acknowledging is what durably records that the cashier saw this specific receipt. Only after it
  // succeeds do we clear the receipt and (for recovery) advance to the next unacknowledged sale.
  async function acknowledgeDisplayed() {
    if (!displayReceipt || acknowledging) return;
    setAcknowledging(true);
    setError(null);
    try {
      await bridge.acknowledgeSale(displayReceipt.localSaleId);
      setReceipt(null);
      await refreshUnacknowledged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The sale could not be acknowledged.");
    } finally {
      setAcknowledging(false);
    }
  }

  if (displayReceipt) {
    const pending = displayReceipt.lifecycle === "accepted_pending_sync";
    const governed = displayReceipt.lifecycle === "needs_reconciliation";
    const attention = governed || syncStatus.blocked > 0;
    return (
      <main className="receipt-shell">
        <section className="receipt-card">
          <div className="success-mark" aria-hidden="true">
            ✓
          </div>
          <p className="eyebrow">{isRecovery ? "Recovered accepted sale" : "Sale accepted"}</p>
          <h1>Receipt {displayReceipt.localReceiptId}</h1>
          {isRecovery ? (
            <p className="receipt-status receipt-status--attention" role="alert">
              This accepted cash sale was interrupted before it was acknowledged. Confirm it below —
              do not ring it again.
              {recovered.length > 1 ? ` ${recovered.length} sales await acknowledgement.` : ""}
            </p>
          ) : (
            <p className={`receipt-status${attention ? " receipt-status--attention" : ""}`}>
              {attention
                ? "Accepted · Synchronization needs attention"
                : pending
                  ? "Saved locally · Pending synchronization"
                  : "Synchronized with Commerce"}
            </p>
          )}
          <div className="receipt-lines">
            {displayReceipt.lines.map((line) => (
              <div key={line.lineNumber} className="receipt-line">
                <div>
                  <strong>{line.productName}</strong>
                  <span>
                    {line.variantName ?? line.optionSummary ?? line.sku} · SKU {line.sku}
                  </span>
                  <span>
                    {line.quantity} × {formatMoney(line.unitPriceMinor, displayReceipt.currency)}
                  </span>
                </div>
                <strong>{formatMoney(line.lineTotalMinor, displayReceipt.currency)}</strong>
              </div>
            ))}
          </div>
          <div className="receipt-totals">
            <div>
              <span>Total</span>
              <strong>{formatMoney(displayReceipt.totalMinor, displayReceipt.currency)}</strong>
            </div>
            <div>
              <span>Cash received</span>
              <strong>
                {formatMoney(displayReceipt.cashReceivedMinor, displayReceipt.currency)}
              </strong>
            </div>
            <div className="receipt-change">
              <span>Change</span>
              <strong>{formatMoney(displayReceipt.changeMinor, displayReceipt.currency)}</strong>
            </div>
            <div>
              <span>Sync state</span>
              <strong>{attention ? "Attention" : pending ? "Pending" : "Synced"}</strong>
            </div>
          </div>
          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="button button--complete"
            disabled={acknowledging}
            onClick={() => void acknowledgeDisplayed()}
          >
            {acknowledging
              ? "Acknowledging…"
              : isRecovery
                ? "Acknowledge recovered sale"
                : "New offline sale"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="pos-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Offline cashier</p>
          <h1>Commerce POS</h1>
        </div>
        <div className="operator-actions">
          <div className="connection-badge" data-state={syncLabel(syncStatus).toLowerCase()}>
            <strong>{syncLabel(syncStatus)}</strong>
            <span>{waitingSyncCount(syncStatus)} waiting</span>
          </div>
          {syncStatus.networkOnline ? (
            <button className="button button--quiet" onClick={onUseConnected}>
              Use connected
            </button>
          ) : null}
          <button className="button button--quiet" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </header>
      <div className="sync-strip">
        <div>
          <button className="button button--quiet" disabled>
            Returns and refunds unavailable offline
          </button>
          <p>
            Connection is required to process a return/refund. Returns cannot be submitted offline.
          </p>
        </div>
        <span>
          Prices are from the installed offline grant. Stock is projected local availability, not
          live server stock.
        </span>
        <button
          className="button button--quiet"
          disabled={!syncStatus.networkOnline || syncStatus.synchronizing}
          onClick={() => void bridge.requestSync().then(onRefresh)}
        >
          {syncStatus.synchronizing ? "Synchronizing…" : "Sync now"}
        </button>
      </div>
      {syncStatus.needsReconciliation + syncStatus.blocked > 0 ? (
        <div className="attention-strip" role="status">
          {syncStatus.needsReconciliation + syncStatus.blocked} accepted sale(s) need management
          attention.
        </div>
      ) : null}
      <div className="workspace">
        <section className="catalog-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Installed catalog</p>
              <h2>Products</h2>
            </div>
            <span className="currency-pill">{currency}</span>
          </div>
          {products.length === 0 ? (
            <p className="inline-state">No cached products are available.</p>
          ) : null}
          <div className="product-grid">
            {products.map((product) => (
              <button
                key={product.productId}
                className={`product-card${selectedProductId === product.productId ? " product-card--selected" : ""}`}
                onClick={() => setSelectedProductId(product.productId)}
              >
                <span>{product.productName}</span>
                <small>
                  {product.variants.length} variant{product.variants.length === 1 ? "" : "s"}
                </small>
              </button>
            ))}
          </div>
          {selectedProduct ? (
            <div className="variant-panel">
              <h3>{selectedProduct.productName}</h3>
              {selectedProduct.variants.map((variant) => {
                const available = availability.get(variant.variantId) ?? 0;
                return (
                  <div className="variant-row" key={variant.variantId}>
                    <div>
                      <strong>{variant.variantName ?? "Standard"}</strong>
                      <span>
                        SKU {variant.sku} · {available} projected available
                      </span>
                    </div>
                    <strong>{formatMoney(variant.unitPriceMinor, currency)}</strong>
                    <button
                      className="button"
                      disabled={available <= 0}
                      onClick={() => setCart((current) => addVariant(current, variant))}
                    >
                      Add
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
        <aside className="checkout-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Local cash sale</p>
              <h2>Cart</h2>
            </div>
            <span>{cart.length} lines</span>
          </div>
          {cart.length === 0 ? (
            <p className="inline-state">Your cart is empty.</p>
          ) : (
            <div className="cart-lines">
              {cart.map((line) => (
                <div className="cart-line" key={line.variantId}>
                  <div className="cart-line__description">
                    <strong>{line.label}</strong>
                    <span>SKU {line.sku}</span>
                    <span>{formatMoney(line.displayedUnitPriceMinor, currency)} each</span>
                  </div>
                  <label>
                    Qty
                    <input
                      aria-label={`Quantity for ${line.label}`}
                      type="number"
                      min="1"
                      step="1"
                      value={line.quantity}
                      disabled={submitting}
                      onChange={(event) =>
                        setCart((current) =>
                          updateQuantity(current, line.variantId, Number(event.target.value)),
                        )
                      }
                    />
                  </label>
                  <strong>
                    {formatMoney(line.quantity * line.displayedUnitPriceMinor, currency)}
                  </strong>
                  <button
                    className="remove-button"
                    disabled={submitting}
                    onClick={() => setCart((current) => removeLine(current, line.variantId))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="total-row">
            <span>Total</span>
            <strong>{formatMoney(total, currency)}</strong>
          </div>
          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="button button--complete"
            disabled={cart.length === 0 || submitting}
            onClick={openPayment}
          >
            {submitting ? "Saving sale…" : "Take payment"}
          </button>
          {payOpen ? (
            <PayModal
              netMinor={total}
              currency={currency}
              submitting={submitting}
              onConfirm={(tenders) => void completeOfflineSale(tenders)}
              onCancel={() => setPayOpen(false)}
            />
          ) : null}
          <p className="authority-note">
            The customer sale completes when the local receipt is saved.
          </p>
        </aside>
      </div>
    </main>
  );
}
