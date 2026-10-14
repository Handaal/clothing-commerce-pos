import { SignIn, useAuth, useClerk, useUser } from "@clerk/react";
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
import { SaleExecutor, type SaleExecutionState, type SalesGateway } from "./checkout/sale-executor";
import { createConfiguredCommerceClient, type CommerceClientFactory } from "./commerce/client";
import { classifyCommerceError, type CommerceErrorView } from "./commerce/errors";
import { formatMoney } from "./money";
import { PayModal, type SaleCustomer, type SaleTender } from "./checkout/PayModal";
import { QuoteController, type QuoteState } from "./promotions/quote";
import { OfflineCashier, syncLabel, waitingSyncCount } from "./offline/cashier";
import { AttendanceClock } from "./pos/AttendanceClock";
import { resolveRegisters, type PosRegister } from "./pos/context";
import { StaffAttendance } from "./staff/StaffAttendance";
import {
  receiptIdentity,
  type BusinessIdentity,
  type ReceiptIdentity,
} from "./pos/receipt-identity";
import { bootstrapTenants, type Tenant } from "./session/tenant";
import { OrdersDesk } from "./orders/OrdersDesk";
import { ActivityDesk } from "./activity/ActivityDesk";
import {
  installActivityClickCapture,
  logActivity,
  setActivityActor,
  setActivitySection,
  setActivityTenant,
} from "./activity/log";
import { InventoryDesk } from "./inventory/InventoryDesk";
import { CustomersDesk } from "./customers/CustomersDesk";
import { VouchersDesk } from "./vouchers/VouchersDesk";
import { SuppliersDesk } from "./suppliers/SuppliersDesk";
import { ReportsDesk } from "./reports/ReportsDesk";
import { SettingsDesk } from "./settings/SettingsDesk";
import { ReturnDesk } from "./returns/ReturnDesk";
import type { ReturnsBridge } from "../shared/returns";
import { AppShell } from "./shell/AppShell";
import { PlaceholderSection } from "./shell/PlaceholderSection";
import { Select } from "./shell/Select";
import { accessibleSections, SECTIONS, type Capabilities, type SectionId } from "./shell/sections";

// Cashier-facing labels for captured tender methods, shown on the cart and receipt.
const TENDER_LABELS: Record<"cash" | "card" | "instapay" | "wallet", string> = {
  cash: "Cash",
  card: "Card",
  instapay: "Instapay",
  wallet: "Wallet",
};

export interface PosAuth {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionId: string | null;
  displayName?: string;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<unknown>;
}

interface PosApplicationProps {
  auth: PosAuth;
  signedOutContent?: ReactNode;
  clientFactory?: CommerceClientFactory;
  offlineBridge?: OfflineBridge;
  returnsBridge?: ReturnsBridge;
  salesGateway?: SalesGateway;
}

type LoadPhase = "idle" | "loading" | "ready" | "choosing" | "empty" | "error";

export function App() {
  const { isLoaded, isSignedIn, userId, sessionId, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const displayName =
    user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? user?.username ?? undefined;
  return (
    <PosApplication
      auth={{
        isLoaded,
        isSignedIn: isSignedIn === true,
        userId: userId ?? null,
        sessionId: sessionId ?? null,
        displayName,
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
  offlineBridge = typeof window === "undefined" ? undefined : window.offline,
  returnsBridge = typeof window === "undefined" ? undefined : window.returns,
  salesGateway,
}: PosApplicationProps) {
  const tokenRef = useRef(auth.getToken);
  useEffect(() => {
    tokenRef.current = auth.getToken;
  });
  // Live session for the durable connected-sale bridge. The ref is synced once tenant selection
  // resolves (below); the gateway reads it at call time so the executor stays stable.
  const tenantIdRef = useRef<string | null>(null);
  const defaultGateway = useMemo<SalesGateway>(() => {
    const bridge = typeof window === "undefined" ? undefined : window.sales;
    const session = async () => {
      const token = await tokenRef.current();
      const tenant = tenantIdRef.current;
      if (!bridge || !token || !tenant) return null;
      return { bridge, session: { tenantId: tenant, accessToken: token } };
    };
    return {
      hasPending: async () =>
        (typeof window === "undefined" ? false : window.sales?.hasPending()) ?? false,
      submit: async (intent) => {
        const context = await session();
        if (!context) throw new Error("A signed-in tenant session is required to sell.");
        return context.bridge.submit(context.session, intent);
      },
      recover: async () => {
        const context = await session();
        if (!context) return null;
        return context.bridge.recover(context.session);
      },
      acknowledge: async (workflowId) => {
        const context = await session();
        if (!context) return;
        await context.bridge.acknowledge(context.session, workflowId);
      },
    };
  }, []);
  const gateway = salesGateway ?? defaultGateway;
  const [client, setClient] = useState<CommerceClient | null>(null);
  useEffect(() => {
    // The SDK client is an external session boundary and is intentionally composed after render.
    setClient(clientFactory({ getToken: () => tokenRef.current() }));
  }, [clientFactory]);
  // The gateway is stable (a prop, or a []-memoized closure) and only reads the session refs when its
  // async methods are invoked — never during render — so constructing the executor here is safe.
  // eslint-disable-next-line react-hooks/refs -- gateway does not read refs during render
  const [executor] = useState(() => new SaleExecutor(gateway));
  const [saleState, setSaleState] = useState<SaleExecutionState>(executor.snapshot());

  const [tenantPhase, setTenantPhase] = useState<LoadPhase>("idle");
  const [tenants, setTenants] = useState<readonly Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantError, setTenantError] = useState<CommerceErrorView | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);

  const [contextPhase, setContextPhase] = useState<LoadPhase>("idle");
  const [business, setBusiness] = useState<BusinessIdentity | null>(null);
  const [registers, setRegisters] = useState<readonly PosRegister[]>([]);
  const [registerId, setRegisterId] = useState<string | null>(null);
  const [contextError, setContextError] = useState<CommerceErrorView | null>(null);
  const [contextNonce, setContextNonce] = useState(0);

  const [catalogPhase, setCatalogPhase] = useState<LoadPhase>("idle");
  const [products, setProducts] = useState<readonly SellableProduct[]>([]);
  const [catalogError, setCatalogError] = useState<CommerceErrorView | null>(null);
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");

  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [payOpen, setPayOpen] = useState(false);
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
  const [section, setSection] = useState<SectionId>("pos");
  const [showReturns, setShowReturns] = useState(false);

  // Role-based navigation. The gating mechanism is live (see `accessibleSections`); capabilities
  // are permissive during the section build-out and will be sourced from the operator's
  // server-resolved access guidance as each section is wired to the API.
  const capabilities = useMemo<Capabilities>(
    () => ({
      isManager: true,
      orders: true,
      inventory: true,
      customers: true,
      reports: true,
      vouchers: true,
      suppliers: true,
      staff: true,
      activity: true,
      settings: true,
    }),
    [],
  );
  const visibleSections = useMemo(() => accessibleSections(capabilities), [capabilities]);
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

  // Keep the durable-sale session ref current for the gateway.
  useEffect(() => {
    tenantIdRef.current = tenantId;
  }, [tenantId]);

  // Client-only activity ledger: install the global click capture once, and keep the ambient context
  // (who is signed in, which tenant, which section is open) stamped onto every recorded event.
  useEffect(() => {
    installActivityClickCapture();
  }, []);
  useEffect(() => {
    setActivityActor({ id: auth.userId, name: auth.displayName ?? null });
  }, [auth.userId, auth.displayName]);
  useEffect(() => {
    setActivityTenant(tenantId);
  }, [tenantId]);
  useEffect(() => {
    setActivitySection(section);
  }, [section]);

  // Startup crash recovery: if a connected sale was prepared/accepted but never acknowledged before
  // the app died, replay it with its ORIGINAL key. Server idempotency decides whether it committed;
  // an accepted result surfaces the canonical receipt and blocks new selling until acknowledged.
  const recoveredForTenantRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    if (recoveredForTenantRef.current === tenantId) return;
    recoveredForTenantRef.current = tenantId;
    void gateway.hasPending().then((pending) => {
      if (pending) executor.recover();
    });
  }, [gateway, executor, tenantId]);

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
    setPayOpen(false);
    setLocalError(null);
    setCodeDraft("");
    setAppliedCode(null);
    setPriceConfirmationRequired(false);
    setPriceChangedTotal(null);
    setPriceRefreshPending(false);
  }, [executor, quoteController]);

  // Finishing the receipt is the explicit acknowledgement point: it durably records that the cashier
  // saw the accepted sale (clearing the workflow) before a new sale can begin.
  const finishAcceptedSale = useCallback(() => {
    void executor.acknowledge();
    resetTransaction();
  }, [executor, resetTransaction]);

  // Leaving connected selling must never carry a connected discounted total into an offline sale. The
  // offline cashier already builds its own cart at authorized offline prices; this clears any connected
  // promotion pricing first so the boundary is explicit.
  const switchToOffline = useCallback(() => {
    quoteController.reset();
    setCodeDraft("");
    setAppliedCode(null);
    setSellingMode("offline");
  }, [quoteController]);

  // Navigating between workspace sections is a first-class audit event (the raw sidebar click is also
  // captured, but this records the destination explicitly).
  const handleNavigate = useCallback((id: SectionId) => {
    logActivity({
      category: "navigation",
      action: "navigate",
      description: `Opened the ${id} section`,
      details: { to: id },
    });
    setSection(id);
  }, []);

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
    setBusiness(null);
    setRegisters([]);
    setRegisterId(null);
    setProducts([]);
    resetTransaction();
    void tenantClient
      .getPosContext()
      .then((context) => {
        if (!active) return;
        // Server-owned business identity for receipt rendering (SDK 0.14.0). Configuration, not a
        // historical sale snapshot; captured alongside the selling registers.
        setBusiness(context.business.tenant);
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
      setPayOpen(false);
      logActivity({
        category: "sale",
        action: "sale_completed",
        description: `Completed sale ${saleState.receipt.order.orderNumber}`,
        details: {
          orderNumber: saleState.receipt.order.orderNumber,
          totalMinor: saleState.receipt.order.totalMinor,
          currency: saleState.receipt.order.currency,
        },
      });
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

  function openPayment() {
    if (showReturns || locked || priceConfirmationRequired) return;
    if (cart.length === 0) {
      setLocalError("Add at least one item before checkout.");
      return;
    }
    if (!quoteReady || quote === null) {
      setLocalError("Waiting for the authoritative total. Try again once pricing is ready.");
      return;
    }
    setLocalError(null);
    setPayOpen(true);
  }

  function completeSale(tenders: SaleTender[], customer?: SaleCustomer) {
    if (!tenantClient || !register || locked || priceConfirmationRequired) return;
    if (cart.length === 0 || !quoteReady || quote === null) return;
    setPayOpen(false);
    setLocalError(null);
    // Tender against the current authoritative NET total; the server re-derives the split, validates
    // it sums to the total, and rejects a stale value. The durable journal owns the idempotency key.
    // Only the entered-code intent is threaded — automatic promotions are re-evaluated server side.
    executor.submit({
      registerId: register.registerId,
      expectedTotalMinor: netMinor,
      tenders: tenders.map((tender) => ({
        method: tender.method,
        amountMinor: tender.amountMinor,
        ...(tender.cashReceivedMinor !== undefined
          ? { cashReceivedMinor: tender.cashReceivedMinor }
          : {}),
      })),
      lines: cart.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      ...(appliedCode ? { promotionCode: appliedCode } : {}),
      ...(customer ? { customer } : {}),
    });
  }

  async function signOut() {
    if (returnLocked) return;
    logActivity({ category: "session", action: "sign_out", description: "Signed out of the POS" });
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
    return (
      <Receipt
        receipt={saleState.receipt}
        identity={business ? receiptIdentity(business, register.branch) : null}
        onNewSale={finishAcceptedSale}
      />
    );

  const selectedProduct =
    products.find((product) => product.productId === selectedProductId) ?? null;

  // Search matches product name, style code, and any variant name or SKU. A barcode scanner types
  // the SKU then sends Enter: an exact SKU match adds that variant straight to the cart.
  const normalizedQuery = catalogQuery.trim().toLowerCase();
  const filteredProducts =
    normalizedQuery === ""
      ? products
      : products.filter(
          (product) =>
            product.productName.toLowerCase().includes(normalizedQuery) ||
            (product.styleCode?.toLowerCase().includes(normalizedQuery) ?? false) ||
            product.variants.some(
              (variant) =>
                variant.sku.toLowerCase().includes(normalizedQuery) ||
                (variant.variantName?.toLowerCase().includes(normalizedQuery) ?? false),
            ),
        );

  function submitCatalogSearch() {
    if (normalizedQuery === "" || locked) return;
    const exactSku = products
      .flatMap((product) => product.variants)
      .find((variant) => variant.sku.toLowerCase() === normalizedQuery);
    if (exactSku) {
      addToCart(exactSku);
      setSelectedProductId(exactSku.productId);
      setCatalogQuery("");
      return;
    }
    if (filteredProducts.length === 1) {
      setSelectedProductId(filteredProducts[0].productId);
    }
  }
  const submitting = saleState.phase === "submitting";
  const recovering = saleState.phase === "recovering";
  const ambiguous = saleState.phase === "ambiguous";
  // While a sale is in-flight, recovering, or its result is uncertain, the cart is locked: the
  // durable command is the source of truth and must be resolved (retried) before any edit.
  const locked = submitting || recovering || ambiguous;
  const promotion = quote?.promotion ?? null;
  const codeStatus = quote?.codeStatus ?? "none";

  const posContent = (
    <main className="pos-shell">
      <header className="topbar">
        <div className="register-identity">
          <p className="eyebrow">Register</p>
          <strong>{register.registerName}</strong>
          <span>
            {register.branchName} · {register.defaultInventoryLocationName}
          </span>
        </div>
        <div className="operator-actions">
          <AttendanceClock
            client={tenantClient}
            branchId={register.branchId}
            disabled={returnLocked}
          />
          {registers.length > 1 ? (
            <Select
              ariaLabel="Register"
              className="operator-actions__select"
              value={register.registerId}
              onChange={(value) => chooseRegister(value)}
              disabled={locked || returnLocked}
              options={registers.map((item) => ({
                value: item.registerId,
                label: item.registerName,
              }))}
            />
          ) : null}
          {offlineReadiness.ready ? (
            <button
              className="button button--quiet"
              onClick={switchToOffline}
              disabled={locked || returnLocked}
            >
              Work offline
            </button>
          ) : null}
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
          <div className="catalog-search">
            <input
              className="catalog-search__input"
              aria-label="Search or scan products"
              placeholder="Search or scan — name, SKU, barcode"
              value={catalogQuery}
              disabled={catalogPhase !== "ready"}
              autoFocus
              onChange={(event) => setCatalogQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitCatalogSearch();
                }
              }}
            />
            {catalogQuery !== "" ? (
              <button
                type="button"
                className="catalog-search__clear"
                aria-label="Clear search"
                onClick={() => setCatalogQuery("")}
              >
                ×
              </button>
            ) : null}
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
          {catalogPhase === "ready" && filteredProducts.length === 0 && normalizedQuery !== "" ? (
            <InlineState>No products match “{catalogQuery}”.</InlineState>
          ) : null}
          <div className="product-grid">
            {filteredProducts.map((product) => (
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
                      // Prevent the scroll wheel from silently changing the quantity while the
                      // cashier scrolls the page.
                      onWheel={(event) => event.currentTarget.blur()}
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
                  disabled={locked || appliedCode !== null}
                  onChange={(event) => setCodeDraft(event.target.value)}
                />
              </label>
              {appliedCode === null ? (
                <button
                  className="button"
                  onClick={applyPromotionCode}
                  disabled={locked || codeDraft.trim() === ""}
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
              <button className="button button--warning" onClick={() => executor.retry()}>
                Retry same sale
              </button>
            </div>
          ) : null}
          <button
            className="button button--complete"
            disabled={
              cart.length === 0 || locked || priceConfirmationRequired || showReturns || !quoteReady
            }
            onClick={openPayment}
          >
            {submitting ? "Completing sale…" : recovering ? "Recovering sale…" : "Take payment"}
          </button>
          {payOpen ? (
            <PayModal
              netMinor={netMinor}
              currency={register.sellingCurrency}
              submitting={submitting}
              onConfirm={completeSale}
              onCancel={() => setPayOpen(false)}
              lookupCustomer={(phone) =>
                tenantClient.lookupCustomerByPhone(phone).then((result) => result.customer)
              }
            />
          ) : null}
          <p className="authority-note">
            Prices, promotions, and final change are confirmed by the Commerce API.
          </p>
        </aside>
      </div>
    </main>
  );

  const activeSection = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
  return (
    <AppShell
      sections={visibleSections}
      active={section}
      onNavigate={handleNavigate}
      userName={auth.displayName ?? "Operator"}
      onSignOut={() => void signOut()}
      signOutDisabled={locked || returnLocked}
    >
      {section === "pos" ? (
        posContent
      ) : section === "orders" ? (
        <OrdersDesk client={tenantClient} />
      ) : section === "inventory" ? (
        <InventoryDesk client={tenantClient} />
      ) : section === "customers" ? (
        <CustomersDesk client={tenantClient} currency={register.sellingCurrency} />
      ) : section === "vouchers" ? (
        <VouchersDesk client={tenantClient} currency={register.sellingCurrency} />
      ) : section === "staff" ? (
        <StaffAttendance
          client={tenantClient}
          currency={register.sellingCurrency}
          branchId={register.branchId}
        />
      ) : section === "suppliers" ? (
        <SuppliersDesk client={tenantClient} />
      ) : section === "reports" ? (
        <ReportsDesk client={tenantClient} />
      ) : section === "activity" ? (
        <ActivityDesk />
      ) : section === "settings" ? (
        <SettingsDesk client={tenantClient} currency={register.sellingCurrency} />
      ) : (
        <PlaceholderSection section={activeSection} />
      )}
    </AppShell>
  );
}

function Receipt({
  receipt,
  identity,
  onNewSale,
}: {
  receipt: CreatePosSaleResponse;
  identity: ReceiptIdentity | null;
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
  const cashTender = receipt.payments.find((tender) => tender.method === "cash") ?? null;
  return (
    <main className="receipt-shell">
      <section className="receipt-card">
        <div className="success-mark" aria-hidden="true">
          ✓
        </div>
        {/* Configured business/branch identity rendered at receipt time from trusted POS context.
            Optional fields are omitted when absent; this is not a sale snapshot. */}
        {identity ? (
          <div className="receipt-identity">
            <strong className="receipt-business-name">{identity.businessName}</strong>
            {identity.legalName ? <span>{identity.legalName}</span> : null}
            {identity.taxIdentifier ? <span>Tax ID: {identity.taxIdentifier}</span> : null}
            <span className="receipt-branch-name">{identity.branchName}</span>
            {identity.branchAddressLines.map((line, index) => (
              <span key={`address-${index}`}>{line}</span>
            ))}
            {identity.branchContactLines.map((line, index) => (
              <span key={`contact-${index}`}>{line}</span>
            ))}
          </div>
        ) : null}
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
          {receipt.payments.map((tender) => (
            <div key={tender.id}>
              <span>{TENDER_LABELS[tender.method]}</span>
              <strong>{formatMoney(tender.amountMinor, tender.currency)}</strong>
            </div>
          ))}
          {cashTender ? (
            <>
              <div>
                <span>Cash received</span>
                <strong>
                  {formatMoney(
                    cashTender.cashReceivedMinor ?? cashTender.amountMinor,
                    cashTender.currency,
                  )}
                </strong>
              </div>
              <div className="receipt-change">
                <span>Change</span>
                <strong>{formatMoney(cashTender.changeMinor ?? 0, cashTender.currency)}</strong>
              </div>
            </>
          ) : null}
          <div>
            <span>Fulfillment</span>
            <strong>Completed</strong>
          </div>
        </div>
        {identity?.receiptFooter ? (
          <p className="receipt-footer">{identity.receiptFooter}</p>
        ) : null}
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
