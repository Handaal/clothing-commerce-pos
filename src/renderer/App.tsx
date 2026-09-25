import { SignIn, useAuth, useClerk } from "@clerk/react";
import type {
  CommerceClient,
  CreatePosSaleResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  CachedCatalogItem,
  OfflineBridge,
  OfflineReadiness,
  OfflineSyncStatus,
  ProjectedInventoryItem,
} from "../shared/offline";

import {
  addVariant,
  cartTotal,
  refreshCartPrices,
  removeLine,
  updateQuantity,
  type CartLine,
} from "./cart/cart";
import { loadSellableCatalog, type SellableProduct, type SellableVariant } from "./catalog/catalog";
import { SaleExecutor, type SaleExecutionState } from "./checkout/sale-executor";
import { createConfiguredCommerceClient, type CommerceClientFactory } from "./commerce/client";
import { classifyCommerceError, type CommerceErrorView } from "./commerce/errors";
import { formatMoney } from "./money";
import { QuoteController, type QuoteState } from "./promotions/quote";
import { OfflineCashier, syncLabel, waitingSyncCount } from "./offline/cashier";
import { resolveRegisters, type PosRegister } from "./pos/context";
import { bootstrapTenants, type Tenant } from "./session/tenant";
import { ReturnDesk } from "./returns/ReturnDesk";
import type { ReturnsBridge } from "../shared/returns";

export interface PosAuth {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionId: string | null;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<unknown>;
}

interface PosApplicationProps {
  auth: PosAuth;
  signedOutContent?: ReactNode;
  clientFactory?: CommerceClientFactory;
  createKey?: () => string;
  offlineBridge?: OfflineBridge;
  returnsBridge?: ReturnsBridge;
}

type LoadPhase = "idle" | "loading" | "ready" | "choosing" | "empty" | "error";

export function App() {
  const { isLoaded, isSignedIn, userId, sessionId, getToken } = useAuth();
  const clerk = useClerk();
  return (
    <PosApplication
      auth={{
        isLoaded,
        isSignedIn: isSignedIn === true,
        userId: userId ?? null,
        sessionId: sessionId ?? null,
        getToken: async () => (await getToken()) ?? null,
        signOut: () => clerk.signOut(),
      }}
      signedOutContent={<SignIn routing="hash" />}
    />
  );
}

export function PosApplication({
  auth,
  signedOutContent,
  clientFactory = createConfiguredCommerceClient,
  createKey,
  offlineBridge = typeof window === "undefined" ? undefined : window.offline,
  returnsBridge = typeof window === "undefined" ? undefined : window.returns,
}: PosApplicationProps) {
  const tokenRef = useRef(auth.getToken);
  useEffect(() => {
    tokenRef.current = auth.getToken;
  });
  const [client, setClient] = useState<CommerceClient | null>(null);
  useEffect(() => {
    // The SDK client is an external session boundary and is intentionally composed after render.
    setClient(clientFactory({ getToken: () => tokenRef.current() }));
  }, [clientFactory]);
  const [executor] = useState(() => new SaleExecutor(createKey));
  const [saleState, setSaleState] = useState<SaleExecutionState>(executor.snapshot());

  const [tenantPhase, setTenantPhase] = useState<LoadPhase>("idle");
  const [tenants, setTenants] = useState<readonly Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantError, setTenantError] = useState<CommerceErrorView | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);

  const [contextPhase, setContextPhase] = useState<LoadPhase>("idle");
  const [registers, setRegisters] = useState<readonly PosRegister[]>([]);
  const [registerId, setRegisterId] = useState<string | null>(null);
  const [contextError, setContextError] = useState<CommerceErrorView | null>(null);
  const [contextNonce, setContextNonce] = useState(0);

  const [catalogPhase, setCatalogPhase] = useState<LoadPhase>("idle");
  const [products, setProducts] = useState<readonly SellableProduct[]>([]);
  const [catalogError, setCatalogError] = useState<CommerceErrorView | null>(null);
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [cashReceived, setCashReceived] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [quoteController] = useState(() => new QuoteController());
  const [quoteState, setQuoteState] = useState<QuoteState>(quoteController.snapshot());
  const [codeDraft, setCodeDraft] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [priceConfirmationRequired, setPriceConfirmationRequired] = useState(false);
  const [priceChangedTotal, setPriceChangedTotal] = useState<number | null>(null);
  const [priceRefreshPending, setPriceRefreshPending] = useState(false);
  const [sellingMode, setSellingMode] = useState<"connected" | "offline">("connected");
  const [showReturns, setShowReturns] = useState(false);
  const [returnLocked, setReturnLocked] = useState(false);
  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn || !returnsBridge) return;
    let active = true;
    void returnsBridge
      .hasPending()
      .then((exists) => {
        if (active && exists) setShowReturns(true);
      })
      .catch(() => {
        if (active) setShowReturns(true);
      });
    return () => {
      active = false;
    };
  }, [auth.isLoaded, auth.isSignedIn, auth.sessionId, returnsBridge]);
  const [offlineReadiness, setOfflineReadiness] = useState<OfflineReadiness>({
    ready: false,
    reason: "NOT_INITIALIZED",
    message: "Checking offline availability.",
  });
  const [syncStatus, setSyncStatus] = useState<OfflineSyncStatus>({
    pending: 0,
    leased: 0,
    retryWait: 0,
    blocked: 0,
    synced: 0,
    needsReconciliation: 0,
    networkOnline: false,
    synchronizing: false,
    lastAttemptAt: null,
    lastError: null,
  });
  const [offlineCatalog, setOfflineCatalog] = useState<readonly CachedCatalogItem[]>([]);
  const [projectedInventory, setProjectedInventory] = useState<readonly ProjectedInventoryItem[]>(
    [],
  );
  const [offlineActionPending, setOfflineActionPending] = useState(false);
  const [offlineActionMessage, setOfflineActionMessage] = useState<string | null>(null);

  const tenantClient = useMemo<TenantCommerceClient | null>(
    () => (tenantId && client ? client.withTenant(tenantId) : null),
    [client, tenantId],
  );
  const register = registers.find((item) => item.registerId === registerId) ?? null;
  const clientGross = cartTotal(cart);

  // The server quote is authoritative. Until a fresh quote is ready the client sum is shown only as a
  // non-tenderable preview; tender and checkout are gated on `quoteReady` below.
  const quote = quoteState.status === "ready" ? quoteState.quote : null;
  const quoteReady = quote !== null;
  const grossMinor = quote ? quote.grossSubtotalMinor : clientGross;
  const discountMinor = quote ? quote.discountTotalMinor : 0;
  const netMinor = quote ? quote.totalMinor : clientGross;

  useEffect(() => executor.subscribe(setSaleState), [executor]);
  useEffect(() => quoteController.subscribe(setQuoteState), [quoteController]);

  // Requote on relevant connected basket/code/register changes. `sync` de-duplicates by basket
  // signature, so calling it on every change is cheap and stale responses are discarded internally.
  useEffect(() => {
    if (sellingMode !== "connected") return;
    const basket =
      registerId === null
        ? null
        : {
            registerId,
            lines: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
          };
    quoteController.sync(tenantClient, basket, appliedCode, quoteNonce);
  }, [quoteController, tenantClient, registerId, cart, appliedCode, quoteNonce, sellingMode]);

  const refreshOfflineState = useCallback(async () => {
    if (!offlineBridge) return;
    try {
      const [readiness, status] = await Promise.all([
        offlineBridge.getReadiness(),
        offlineBridge.getSyncStatus(),
      ]);
      setOfflineReadiness(readiness);
      setSyncStatus(status);
      if (readiness.ready) {
        const [catalog, inventory] = await Promise.all([
          offlineBridge.getCachedCatalog(),
          offlineBridge.getProjectedInventory(),
        ]);
        setOfflineCatalog(catalog);
        setProjectedInventory(inventory);
      }
    } catch (error) {
      setOfflineReadiness({
        ready: false,
        reason: "DATABASE_UNHEALTHY",
        message: error instanceof Error ? error.message : "Offline state is unavailable.",
      });
    }
  }, [offlineBridge]);

  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn || !offlineBridge) return;
    const initial = window.setTimeout(() => void refreshOfflineState(), 0);
    const timer = window.setInterval(() => void refreshOfflineState(), 2_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [auth.isLoaded, auth.isSignedIn, offlineBridge, refreshOfflineState]);

  const resetTransaction = useCallback(() => {
    executor.reset();
    quoteController.reset();
    setCart([]);
    setCashReceived("");
    setLocalError(null);
    setCodeDraft("");
    setAppliedCode(null);
    setPriceConfirmationRequired(false);
    setPriceChangedTotal(null);
    setPriceRefreshPending(false);
  }, [executor, quoteController]);

  // Leaving connected selling must never carry a connected discounted total into an offline sale. The
  // offline cashier already builds its own cart at authorized offline prices; this clears any connected
  // promotion pricing first so the boundary is explicit.
  const switchToOffline = useCallback(() => {
    quoteController.reset();
    setCodeDraft("");
    setAppliedCode(null);
    setSellingMode("offline");
  }, [quoteController]);

  /* eslint-disable react-hooks/set-state-in-effect -- These effects deliberately expose loading and
     reset transitions for external Clerk/API state machines before their asynchronous results settle. */
  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn || !client) {
      setTenantPhase("idle");
      setTenants([]);
      setTenantId(null);
      setRegisters([]);
      setRegisterId(null);
      setProducts([]);
      resetTransaction();
      return;
    }
    let active = true;
    setTenantPhase("loading");
    setTenantError(null);
    void bootstrapTenants(client)
      .then((resolution) => {
        if (!active) return;
        if (resolution.kind === "none") {
          setTenants([]);
          setTenantId(null);
          setTenantPhase("empty");
        } else if (resolution.kind === "selected") {
          setTenants(resolution.tenants);
          setTenantId(resolution.tenantId);
          setTenantPhase("ready");
        } else {
          setTenants(resolution.tenants);
          setTenantId(null);
          setTenantPhase("choosing");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setTenantError(classifyCommerceError(error));
        setTenantPhase("error");
      });
    return () => {
      active = false;
    };
  }, [
    auth.isLoaded,
    auth.isSignedIn,
    auth.userId,
    auth.sessionId,
    bootstrapNonce,
    client,
    resetTransaction,
  ]);

  useEffect(() => {
    if (!tenantClient) {
      setContextPhase("idle");
      return;
    }
    let active = true;
    setContextPhase("loading");
    setContextError(null);
    setRegisters([]);
    setRegisterId(null);
    setProducts([]);
    resetTransaction();
    void tenantClient
      .getPosContext()
      .then((context) => {
        if (!active) return;
        const resolution = resolveRegisters(context);
        if (resolution.kind === "none") {
          setContextPhase("empty");
          return;
        }
        setRegisters(resolution.registers);
        if (resolution.kind === "selected") {
          setRegisterId(resolution.registerId);
          setContextPhase("ready");
        } else {
          setContextPhase("choosing");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setContextError(classifyCommerceError(error));
        setContextPhase("error");
      });
    return () => {
      active = false;
    };
  }, [tenantClient, contextNonce, resetTransaction]);

  useEffect(() => {
    if (!tenantClient || !register) {
      setCatalogPhase("idle");
      return;
    }
    let active = true;
    setCatalogPhase("loading");
    setCatalogError(null);
    void loadSellableCatalog(tenantClient, register.sellingCurrency)
      .then((catalog) => {
        if (!active) return;
        setProducts(catalog);
        setSelectedProductId((current) =>
          current && catalog.some((product) => product.productId === current) ? current : null,
        );
        setCart((current) => refreshCartPrices(current, catalog));
        setPriceRefreshPending(false);
        setCatalogPhase(catalog.length === 0 ? "empty" : "ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setCatalogError(classifyCommerceError(error));
        setCatalogPhase("error");
      });
    return () => {
      active = false;
    };
  }, [tenantClient, register, catalogNonce]);

  useEffect(() => {
    if (saleState.phase === "success") {
      setCart([]);
      setCashReceived("");
    } else if (saleState.phase === "price-changed" || saleState.phase === "promotion-changed") {
      // The final server sale re-evaluated and the pricing changed (price, promotion winner, code
      // exhaustion, eligibility). Stop, reload prices, force a fresh quote, and require reconfirmation
      // so a changed amount is never silently finalized.
      setPriceConfirmationRequired(true);
      setPriceChangedTotal(
        saleState.phase === "price-changed" ? saleState.authoritativeTotalMinor : null,
      );
      setPriceRefreshPending(true);
      setCatalogNonce((value) => value + 1);
      setQuoteNonce((value) => value + 1);
    }
  }, [saleState]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const invalidateIntent = useCallback(() => {
    if (
      saleState.phase !== "idle" &&
      saleState.phase !== "price-changed" &&
      saleState.phase !== "promotion-changed"
    )
      executor.invalidate();
    setLocalError(null);
  }, [executor, saleState.phase]);

  const changeCart = useCallback(
    (update: (current: readonly CartLine[]) => readonly CartLine[]) => {
      invalidateIntent();
      setCart(update);
    },
    [invalidateIntent],
  );

  function chooseTenant(selectedTenantId: string) {
    setTenantId(selectedTenantId);
    setTenantPhase("ready");
  }

  function chooseRegister(selectedRegisterId: string) {
    if (selectedRegisterId !== registerId) {
      resetTransaction();
      setProducts([]);
      setSelectedProductId(null);
    }
    setRegisterId(selectedRegisterId);
    setContextPhase("ready");
  }

  function addToCart(variant: SellableVariant) {
    changeCart((current) => addVariant(current, variant));
  }

  function changeCash(value: string) {
    invalidateIntent();
    setCashReceived(value);
  }

  function applyPromotionCode() {
    const trimmed = codeDraft.trim();
    if (trimmed === "" || appliedCode !== null) return;
    invalidateIntent();
    setCodeDraft(trimmed);
    setAppliedCode(trimmed);
  }

  function removePromotionCode() {
    invalidateIntent();
    setAppliedCode(null);
    setCodeDraft("");
  }

  function completeSale() {
    if (showReturns) return;
    if (!tenantClient || !register || saleState.phase === "submitting" || priceConfirmationRequired)
      return;
    const cashReceivedMinor = Number(cashReceived);
    if (cart.length === 0) {
      setLocalError("Add at least one item before checkout.");
      return;
    }
    if (!quoteReady || quote === null) {
      setLocalError("Waiting for the authoritative total. Try again once pricing is ready.");
      return;
    }
    if (!Number.isSafeInteger(cashReceivedMinor) || cashReceivedMinor < 0) {
      setLocalError("Cash received must be a whole number of minor currency units.");
      return;
    }
    if (cashReceivedMinor < netMinor) {
      setLocalError("Cash received is below the amount due.");
      return;
    }
    setLocalError(null);
    // Tender against the current authoritative NET total; the server re-derives and rejects a stale
    // value. Only the entered-code intent is threaded — automatic promotions are re-evaluated server side.
    executor.submit(tenantClient, {
      registerId: register.registerId,
      expectedTotalMinor: netMinor,
      cashReceivedMinor,
      lines: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      ...(appliedCode ? { promotionCode: appliedCode } : {}),
    });
  }

  async function signOut() {
    if (returnLocked) return;
    resetTransaction();
    setSellingMode("connected");
    setTenantId(null);
    setTenants([]);
    await auth.signOut();
  }

  async function enableOfflineSelling() {
    if (!offlineBridge || !tenantId || !register) return;
    setOfflineActionPending(true);
    setOfflineActionMessage(null);
    try {
      const accessToken = await auth.getToken();
      if (!accessToken)
        throw new Error("Your session must be refreshed before enabling offline sales.");
      const result = await offlineBridge.bootstrap({
        tenantId,
        registerId: register.registerId,
        displayName: register.registerName,
        accessToken,
      });
      await refreshOfflineState();
      setOfflineActionMessage(
        result.releasedProjectionCount > 0
          ? `Offline data refreshed. ${result.releasedProjectionCount} synchronized sale projection(s) reconciled.`
          : "Offline selling is ready with current server-issued prices and projected stock.",
      );
    } catch (error) {
      setOfflineActionMessage(
        error instanceof Error ? error.message : "Offline selling could not be enabled.",
      );
    } finally {
      setOfflineActionPending(false);
    }
  }

  if (!auth.isLoaded)
    return <CenteredState title="Restoring session…" body="Checking your Clerk session." />;
  if (!auth.isSignedIn) {
    return (
      <main className="auth-shell">
        <section className="auth-copy">
          <p className="eyebrow">Connected cashier</p>
          <h1>Commerce POS</h1>
          <p>Sign in with an authorized operator account to start a connected cash sale.</p>
        </section>
        <section className="auth-card">{signedOutContent}</section>
      </main>
    );
  }

  if (sellingMode === "offline" && offlineReadiness.ready && offlineBridge) {
    return (
      <OfflineCashier
        bridge={offlineBridge}
        currency={offlineReadiness.currency}
        catalog={offlineCatalog}
        inventory={projectedInventory}
        syncStatus={syncStatus}
        onRefresh={refreshOfflineState}
        onUseConnected={() => setSellingMode("connected")}
        onSignOut={signOut}
      />
    );
  }

  if (tenantPhase === "loading" || tenantPhase === "idle")
    return (
      <CenteredState title="Loading businesses…" body="Resolving your authorized tenant access." />
    );
  if (tenantPhase === "empty")
    return (
      <BlockedState
        title="No available business"
        body="This operator has no usable tenant membership."
        onSignOut={signOut}
      />
    );
  if (tenantPhase === "error" && tenantError)
    return (
      <ErrorState
        error={tenantError}
        onRetry={() => setBootstrapNonce((value) => value + 1)}
        onSignOut={signOut}
        onUseOffline={offlineReadiness.ready ? switchToOffline : undefined}
      />
    );
  if (tenantPhase === "choosing") {
    return (
      <SelectionState
        eyebrow="Authorized businesses"
        title="Choose a business"
        options={tenants.map((tenant) => ({ id: tenant.tenantId, label: tenant.tenantName }))}
        onSelect={chooseTenant}
        onSignOut={signOut}
      />
    );
  }
  if (contextPhase === "loading" || contextPhase === "idle")
    return (
      <CenteredState
        title="Loading registers…"
        body="Resolving server-authorized selling context."
      />
    );
  if (contextPhase === "empty")
    return (
      <BlockedState
        title="No available register"
        body="No active register is authorized for this operator."
        onSignOut={signOut}
      />
    );
  if (contextPhase === "error" && contextError)
    return (
      <ErrorState
        error={contextError}
        onRetry={() => setContextNonce((value) => value + 1)}
        onSignOut={signOut}
        onUseOffline={offlineReadiness.ready ? switchToOffline : undefined}
      />
    );
  if (contextPhase === "choosing") {
    return (
      <SelectionState
        eyebrow="Selling context"
        title="Choose a register"
        options={registers.map((item) => ({
          id: item.registerId,
          label: `${item.registerName} — ${item.branchName}`,
        }))}
        onSelect={chooseRegister}
        onSignOut={signOut}
      />
    );
  }
  if (!register || !tenantClient)
    return <CenteredState title="Loading register…" body="Preparing the cashier." />;

  if (saleState.phase === "success")
    return <Receipt receipt={saleState.receipt} onNewSale={resetTransaction} />;

  const selectedProduct =
    products.find((product) => product.productId === selectedProductId) ?? null;
  const submitting = saleState.phase === "submitting";
  const ambiguous = saleState.phase === "ambiguous";
  const cashMinor = Number(cashReceived);
  const previewChange =
    Number.isSafeInteger(cashMinor) && cashMinor >= netMinor ? cashMinor - netMinor : null;
  const promotion = quote?.promotion ?? null;
  const codeStatus = quote?.codeStatus ?? "none";

  return (
    <main className="pos-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Connected cashier</p>
          <h1>Commerce POS</h1>
        </div>
        <div className="operator-actions">
          <div className="context-summary">
            <strong>{register.registerName}</strong>
            <span>{register.branchName}</span>
            <span>{register.defaultInventoryLocationName}</span>
          </div>
          {registers.length > 1 ? (
            <select
              aria-label="Register"
              value={register.registerId}
              onChange={(event) => chooseRegister(event.target.value)}
              disabled={submitting || returnLocked}
            >
              {registers.map((item) => (
                <option key={item.registerId} value={item.registerId}>
                  {item.registerName}
                </option>
              ))}
            </select>
          ) : null}
          {offlineReadiness.ready ? (
            <button
              className="button button--quiet"
              onClick={switchToOffline}
              disabled={submitting || returnLocked}
            >
              Work offline
            </button>
          ) : null}
          <button
            className="button button--quiet"
            onClick={() => void signOut()}
            disabled={submitting || returnLocked}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="sync-strip">
        <div>
          <strong>Connected</strong>
          <span>
            {offlineReadiness.ready
              ? ` · Offline ready · ${syncLabel(syncStatus)} · ${waitingSyncCount(syncStatus)} waiting`
              : ` · Offline unavailable: ${offlineReadiness.message}`}
          </span>
        </div>
        <button
          className="button button--quiet"
          disabled={offlineActionPending}
          onClick={() => void enableOfflineSelling()}
        >
          {offlineActionPending
            ? "Updating offline data…"
            : offlineReadiness.ready
              ? "Refresh offline data"
              : "Enable offline selling"}
        </button>
      </div>
      {offlineActionMessage ? (
        <div className="operation-message" role="status">
          {offlineActionMessage}
        </div>
      ) : null}
      {syncStatus.needsReconciliation + syncStatus.blocked > 0 ? (
        <div className="attention-strip" role="status">
          {syncStatus.needsReconciliation + syncStatus.blocked} accepted sale(s) need attention.
        </div>
      ) : null}

      <div className="operation-message">
        <button
          className="button"
          disabled={returnLocked || submitting}
          onClick={() => setShowReturns((value) => !value)}
        >
          {showReturns ? "Close returns" : "Returns and refunds"}
        </button>
      </div>
      {showReturns && tenantClient && client ? (
        <ReturnDesk
          key={`${auth.sessionId}:${tenantId}:${registerId}`}
          client={tenantClient}
          health={client.getHealth}
          register={register}
          onLocked={setReturnLocked}
          getToken={auth.getToken}
          bridge={returnsBridge}
        />
      ) : null}

      <div className="workspace">
        <section className="catalog-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Catalog</p>
              <h2>Products</h2>
            </div>
            <span className="currency-pill">{register.sellingCurrency}</span>
          </div>
          {catalogPhase === "loading" ? <InlineState>Loading current prices…</InlineState> : null}
          {catalogPhase === "empty" ? (
            <InlineState>No active sellable products are available.</InlineState>
          ) : null}
          {catalogPhase === "error" && catalogError ? (
            <>
              <InlineError
                error={catalogError}
                onRetry={() => setCatalogNonce((value) => value + 1)}
              />
              {offlineReadiness.ready ? (
                <button className="button" onClick={switchToOffline}>
                  Use offline catalog
                </button>
              ) : null}
            </>
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
                  {product.styleCode ??
                    `${product.variants.length} variant${product.variants.length === 1 ? "" : "s"}`}
                </small>
              </button>
            ))}
          </div>
          {selectedProduct ? (
            <div className="variant-panel">
              <h3>{selectedProduct.productName}</h3>
              {selectedProduct.variants.map((variant) => (
                <div className="variant-row" key={variant.variantId}>
                  <div>
                    <strong>{variant.variantName ?? "Standard"}</strong>
                    <span>SKU {variant.sku}</span>
                  </div>
                  <strong>{formatMoney(variant.unitPriceMinor, register.sellingCurrency)}</strong>
                  <button
                    className="button"
                    onClick={() => addToCart(variant)}
                    disabled={submitting}
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <aside className="checkout-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Current sale</p>
              <h2>Cart</h2>
            </div>
            <span>{cart.length} lines</span>
          </div>
          {cart.length === 0 ? (
            <InlineState>Your cart is empty.</InlineState>
          ) : (
            <div className="cart-lines">
              {cart.map((line) => (
                <div className="cart-line" key={line.variantId}>
                  <div className="cart-line__description">
                    <strong>{line.label}</strong>
                    <span>SKU {line.sku}</span>
                    <span>
                      {formatMoney(line.displayedUnitPriceMinor, register.sellingCurrency)} each
                    </span>
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
                        changeCart((current) =>
                          updateQuantity(current, line.variantId, Number(event.target.value)),
                        )
                      }
                    />
                  </label>
                  <strong>
                    {formatMoney(
                      line.quantity * line.displayedUnitPriceMinor,
                      register.sellingCurrency,
                    )}
                  </strong>
                  <button
                    className="remove-button"
                    aria-label={`Remove ${line.label}`}
                    disabled={submitting}
                    onClick={() => changeCart((current) => removeLine(current, line.variantId))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="promotion-panel">
            <div className="promotion-code-row">
              <label className="promotion-code-field">
                Promotion code
                <input
                  aria-label="Promotion code"
                  type="text"
                  autoComplete="off"
                  value={codeDraft}
                  disabled={submitting || appliedCode !== null}
                  onChange={(event) => setCodeDraft(event.target.value)}
                />
              </label>
              {appliedCode === null ? (
                <button
                  className="button"
                  onClick={applyPromotionCode}
                  disabled={submitting || codeDraft.trim() === ""}
                >
                  Apply
                </button>
              ) : (
                <button
                  className="button button--quiet"
                  onClick={removePromotionCode}
                  disabled={submitting}
                >
                  Remove
                </button>
              )}
            </div>
            {quoteState.status === "loading" ? (
              <p className="inline-state" role="status">
                Updating total…
              </p>
            ) : null}
            {quoteState.status === "error" ? (
              <div className="notice notice--warning" role="status">
                <span>
                  {quoteState.error.kind === "network"
                    ? "Promotions require a connection."
                    : "Pricing is unavailable right now."}
                </span>
                <div className="button-row">
                  <button
                    className="button button--quiet"
                    onClick={() => setQuoteNonce((value) => value + 1)}
                  >
                    Reconnect
                  </button>
                  {offlineReadiness.ready ? (
                    <button className="button button--quiet" onClick={switchToOffline}>
                      Continue at offline prices
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {appliedCode !== null && quoteReady && codeStatus === "invalid" ? (
              <p className="promotion-note promotion-note--error" role="status">
                Code “{appliedCode}” isn’t available.
              </p>
            ) : null}
            {promotion ? (
              <p className="promotion-note" role="status">
                {promotion.activation === "automatic" ? "Automatic promotion" : "Code applied"}:{" "}
                <strong>{promotion.name}</strong>
                {promotion.code ? ` (${promotion.code})` : ""} · −
                {formatMoney(promotion.discountTotalMinor, register.sellingCurrency)}
                {appliedCode !== null &&
                codeStatus === "valid" &&
                promotion.activation === "automatic"
                  ? " — a better automatic promotion applied instead of the code."
                  : ""}
              </p>
            ) : null}
          </div>
          <div className="total-row">
            <span>Gross subtotal</span>
            <strong>{formatMoney(grossMinor, register.sellingCurrency)}</strong>
          </div>
          {discountMinor > 0 ? (
            <div className="total-row total-row--discount">
              <span>Promotion discount</span>
              <strong>−{formatMoney(discountMinor, register.sellingCurrency)}</strong>
            </div>
          ) : null}
          <div className="total-row total-row--due">
            <span>Amount due</span>
            <strong>{formatMoney(netMinor, register.sellingCurrency)}</strong>
          </div>
          <label className="cash-field">
            Cash received <span>minor units</span>
            <input
              aria-label="Cash received in minor units"
              inputMode="numeric"
              type="number"
              min="0"
              step="1"
              value={cashReceived}
              disabled={submitting}
              onChange={(event) => changeCash(event.target.value)}
            />
          </label>
          <div className="change-row">
            <span>Expected change</span>
            <strong>
              {previewChange === null ? "—" : formatMoney(previewChange, register.sellingCurrency)}
            </strong>
          </div>

          {priceConfirmationRequired ? (
            <div className="notice notice--warning" role="alert">
              <strong>Pricing changed</strong>
              <span>
                {priceChangedTotal === null
                  ? "The promotion or price changed. Review the refreshed amount due before confirming."
                  : `The server reports ${formatMoney(priceChangedTotal, register.sellingCurrency)}.`}
              </span>
              <button
                className="button button--warning"
                disabled={priceRefreshPending}
                onClick={() => {
                  if (priceRefreshPending) return;
                  setPriceConfirmationRequired(false);
                  setPriceChangedTotal(null);
                  executor.invalidate();
                }}
              >
                {priceRefreshPending ? "Refreshing prices…" : "Confirm updated total"}
              </button>
            </div>
          ) : null}
          {localError ? (
            <div className="notice notice--error" role="alert">
              {localError}
            </div>
          ) : null}
          {saleState.phase === "error" ? (
            <div className="notice notice--error" role="alert">
              <strong>{saleState.error.code}</strong>
              <span>{saleState.error.message}</span>
            </div>
          ) : null}
          {ambiguous ? (
            <div className="notice notice--warning" role="alert">
              <strong>Sale result unknown</strong>
              <span>Retry sends the exact same sale with the same idempotency key.</span>
              <button
                className="button button--warning"
                onClick={() => executor.retry(tenantClient)}
              >
                Retry same sale
              </button>
            </div>
          ) : null}
          <button
            className="button button--complete"
            disabled={
              cart.length === 0 ||
              submitting ||
              ambiguous ||
              priceConfirmationRequired ||
              showReturns ||
              !quoteReady
            }
            onClick={completeSale}
          >
            {submitting ? "Completing sale…" : "Complete sale"}
          </button>
          <p className="authority-note">
            Prices, promotions, and final change are confirmed by the Commerce API.
          </p>
        </aside>
      </div>
    </main>
  );
}

function Receipt({
  receipt,
  onNewSale,
}: {
  receipt: CreatePosSaleResponse;
  onNewSale: () => void;
}) {
  // Derive every figure from the immutable returned sale. `order.totalMinor` is the payable net; the
  // gross subtotal is the sum of the returned line totals and the discount is the difference. The sale
  // response carries no applied-promotion identity, so no promotion name/code is shown — only the
  // canonical amounts from the accepted sale are rendered.
  const grossSubtotalMinor = receipt.order.lines.reduce(
    (sum, line) => sum + line.lineTotalMinor,
    0,
  );
  const discountMinor = grossSubtotalMinor - receipt.order.totalMinor;
  return (
    <main className="receipt-shell">
      <section className="receipt-card">
        <div className="success-mark" aria-hidden="true">
          ✓
        </div>
        <p className="eyebrow">Sale completed</p>
        <h1>Order {receipt.order.orderNumber}</h1>
        <p className="receipt-status">Cash captured · Fulfilled</p>
        <div className="receipt-lines">
          {receipt.order.lines.map((line) => (
            <div key={line.id} className="receipt-line">
              <div>
                <strong>{line.productName}</strong>
                <span>
                  {line.variantName ?? line.optionSummary ?? line.sku} · SKU {line.sku}
                </span>
                <span>
                  {line.quantity} × {formatMoney(line.unitPriceMinor, receipt.order.currency)}
                </span>
              </div>
              <strong>{formatMoney(line.lineTotalMinor, receipt.order.currency)}</strong>
            </div>
          ))}
        </div>
        <div className="receipt-totals">
          <div>
            <span>Gross subtotal</span>
            <strong>{formatMoney(grossSubtotalMinor, receipt.order.currency)}</strong>
          </div>
          {discountMinor > 0 ? (
            <div className="receipt-discount">
              <span>Promotion discount</span>
              <strong>−{formatMoney(discountMinor, receipt.order.currency)}</strong>
            </div>
          ) : null}
          <div>
            <span>Total</span>
            <strong>{formatMoney(receipt.order.totalMinor, receipt.order.currency)}</strong>
          </div>
          <div>
            <span>Payment</span>
            <strong>Cash · Captured</strong>
          </div>
          <div>
            <span>Cash received</span>
            <strong>
              {formatMoney(receipt.payment.cashReceivedMinor, receipt.payment.currency)}
            </strong>
          </div>
          <div className="receipt-change">
            <span>Change</span>
            <strong>{formatMoney(receipt.payment.changeMinor, receipt.payment.currency)}</strong>
          </div>
          <div>
            <span>Fulfillment</span>
            <strong>Completed</strong>
          </div>
        </div>
        <button className="button button--complete" onClick={onNewSale}>
          New sale
        </button>
      </section>
    </main>
  );
}

function CenteredState({ title, body }: { title: string; body: string }) {
  return (
    <main className="state-shell">
      <section className="state-card">
        <div className="spinner" />
        <h1>{title}</h1>
        <p>{body}</p>
      </section>
    </main>
  );
}

function BlockedState({
  title,
  body,
  onSignOut,
}: {
  title: string;
  body: string;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="state-shell">
      <section className="state-card">
        <p className="eyebrow">Selling unavailable</p>
        <h1>{title}</h1>
        <p>{body}</p>
        <button className="button" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </section>
    </main>
  );
}

function ErrorState({
  error,
  onRetry,
  onSignOut,
  onUseOffline,
}: {
  error: CommerceErrorView;
  onRetry: () => void;
  onSignOut: () => Promise<void>;
  onUseOffline?: () => void;
}) {
  return (
    <main className="state-shell">
      <section className="state-card">
        <p className="eyebrow">{error.code}</p>
        <h1>Unable to continue</h1>
        <p>{error.message}</p>
        <div className="button-row">
          <button className="button" onClick={onRetry}>
            Retry
          </button>
          {onUseOffline ? (
            <button className="button" onClick={onUseOffline}>
              Use offline mode
            </button>
          ) : null}
          <button className="button button--quiet" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}

function SelectionState({
  eyebrow,
  title,
  options,
  onSelect,
  onSignOut,
}: {
  eyebrow: string;
  title: string;
  options: readonly { id: string; label: string }[];
  onSelect: (id: string) => void;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="state-shell">
      <section className="state-card state-card--wide">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <div className="selection-list">
          {options.map((option) => (
            <button
              className="selection-button"
              key={option.id}
              onClick={() => onSelect(option.id)}
            >
              {option.label}
              <span>Continue →</span>
            </button>
          ))}
        </div>
        <button className="button button--quiet" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </section>
    </main>
  );
}

function InlineState({ children }: { children: ReactNode }) {
  return <p className="inline-state">{children}</p>;
}

function InlineError({ error, onRetry }: { error: CommerceErrorView; onRetry: () => void }) {
  return (
    <div className="notice notice--error" role="alert">
      <strong>{error.code}</strong>
      <span>{error.message}</span>
      <button className="button button--quiet" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
