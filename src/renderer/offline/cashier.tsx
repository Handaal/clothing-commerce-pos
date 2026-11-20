import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  CachedCatalogItem,
  LocalReceipt,
  OfflineBridge,
  OfflineCustomer,
  OfflineVoucherPreview,
  OfflineReadiness,
  OfflineSyncStatus,
  ProjectedInventoryItem,
} from "../../shared/offline";
import {
  addVariant,
  cartTotal,
  refreshCartPrices,
  removeLine,
  updateQuantity,
  type CartLine,
} from "../cart/cart";
import { ClearCartButton } from "../cart/ClearCartButton";
import { HeldCartsPanel } from "../cart/HeldCartsPanel";
import { holdCart, listHeldCarts, removeHeldCart, type HeldCart } from "../cart/held";
import { type SellableProduct, type SellableVariant } from "../catalog/catalog";
import { formatDateTime } from "../format";
import { currencySymbol, formatMoney, parseMajorToMinor } from "../money";
import { PayModal, type SaleTender } from "../checkout/PayModal";
import { useI18n } from "../shell/i18n";
import { Icons } from "../shell/icons";
import { KeyShortcut } from "../shell/KeyShortcut";
import { CatalogBrowser } from "../pos/CatalogBrowser";
import { VariantDialog } from "../pos/VariantDialog";
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
  /** Register/branch names when known (the offline grant only carries ids). */
  readonly registerName?: string;
  readonly branchName?: string;
  /** Extra header actions (e.g. clock in/out) placed first, matching the connected register. */
  readonly extraActions?: ReactNode;
  /**
   * Wraps the cashier in the app frame (sidebar + header) so offline selling looks exactly like the
   * connected register. Without it a bare header row is rendered (tests / standalone use).
   */
  readonly renderShell?: (
    headerStart: ReactNode,
    headerActions: ReactNode,
    body: ReactNode,
  ) => ReactNode;
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
  registerName,
  branchName,
  extraActions,
  renderShell,
}: OfflineCashierProps) {
  const { t, locale } = useI18n();
  const currency = readiness.currency;
  const products = useMemo(() => cachedProducts(catalog), [catalog]);
  const availability = useMemo(
    () => new Map(inventory.map((item) => [item.variantId, item.projectedAvailable])),
    [inventory],
  );
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const payButtonRef = useRef<HTMLButtonElement>(null);
  const [heldCarts, setHeldCarts] = useState<readonly HeldCart[]>([]);
  const [heldCartsOpen, setHeldCartsOpen] = useState(false);
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
  // ADR-042 §5: offline voucher against this till's reserved quota. Priced before payment so the tenders
  // match the net total; admin credentials are typed here when the voucher requires them (checked now; no queue).
  const [voucherCode, setVoucherCode] = useState("");
  // The preview is tied to the exact cart it priced; any cart change makes it inactive.
  const [pricedVoucher, setPricedVoucher] = useState<{
    readonly cartKey: string;
    readonly preview: OfflineVoucherPreview;
  } | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [approverName, setApproverName] = useState("");
  const [approverPassword, setApproverPassword] = useState("");
  // ADR-042 §8: capture a new customer (name + phone) while offline.
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerNotice, setNewCustomerNotice] = useState<string | null>(null);

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
  const cartKey = JSON.stringify(cart.map((line) => [line.variantId, line.quantity]));
  const voucherPreview = pricedVoucher?.cartKey === cartKey ? pricedVoucher.preview : null;
  const setVoucherPreview = (preview: OfflineVoucherPreview | null) =>
    setPricedVoucher(preview ? { cartKey, preview } : null);
  const amountDue = voucherPreview ? voucherPreview.netTotalMinor : total;

  async function applyVoucher() {
    const code = voucherCode.trim();
    if (code === "" || cart.length === 0) return;
    setVoucherError(null);
    try {
      setVoucherPreview(
        await bridge.previewOfflineVoucher({
          code,
          lines: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        }),
      );
    } catch (caught) {
      setVoucherPreview(null);
      setVoucherError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function saveNewCustomer() {
    setNewCustomerNotice(null);
    try {
      const created = await bridge.addOfflineCustomer({
        name: newCustomerName,
        phone: newCustomerPhone,
      });
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerOpen(false);
      setNewCustomerNotice(t("offlineCustomer.saved"));
      // The new customer can carry an installment right away; it syncs before the sale does.
      await refreshCustomers();
      setSelectedCustomerId(created.localCustomerId);
    } catch (caught) {
      setNewCustomerNotice(
        t("offlineCustomer.failed", {
          reason: caught instanceof Error ? caught.message : String(caught),
        }),
      );
    }
  }

  // Offline stock is the installed projection; a variant without a row counts as zero (not sellable).
  const catalogStock = new Map(
    products.flatMap((product) =>
      product.variants.map(
        (variant) => [variant.variantId, availability.get(variant.variantId) ?? 0] as const,
      ),
    ),
  );

  function holdCurrentCart() {
    if (cart.length === 0 || submitting) return;
    try {
      holdCart(readiness.registerId, cart);
      setHeldCarts(listHeldCarts(readiness.registerId));
      setCart([]);
      setSelectedCustomerId(null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("cashier.holdFailed"));
    }
  }

  function resumeHeldCart(held: HeldCart) {
    if (cart.length > 0 || submitting) return;
    const restored = refreshCartPrices(held.lines, products);
    if (
      restored.length !== held.lines.length ||
      restored.some((line) => (availability.get(line.variantId) ?? 0) < line.quantity)
    ) {
      setError(t("cashier.heldUnavailable"));
      return;
    }
    setCart(restored);
    removeHeldCart(readiness.registerId, held.id);
    setHeldCarts(listHeldCarts(readiness.registerId));
    setHeldCartsOpen(false);
  }

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
        ...(voucherPreview
          ? {
              voucher: {
                code: voucherCode.trim(),
                ...(voucherPreview.requiresApproval
                  ? { approver: { username: approverName, password: approverPassword } }
                  : {}),
              },
            }
          : {}),
      });
      const durableReceipt = await bridge.getLocalReceipt(accepted.localSaleId);
      if (!durableReceipt) throw new Error("The accepted local receipt could not be read back.");
      setReceipt(durableReceipt);
      setVoucherCode("");
      setVoucherPreview(null);
      setApproverName("");
      setApproverPassword("");
      setCart([]);
      setSelectedCustomerId(null);
      setCustomerQuery("");
      await onRefresh();
      await refreshUnacknowledged();
      await refreshCustomers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("cashier.err.notAccepted"));
    } finally {
      setApproverPassword("");
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

  const waiting = waitingSyncCount(syncStatus);
  const syncKey = syncLabel(syncStatus);
  const needsAttention = syncStatus.needsReconciliation + syncStatus.blocked > 0;
  const offlineDetail = `${t(syncKey)} · ${t("cashier.waiting", { count: waiting })}`;
  // Same header contents and order as the connected register: identity, connection chip, offline
  // chip, then compact actions. Offline-only context (grant + authority notes) lives in tooltips.
  const headerStart = (
    <div className="register-bar">
      <div
        className="register-bar__identity"
        title={branchName ? `${registerName ?? ""} · ${branchName}` : undefined}
      >
        <strong>{registerName ?? t("pos.register")}</strong>
        {branchName ? <span>{branchName}</span> : null}
      </div>
      {/* The one deliberate difference from the connected register: the cashier must always see that
          sales are being saved locally (cached prices, no promotions). */}
      <span
        className="status-chip status-chip--warn"
        title={`${t("cashier.offlineGrantHint")} ${t("cashier.authorityNote")}`}
      >
        {t("cashier.offlineCashier")}
      </span>
      <span
        className={`status-chip ${syncStatus.networkOnline ? "status-chip--good" : "status-chip--bad"}`}
      >
        <span className="status-chip__dot" aria-hidden="true" />
        {syncStatus.networkOnline ? t("pos.connected") : t("pos.disconnected")}
      </span>
      <span
        className={`status-chip ${needsAttention ? "status-chip--warn" : "status-chip--quiet"}`}
        data-state={syncKey}
        title={`${t("cashier.offlineGrantHint")} ${t("cashier.authorityNote")}`}
        role="status"
      >
        {offlineDetail}
        <OfflineRunwayNote readiness={readiness} />
      </span>
    </div>
  );
  const headerActions = (
    <div className="operator-actions">
      {extraActions}
      <button
        className="button button--quiet"
        disabled={!syncStatus.networkOnline || syncStatus.synchronizing}
        onClick={() => void bridge.requestSync().then(onRefresh)}
      >
        {syncStatus.synchronizing ? t("cashier.synchronizing") : t("cashier.syncNow")}
      </button>
      {syncStatus.networkOnline ? (
        <button className="button button--quiet" onClick={onUseConnected}>
          {t("cashier.useConnected")}
        </button>
      ) : null}
      {/* ADR-042 §13: returns are online-only; the action is shown disabled with the reason. */}
      <button
        className="button button--quiet"
        disabled
        aria-disabled="true"
        title={t("cashier.returnsOfflineHint")}
        aria-label={`${t("pos.returns")} — ${t("cashier.returnsOfflineHint")}`}
      >
        {t("pos.returns")}
      </button>
      {renderShell ? null : (
        <button className="button button--quiet" onClick={() => void onSignOut()}>
          {t("nav.signOut")}
        </button>
      )}
    </div>
  );
  const frame = (body: ReactNode) =>
    renderShell ? (
      renderShell(headerStart, headerActions, body)
    ) : (
      <>
        <header className="shell-header">
          <div className="shell-header__start">{headerStart}</div>
          <div className="shell-header__actions">{headerActions}</div>
        </header>
        {body}
      </>
    );
  const remainingFor = (variantId: string) =>
    Math.max(
      0,
      (availability.get(variantId) ?? 0) -
        (cart.find((line) => line.variantId === variantId)?.quantity ?? 0),
    );
  function addToCart(variant: SellableVariant) {
    setCart((current) => {
      const inCart = current.find((line) => line.variantId === variant.variantId)?.quantity ?? 0;
      return inCart >= (availability.get(variant.variantId) ?? 0)
        ? current
        : addVariant(current, variant);
    });
  }

  if (displayReceipt) {
    const pending = displayReceipt.lifecycle === "accepted_pending_sync";
    const governed = displayReceipt.lifecycle === "needs_reconciliation";
    const attention = governed || syncStatus.blocked > 0;
    return frame(
      <div className="receipt-shell">
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
            {(displayReceipt.tenders ?? []).map((tender, index) => (
              <div key={`tender-${index}`} className="receipt-tender-unconfirmed">
                <span>
                  {t(
                    tender.confirmation === "recorded_in_server_ledger"
                      ? "cashier.tenderRecordedServer"
                      : "cashier.tenderRecordedLocally",
                    { method: t(`pay.method.${tender.method}`) },
                  )}
                </span>
                <strong>{formatMoney(tender.amountMinor, displayReceipt.currency, locale)}</strong>
              </div>
            ))}
            {displayReceipt.reconciliationHold ? (
              <div className="receipt-hold" role="status">
                <span>{t(`cashier.hold.${displayReceipt.reconciliationHold}`)}</span>
              </div>
            ) : null}
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
      </div>,
    );
  }

  return frame(
    <div className="pos-shell">
      {needsAttention ? (
        <div className="attention-strip" role="status">
          {t("cashier.needAttention", {
            count: syncStatus.needsReconciliation + syncStatus.blocked,
          })}
        </div>
      ) : null}
      <div className="workspace">
        <section className="catalog-panel">
          <div className="section-heading">
            <h2>{t("pos.products")}</h2>
            <span className="currency-pill">{currencySymbol(currency, locale)}</span>
          </div>
          <CatalogBrowser
            products={products}
            stockByVariant={catalogStock}
            currency={currency}
            disabled={products.length === 0}
            captureKeys={!submitting && !payOpen && !paymentOpen}
            selectedProductId={selectedProductId}
            onSelectProduct={setSelectedProductId}
            onScanMatch={(variant) => {
              if (submitting) return;
              addToCart(variant);
              setSelectedProductId(null);
            }}
            emptyNotice={<p className="inline-state">{t("cashier.noCached")}</p>}
          />
          {selectedProduct ? (
            <VariantDialog
              product={selectedProduct}
              stockByVariant={
                new Map(
                  selectedProduct.variants.map((variant) => [
                    variant.variantId,
                    remainingFor(variant.variantId),
                  ]),
                )
              }
              submitting={submitting}
              onAdd={addToCart}
              onClose={() => setSelectedProductId(null)}
            />
          ) : null}
        </section>

        <aside className="checkout-panel">
          <div className="cart-head">
            <div className="cart-head__title">
              <h2>{t("cashier.cart")}</h2>
              <span className="cart-head__count">{t("cashier.lines", { count: cart.length })}</span>
            </div>
            <div className="cart-head__actions">
              <ClearCartButton
                disabled={cart.length === 0 || submitting}
                onClear={() => {
                  if (submitting) return;
                  setCart([]);
                  setSelectedCustomerId(null);
                  setError(null);
                }}
              />
              <button
                className="chip-button"
                disabled={cart.length === 0 || submitting}
                onClick={holdCurrentCart}
              >
                {t("cashier.holdCart")}
              </button>
              <button
                className="chip-button"
                onClick={() => {
                  setHeldCarts(listHeldCarts(readiness.registerId));
                  setHeldCartsOpen(true);
                }}
              >
                {t("cashier.heldCarts")}
              </button>
            </div>
          </div>
          <div className="cart-body">
            {cart.length === 0 ? (
              <p className="inline-state">{t("cashier.cartEmpty")}</p>
            ) : (
              <div className="cart-lines">
                {cart.map((line) => {
                  const available = availability.get(line.variantId) ?? 0;
                  return (
                    <div className="cart-item" key={line.variantId}>
                      <div className="cart-item__top">
                        <strong title={t("cashier.sku", { sku: line.sku })}>{line.label}</strong>
                        <button
                          className="cart-item__remove"
                          aria-label={t("pos.removeLine", { label: line.label })}
                          title={t("cashier.remove")}
                          disabled={submitting}
                          onClick={() => setCart((current) => removeLine(current, line.variantId))}
                        >
                          <Icons.trash />
                        </button>
                      </div>
                      <div className="cart-item__bottom">
                        <div className="qty-stepper">
                          <button
                            type="button"
                            aria-label={t("cashier.decreaseQty", { label: line.label })}
                            disabled={submitting || line.quantity <= 1}
                            onClick={() =>
                              setCart((current) =>
                                updateQuantity(current, line.variantId, line.quantity - 1),
                              )
                            }
                          >
                            <Icons.minus />
                          </button>
                          <input
                            aria-label={t("cashier.qtyFor", { label: line.label })}
                            type="number"
                            min="1"
                            max={available}
                            step="1"
                            value={line.quantity}
                            disabled={submitting}
                            onWheel={(event) => event.currentTarget.blur()}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              if (next > available) return;
                              setCart((current) => updateQuantity(current, line.variantId, next));
                            }}
                          />
                          <button
                            type="button"
                            aria-label={t("cashier.increaseQty", { label: line.label })}
                            disabled={submitting || line.quantity >= available}
                            onClick={() =>
                              setCart((current) =>
                                updateQuantity(current, line.variantId, line.quantity + 1),
                              )
                            }
                          >
                            <Icons.plus />
                          </button>
                        </div>
                        <span className="cart-item__unit">
                          × {formatMoney(line.displayedUnitPriceMinor, currency, locale)}
                        </span>
                        <strong className="cart-item__total">
                          {formatMoney(
                            line.quantity * line.displayedUnitPriceMinor,
                            currency,
                            locale,
                          )}
                        </strong>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {heldCartsOpen ? (
            <HeldCartsPanel
              carts={heldCarts}
              currency={currency}
              canResume={cart.length === 0 && !submitting}
              onResume={resumeHeldCart}
              onDelete={(id) => {
                removeHeldCart(readiness.registerId, id);
                setHeldCarts(listHeldCarts(readiness.registerId));
              }}
              onClose={() => setHeldCartsOpen(false)}
            />
          ) : null}
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
                  <button
                    className="button button--quiet"
                    data-testid="offline-new-customer"
                    disabled={submitting}
                    onClick={() => setNewCustomerOpen((open) => !open)}
                  >
                    {t("offlineCustomer.add")}
                  </button>
                  {newCustomerOpen ? (
                    <div className="offline-customer__new">
                      <label>
                        {t("offlineCustomer.name")}
                        <input
                          value={newCustomerName}
                          onChange={(event) => setNewCustomerName(event.target.value)}
                        />
                      </label>
                      <label>
                        {t("offlineCustomer.phone")}
                        <input
                          inputMode="tel"
                          value={newCustomerPhone}
                          onChange={(event) => setNewCustomerPhone(event.target.value)}
                        />
                      </label>
                      <button
                        className="button"
                        data-testid="offline-new-customer-save"
                        disabled={newCustomerName.trim() === "" || newCustomerPhone.trim() === ""}
                        onClick={() => void saveNewCustomer()}
                      >
                        {t("offlineCustomer.save")}
                      </button>
                    </div>
                  ) : null}
                  {newCustomerNotice ? (
                    <p className="inline-state" data-testid="offline-new-customer-notice">
                      {newCustomerNotice}
                    </p>
                  ) : null}
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
                            {item.createdOffline ? (
                              <span data-testid="offline-customer-new-tag">
                                {item.pendingSync
                                  ? t("offlineCustomer.pendingSync")
                                  : t("offlineCustomer.synced")}
                              </span>
                            ) : null}
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
          {/* ADR-042 §5: only vouchers this till holds offline quota for can be used here. */}
          <div className="promotion-panel">
            <div className="promotion-code-row">
              <label className="promotion-code-field">
                <input
                  aria-label={t("offlineVoucher.label")}
                  placeholder={t("offlineVoucher.placeholder")}
                  type="text"
                  value={voucherCode}
                  disabled={submitting || cart.length === 0}
                  onChange={(event) => {
                    setVoucherCode(event.target.value);
                    setVoucherPreview(null);
                    setVoucherError(null);
                  }}
                />
              </label>
              {voucherPreview ? (
                <button
                  className="button"
                  disabled={submitting}
                  onClick={() => {
                    setVoucherCode("");
                    setVoucherPreview(null);
                  }}
                >
                  {t("offlineVoucher.clear")}
                </button>
              ) : (
                <button
                  className="button"
                  disabled={submitting || cart.length === 0 || voucherCode.trim() === ""}
                  onClick={() => void applyVoucher()}
                >
                  {t("offlineVoucher.apply")}
                </button>
              )}
            </div>
            {voucherError ? (
              <p className="notice notice--error" role="alert" data-testid="offline-voucher-error">
                {voucherError}
              </p>
            ) : null}
            {voucherPreview?.requiresApproval ? (
              <fieldset className="approval" data-testid="offline-voucher-approval">
                <legend>{t("approval.title")}</legend>
                <p>
                  {t("offlineVoucher.needsApproval")} {t("approval.note")}
                </p>
                <label>
                  {t("approval.username")}
                  <input
                    value={approverName}
                    autoComplete="off"
                    onChange={(event) => setApproverName(event.target.value)}
                  />
                </label>
                <label>
                  {t("approval.password")}
                  <input
                    type="password"
                    value={approverPassword}
                    autoComplete="off"
                    onChange={(event) => setApproverPassword(event.target.value)}
                  />
                </label>
              </fieldset>
            ) : null}
          </div>
          <div className="total-row">
            <span>{t("pos.grossSubtotal")}</span>
            <strong>{formatMoney(total, currency, locale)}</strong>
          </div>
          {voucherPreview ? (
            <div className="total-row" data-testid="offline-voucher-discount">
              <span>
                {t("offlineVoucher.discount")} ({voucherPreview.label})
              </span>
              <strong>−{formatMoney(voucherPreview.discountTotalMinor, currency, locale)}</strong>
            </div>
          ) : null}
          {voucherPreview?.policy ? (
            <p className="muted" data-testid="offline-voucher-freshness">
              {t("offlineVoucher.freshness", {
                fetched: formatDateTime(voucherPreview.policy.fetchedAt, locale),
                remaining:
                  voucherPreview.policy.remainingAtFetch === null
                    ? t("offlineVoucher.noLimit")
                    : String(
                        voucherPreview.policy.remainingAtFetch -
                          voucherPreview.policy.localUsesSinceFetch,
                      ),
              })}{" "}
              {t("offlineVoucher.provisional")}
            </p>
          ) : null}
          <div className="total-row total-row--due">
            <span>{t("pay.amountDue")}</span>
            <strong>{formatMoney(amountDue, currency, locale)}</strong>
          </div>
          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="button button--complete"
            disabled={
              cart.length === 0 ||
              submitting ||
              (voucherPreview?.requiresApproval === true &&
                (approverName.trim() === "" || approverPassword === ""))
            }
            onClick={openPayment}
            ref={payButtonRef}
          >
            {submitting ? t("cashier.savingSale") : t("cashier.takePayment")}
            {!submitting ? (
              <kbd className="key-hint" aria-hidden="true">
                F12
              </kbd>
            ) : null}
          </button>
          {/* F12 = Take payment; clicking a disabled button is a no-op, so its rules apply. */}
          <KeyShortcut keyName="F12" onTrigger={() => payButtonRef.current?.click()} />
          {payOpen ? (
            <PayModal
              netMinor={amountDue}
              currency={currency}
              submitting={submitting}
              disableFreeformCustomer
              offlineTenderNotice
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
        </aside>
      </div>
    </div>,
  );
}
