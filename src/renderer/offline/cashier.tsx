import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CachedCatalogItem,
  LocalReceipt,
  OfflineBridge,
  OfflineCustomer,
  OfflineReadiness,
  OfflineSyncStatus,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { addVariant, cartTotal, removeLine, updateQuantity, type CartLine } from "../cart/cart";
import { groupByCategory, type SellableProduct, type SellableVariant } from "../catalog/catalog";
import { currencySymbol, formatMoney, parseMajorToMinor } from "../money";
import { PayModal, type SaleTender } from "../checkout/PayModal";
import { useI18n } from "../shell/i18n";
import { OfflineRunwayNote } from "./OfflineRunwayNote";

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
        brandId: item.brandId,
        brandName: item.brandName,
        categories: item.categories,
        variants: [variant],
      });
    }
  }
  return [...products.values()];
}

// Returns the i18n key for the cashier's current sync state. The component resolves it through `t`,
// so the badge is localized; callers that need a stable slug (e.g. a `data-state` hook) can use the
// key directly since keys never change with language.
export function syncLabel(status: OfflineSyncStatus): string {
  if (status.needsReconciliation > 0) return "cashier.sync.needsAttention";
  if (status.blocked > 0) return "cashier.sync.blocked";
  if (status.synchronizing || status.leased > 0) return "cashier.sync.synchronizing";
  if (status.pending + status.retryWait > 0) return "cashier.sync.pending";
  if (status.synced > 0) return "cashier.sync.allSynced";
  return status.networkOnline ? "cashier.sync.connected" : "cashier.sync.offlineReady";
}

export function waitingSyncCount(status: OfflineSyncStatus): number {
  return status.pending + status.leased + status.retryWait;
}

interface OfflineCashierProps {
  readonly bridge: OfflineBridge;
  // The active, ready grant. Carries the currency and the accept/catalog windows the runway note
  // derives its countdown from, so a PIN-only operator sees the same runway the connected shell does.
  readonly readiness: Extract<OfflineReadiness, { ready: true }>;
  readonly catalog: readonly CachedCatalogItem[];
  readonly inventory: readonly ProjectedInventoryItem[];
  readonly syncStatus: OfflineSyncStatus;
  readonly onRefresh: () => Promise<void>;
  readonly onUseConnected: () => void;
  readonly onSignOut: () => Promise<void>;
}

export function OfflineCashier({
  bridge,
  readiness,
  catalog,
  inventory,
  syncStatus,
  onRefresh,
  onUseConnected,
  onSignOut,
}: OfflineCashierProps) {
  const { t, locale } = useI18n();
  const currency = readiness.currency;
  const products = useMemo(() => cachedProducts(catalog), [catalog]);
  const availability = useMemo(
    () => new Map(inventory.map((item) => [item.variantId, item.projectedAvailable])),
    [inventory],
  );
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [customers, setCustomers] = useState<readonly OfflineCustomer[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
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

  // Offline search matches product name, brand, and any variant SKU/name — the same fields the
  // connected register searches, so the floor's muscle memory carries over when the link drops.
  const normalizedQuery = catalogQuery.trim().toLowerCase();
  const filteredProducts =
    normalizedQuery === ""
      ? products
      : products.filter(
          (product) =>
            product.productName.toLowerCase().includes(normalizedQuery) ||
            (product.brandName?.toLowerCase().includes(normalizedQuery) ?? false) ||
            product.variants.some(
              (variant) =>
                variant.sku.toLowerCase().includes(normalizedQuery) ||
                (variant.variantName?.toLowerCase().includes(normalizedQuery) ?? false),
            ),
        );
  const groupedCatalog = groupByCategory(filteredProducts, t("pos.uncategorized"));

  const installmentsAvailable = readiness.offlineInstallmentsAvailable;
  const refreshCustomers = useCallback(async () => {
    if (!installmentsAvailable) return;
    setCustomers(await bridge.getOfflineCustomers());
  }, [bridge, installmentsAvailable]);
  useEffect(() => {
    // Deferred so the load (which sets state) does not run synchronously in the effect body.
    const initial = window.setTimeout(() => void refreshCustomers(), 0);
    return () => window.clearTimeout(initial);
  }, [refreshCustomers]);
  const selectedCustomer = useMemo(
    () => customers.find((item) => item.customerId === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );
  const filteredCustomers = useMemo(() => {
    const query = customerQuery.trim().toLowerCase();
    const matches =
      query === ""
        ? customers
        : customers.filter(
            (item) =>
              item.name.toLowerCase().includes(query) || item.phone.includes(customerQuery.trim()),
          );
    return matches.slice(0, 8);
  }, [customers, customerQuery]);

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
      setError(t("cashier.err.ackFirst"));
      return;
    }
    if (cart.length === 0) {
      setError(t("cashier.err.addItem"));
      return;
    }
    setError(null);
    setPayOpen(true);
  }

  async function completeOfflineSale(tenders: SaleTender[], amountPaidMinor?: number) {
    if (isRecovery || cart.length === 0) return;
    const installment = amountPaidMinor !== undefined && selectedCustomer !== null;
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
        ...(installment ? { customerId: selectedCustomer!.customerId, amountPaidMinor } : {}),
      });
      const durableReceipt = await bridge.getLocalReceipt(accepted.localSaleId);
      if (!durableReceipt) throw new Error("The accepted local receipt could not be read back.");
      setReceipt(durableReceipt);
      setCart([]);
      setSelectedCustomerId(null);
      setCustomerQuery("");
      await onRefresh();
      await refreshUnacknowledged();
      await refreshCustomers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("cashier.err.notAccepted"));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPayment() {
    if (!selectedCustomer) return;
    const amountMinor = parseMajorToMinor(paymentAmount);
    if (amountMinor === null || amountMinor <= 0) {
      setPaymentNotice(t("cashier.payment.invalid"));
      return;
    }
    if (amountMinor > selectedCustomer.projectedOutstandingMinor) {
      setPaymentNotice(t("cashier.payment.exceeds"));
      return;
    }
    setPaymentSubmitting(true);
    setPaymentNotice(null);
    try {
      await bridge.recordCustomerPayment({ customerId: selectedCustomer.customerId, amountMinor });
      setPaymentOpen(false);
      setPaymentAmount("");
      setSelectedCustomerId(null);
      setCustomerQuery("");
      await refreshCustomers();
      await onRefresh();
    } catch (caught) {
      setPaymentNotice(caught instanceof Error ? caught.message : t("cashier.payment.failed"));
    } finally {
      setPaymentSubmitting(false);
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
      setError(caught instanceof Error ? caught.message : t("cashier.err.notAcked"));
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
          <p className="eyebrow">
            {isRecovery ? t("cashier.receipt.recovered") : t("cashier.receipt.accepted")}
          </p>
          <h1>{t("cashier.receipt.title", { id: displayReceipt.localReceiptId })}</h1>
          {isRecovery ? (
            <p className="receipt-status receipt-status--attention" role="alert">
              {t("cashier.receipt.interrupted")}
              {recovered.length > 1
                ? ` ${t("cashier.receipt.awaiting", { count: recovered.length })}`
                : ""}
            </p>
          ) : (
            <p className={`receipt-status${attention ? " receipt-status--attention" : ""}`}>
              {attention
                ? t("cashier.receipt.statusAttention")
                : pending
                  ? t("cashier.receipt.statusPending")
                  : t("cashier.receipt.statusSynced")}
            </p>
          )}
          <div className="receipt-lines">
            {displayReceipt.lines.map((line) => (
              <div key={line.lineNumber} className="receipt-line">
                <div>
                  <strong>{line.productName}</strong>
                  <span>
                    {line.variantName ?? line.optionSummary ?? line.sku} ·{" "}
                    {t("cashier.sku", { sku: line.sku })}
                  </span>
                  <span>
                    {line.quantity} ×{" "}
                    {formatMoney(line.unitPriceMinor, displayReceipt.currency, locale)}
                  </span>
                </div>
                <strong>{formatMoney(line.lineTotalMinor, displayReceipt.currency, locale)}</strong>
              </div>
            ))}
          </div>
          <div className="receipt-totals">
            <div>
              <span>{t("cashier.total")}</span>
              <strong>
                {formatMoney(displayReceipt.totalMinor, displayReceipt.currency, locale)}
              </strong>
            </div>
            {displayReceipt.outstandingMinor > 0 ? (
              <>
                <div>
                  <span>{t("cashier.amountPaid")}</span>
                  <strong>
                    {formatMoney(displayReceipt.amountPaidMinor, displayReceipt.currency, locale)}
                  </strong>
                </div>
                <div className="receipt-balance">
                  <span>
                    {displayReceipt.customerName
                      ? t("cashier.balanceOwedBy", { name: displayReceipt.customerName })
                      : t("cashier.balanceOwed")}
                  </span>
                  <strong>
                    {formatMoney(displayReceipt.outstandingMinor, displayReceipt.currency, locale)}
                  </strong>
                </div>
              </>
            ) : null}
            <div>
              <span>{t("cashier.cashReceived")}</span>
              <strong>
                {formatMoney(displayReceipt.cashReceivedMinor, displayReceipt.currency, locale)}
              </strong>
            </div>
            <div className="receipt-change">
              <span>{t("cashier.change")}</span>
              <strong>
                {formatMoney(displayReceipt.changeMinor, displayReceipt.currency, locale)}
              </strong>
            </div>
            <div>
              <span>{t("cashier.syncState")}</span>
              <strong>
                {attention
                  ? t("cashier.state.attention")
                  : pending
                    ? t("cashier.state.pending")
                    : t("cashier.state.synced")}
              </strong>
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
              ? t("cashier.acknowledging")
              : isRecovery
                ? t("cashier.ackRecovered")
                : t("cashier.newSale")}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="pos-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{t("cashier.offlineCashier")}</p>
          <h1>{t("app.name")}</h1>
        </div>
        <div className="operator-actions">
          <div className="connection-badge" data-state={syncLabel(syncStatus)}>
            <strong>{t(syncLabel(syncStatus))}</strong>
            <span>{t("cashier.waiting", { count: waitingSyncCount(syncStatus) })}</span>
          </div>
          {syncStatus.networkOnline ? (
            <button className="button button--quiet" onClick={onUseConnected}>
              {t("cashier.useConnected")}
            </button>
          ) : null}
          <button className="button button--quiet" onClick={() => void onSignOut()}>
            {t("nav.signOut")}
          </button>
        </div>
      </header>
      <div className="sync-strip">
        <div>
          <button className="button button--quiet" disabled>
            {t("cashier.returnsOffline")}
          </button>
          <p>{t("cashier.returnsOfflineHint")}</p>
        </div>
        <span>
          {t("cashier.offlineGrantHint")}
          <OfflineRunwayNote readiness={readiness} />
        </span>
        <button
          className="button button--quiet"
          disabled={!syncStatus.networkOnline || syncStatus.synchronizing}
          onClick={() => void bridge.requestSync().then(onRefresh)}
        >
          {syncStatus.synchronizing ? t("cashier.synchronizing") : t("cashier.syncNow")}
        </button>
      </div>
      {syncStatus.needsReconciliation + syncStatus.blocked > 0 ? (
        <div className="attention-strip" role="status">
          {t("cashier.needAttention", {
            count: syncStatus.needsReconciliation + syncStatus.blocked,
          })}
        </div>
      ) : null}
      <div className="workspace">
        <section className="catalog-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t("cashier.installedCatalog")}</p>
              <h2>{t("cashier.products")}</h2>
            </div>
            <span className="currency-pill">{currency}</span>
          </div>
          {products.length === 0 ? <p className="inline-state">{t("cashier.noCached")}</p> : null}
          {products.length > 0 ? (
            <div className="catalog-search">
              <input
                className="catalog-search__input"
                aria-label={t("pos.searchAria")}
                placeholder={t("pos.searchPlaceholder")}
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
              />
              {catalogQuery !== "" ? (
                <button
                  type="button"
                  className="catalog-search__clear"
                  aria-label={t("pos.clearSearch")}
                  onClick={() => setCatalogQuery("")}
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : null}
          {products.length > 0 && filteredProducts.length === 0 ? (
            <p className="inline-state">{t("pos.noMatch", { query: catalogQuery })}</p>
          ) : null}
          {groupedCatalog.map((group) => (
            <div className="catalog-group" key={group.category}>
              <p className="catalog-group__heading">{group.category}</p>
              <div className="product-grid">
                {group.products.map((product) => (
                  <button
                    key={product.productId}
                    className={`product-card${selectedProductId === product.productId ? " product-card--selected" : ""}`}
                    onClick={() => setSelectedProductId(product.productId)}
                  >
                    <span>{product.productName}</span>
                    {product.brandName ? (
                      <span className="product-card__brand">{product.brandName}</span>
                    ) : null}
                    <small>{t("cashier.variantCount", { count: product.variants.length })}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {selectedProduct ? (
            <div className="variant-panel">
              <h3>{selectedProduct.productName}</h3>
              {selectedProduct.variants.map((variant) => {
                const available = availability.get(variant.variantId) ?? 0;
                return (
                  <div className="variant-row" key={variant.variantId}>
                    <div>
                      <strong>{variant.variantName ?? t("cashier.standard")}</strong>
                      <span>
                        {t("cashier.sku", { sku: variant.sku })} ·{" "}
                        {t("cashier.projectedAvailable", { count: available })}
                      </span>
                    </div>
                    <strong>{formatMoney(variant.unitPriceMinor, currency, locale)}</strong>
                    <button
                      className="button"
                      disabled={available <= 0}
                      onClick={() => setCart((current) => addVariant(current, variant))}
                    >
                      {t("cashier.add")}
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
              <p className="eyebrow">{t("cashier.localCashSale")}</p>
              <h2>{t("cashier.cart")}</h2>
            </div>
            <span>{t("cashier.lines", { count: cart.length })}</span>
          </div>
          {cart.length === 0 ? (
            <p className="inline-state">{t("cashier.cartEmpty")}</p>
          ) : (
            <div className="cart-lines">
              {cart.map((line) => (
                <div className="cart-line" key={line.variantId}>
                  <div className="cart-line__description">
                    <strong>{line.label}</strong>
                    <span>{t("cashier.sku", { sku: line.sku })}</span>
                    <span>
                      {t("cashier.each", {
                        price: formatMoney(line.displayedUnitPriceMinor, currency, locale),
                      })}
                    </span>
                  </div>
                  <label>
                    {t("cashier.qty")}
                    <input
                      aria-label={t("cashier.qtyFor", { label: line.label })}
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
                    {formatMoney(line.quantity * line.displayedUnitPriceMinor, currency, locale)}
                  </strong>
                  <button
                    className="remove-button"
                    disabled={submitting}
                    onClick={() => setCart((current) => removeLine(current, line.variantId))}
                  >
                    {t("cashier.remove")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="total-row">
            <span>{t("cashier.total")}</span>
            <strong>{formatMoney(total, currency, locale)}</strong>
          </div>
          {installmentsAvailable ? (
            <div className="offline-customer">
              <div className="offline-customer__heading">
                <span className="eyebrow">{t("cashier.installmentCustomer")}</span>
                <span>
                  {t("cashier.creditRemaining", {
                    amount: formatMoney(readiness.offlineCreditRemainingMinor, currency, locale),
                  })}
                </span>
              </div>
              {selectedCustomer ? (
                <div className="offline-customer__selected">
                  <div>
                    <strong>{selectedCustomer.name}</strong>
                    <span>{selectedCustomer.phone}</span>
                    <span>
                      {t("cashier.customerBalance", {
                        amount: formatMoney(
                          selectedCustomer.projectedOutstandingMinor,
                          currency,
                          locale,
                        ),
                      })}
                    </span>
                  </div>
                  <div className="offline-customer__actions">
                    <button
                      className="button button--quiet"
                      disabled={submitting || selectedCustomer.projectedOutstandingMinor <= 0}
                      onClick={() => {
                        setPaymentAmount("");
                        setPaymentNotice(null);
                        setPaymentOpen(true);
                      }}
                    >
                      {t("cashier.recordPayment")}
                    </button>
                    <button
                      className="button button--quiet"
                      disabled={submitting}
                      onClick={() => {
                        setSelectedCustomerId(null);
                        setCustomerQuery("");
                      }}
                    >
                      {t("cashier.customerClear")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <input
                    aria-label={t("cashier.customerSearch")}
                    placeholder={t("cashier.customerSearch")}
                    value={customerQuery}
                    disabled={submitting}
                    onChange={(event) => setCustomerQuery(event.target.value)}
                  />
                  {customerQuery.trim() !== "" ? (
                    <div className="offline-customer__results">
                      {filteredCustomers.length === 0 ? (
                        <p className="inline-state">{t("cashier.customerNone")}</p>
                      ) : (
                        filteredCustomers.map((item) => (
                          <button
                            key={item.customerId}
                            className="offline-customer__option"
                            disabled={submitting}
                            onClick={() => {
                              setSelectedCustomerId(item.customerId);
                              setCustomerQuery("");
                            }}
                          >
                            <strong>{item.name}</strong>
                            <span>{item.phone}</span>
                            <span>
                              {formatMoney(item.projectedOutstandingMinor, currency, locale)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
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
            {submitting ? t("cashier.savingSale") : t("cashier.takePayment")}
          </button>
          {payOpen ? (
            <PayModal
              netMinor={total}
              currency={currency}
              submitting={submitting}
              disableFreeformCustomer
              presetCustomer={
                selectedCustomer
                  ? {
                      name: selectedCustomer.name,
                      phone: selectedCustomer.phone,
                      balanceMinor: selectedCustomer.projectedOutstandingMinor,
                    }
                  : undefined
              }
              onConfirm={(tenders, _customer, amountPaidMinor) =>
                void completeOfflineSale(tenders, amountPaidMinor)
              }
              onCancel={() => setPayOpen(false)}
            />
          ) : null}
          {paymentOpen && selectedCustomer ? (
            <div
              className="modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-label={t("cashier.recordPayment")}
            >
              <div className="modal-card pay-modal">
                <p className="eyebrow">{t("cashier.recordPayment")}</p>
                <div className="pay-customer__preset">
                  <strong>{selectedCustomer.name}</strong>
                  <span>{selectedCustomer.phone}</span>
                  <span>
                    {t("cashier.customerBalance", {
                      amount: formatMoney(
                        selectedCustomer.projectedOutstandingMinor,
                        currency,
                        locale,
                      ),
                    })}
                  </span>
                </div>
                <label className="cash-field">
                  {t("cashier.payment.amount")} <span>{currencySymbol(currency, locale)}</span>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={paymentAmount}
                    disabled={paymentSubmitting}
                    onChange={(event) => setPaymentAmount(event.target.value)}
                  />
                </label>
                {paymentNotice ? (
                  <div className="notice notice--error" role="alert">
                    {paymentNotice}
                  </div>
                ) : null}
                <div className="pay-actions">
                  <button
                    className="button button--quiet"
                    disabled={paymentSubmitting}
                    onClick={() => setPaymentOpen(false)}
                  >
                    {t("pay.cancel")}
                  </button>
                  <button
                    className="button button--complete"
                    disabled={paymentSubmitting}
                    onClick={() => void submitPayment()}
                  >
                    {paymentSubmitting ? t("pay.completing") : t("cashier.payment.confirm")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <p className="authority-note">{t("cashier.authorityNote")}</p>
        </aside>
      </div>
    </main>
  );
}
