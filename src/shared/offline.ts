export type OfflineUnavailableReason =
  | "NOT_INITIALIZED"
  | "DATABASE_UNHEALTHY"
  | "DEVICE_NOT_ENROLLED"
  | "DEVICE_NOT_ACTIVE"
  | "PRIVATE_KEY_UNAVAILABLE"
  | "GRANT_MISSING"
  | "GRANT_EXPIRED"
  | "BINDING_MISMATCH"
  | "CATALOG_MISSING"
  | "CATALOG_EXPIRED"
  | "CLOCK_ROLLBACK"
  | "POLICY_LIMIT_REACHED";

export type OfflineReadiness =
  | {
      readonly ready: true;
      readonly deviceId: string;
      readonly registerId: string;
      readonly inventoryLocationId: string;
      readonly currency: string;
      readonly acceptedUntil: string;
      readonly catalogValidUntil: string;
      /**
       * True when a staff roster was installed with the active grant, so a cashier can authenticate
       * offline with a local till PIN. False means offline selling is ready but no one can unlock it
       * without a connection (the roster has not yet been delivered by a bootstrap).
       */
      readonly offlineLoginAvailable: boolean;
      /**
       * True when this till may extend customer installments offline: the grant carries a positive
       * offline credit cap AND a customer snapshot was delivered to attach the debt to. False means
       * selling is ready but every sale must be settled in full.
       */
      readonly offlineInstallmentsAvailable: boolean;
      /** Remaining unpaid credit the grant may still extend offline (cap minus current exposure). */
      readonly offlineCreditRemainingMinor: number;
    }
  | {
      readonly ready: false;
      readonly reason: OfflineUnavailableReason;
      readonly message: string;
    };

export interface CachedCatalogItem {
  readonly productId: string;
  readonly productName: string;
  readonly brandId: string;
  // Display-only classification captured at bootstrap (nullable/empty when the server/enrichment did
  // not provide it). Used for the offline register's category-first browse and brand search only.
  readonly brandName: string | null;
  readonly categories: readonly string[];
  readonly variantId: string;
  readonly sku: string;
  readonly optionSummary: string | null;
  readonly currency: string;
  readonly unitPriceMinor: number;
  readonly priceId: string;
  readonly priceVersion: string;
}

export interface ProjectedInventoryItem {
  readonly variantId: string;
  readonly sku: string;
  readonly snapshotOnHand: number;
  readonly pendingQuantity: number;
  readonly projectedAvailable: number;
  readonly version: number;
  readonly asOf: string;
  readonly advisory: true;
}

export interface OfflineTender {
  readonly method: "cash" | "card" | "instapay" | "wallet";
  readonly amountMinor: number;
  readonly cashReceivedMinor?: number;
}

export interface OfflineSaleInput {
  readonly lines: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
  // Cash-only sale: provide cashReceivedMinor. Split sale: provide tenders summing to the amount
  // settled now (the cash tender carries its own cashReceivedMinor for change). Exactly one is used.
  readonly cashReceivedMinor: number;
  readonly tenders?: ReadonlyArray<OfflineTender>;
  // Installment ("pay later"): a snapshot customerId plus a deposit strictly below the sale total. The
  // tenders/cash settle only the deposit; the remainder becomes the customer's debt on sync. Omit both
  // for a normal fully-settled sale.
  readonly customerId?: string;
  readonly amountPaidMinor?: number;
}

export interface AcceptedOfflineSale {
  readonly lifecycle: "accepted_pending_sync";
  readonly localSaleId: string;
  readonly localReceiptId: string;
  readonly syncCommandId: string;
  readonly acceptedAt: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly cashReceivedMinor: number;
  readonly changeMinor: number;
  /** The deposit settled now (equals totalMinor for a normal sale). */
  readonly amountPaidMinor: number;
  /** The unpaid remainder recorded as the customer's debt (0 for a normal sale). */
  readonly outstandingMinor: number;
}

export interface LocalReceipt {
  readonly localSaleId: string;
  readonly localReceiptId: string;
  readonly lifecycle: "accepted_pending_sync" | "synced" | "needs_reconciliation";
  readonly acceptedAt: string;
  /** When the cashier explicitly acknowledged this receipt. Null means it still needs resolution. */
  readonly acknowledgedAt: string | null;
  readonly currency: string;
  readonly totalMinor: number;
  readonly cashReceivedMinor: number;
  readonly changeMinor: number;
  /** Installment facts. customerId/customerName are null and outstandingMinor 0 for a normal sale. */
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly amountPaidMinor: number;
  readonly outstandingMinor: number;
  readonly lines: ReadonlyArray<{
    readonly lineNumber: number;
    readonly productName: string;
    readonly variantName: string | null;
    readonly variantId: string;
    readonly sku: string;
    readonly optionSummary: string | null;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly lineTotalMinor: number;
  }>;
}

export interface OfflineCustomerPaymentInput {
  readonly customerId: string;
  readonly amountMinor: number;
}

export interface AcceptedOfflinePayment {
  readonly localPaymentId: string;
  readonly syncCommandId: string;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly acceptedAt: string;
  /** The customer's projected balance after this paydown (advisory; server reconciles on sync). */
  readonly projectedOutstandingMinor: number;
}

export interface OfflineCustomer {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string;
  /**
   * The customer's balance as the till currently projects it: the server-authoritative balance
   * delivered with the grant, plus every locally accepted (not-yet-synced) installment debt this till
   * has rung for them. This is advisory — the server reconciles the true balance on sync.
   */
  readonly projectedOutstandingMinor: number;
}

export type OfflineAttendanceEventType = "clock_in" | "clock_out";

export interface OfflineAttendanceEventInput {
  readonly eventType: OfflineAttendanceEventType;
}

/**
 * A clock event accepted and durably queued on this device. It is PROVISIONAL: `lifecycle` is
 * `accepted_pending_sync` until the server acknowledges receipt, and even then the server records it as
 * a received, policy-pending event — never as final payroll attendance. The UI must not claim a
 * server-confirmed clock-in before acknowledgment.
 */
export interface AcceptedOfflineAttendanceEvent {
  readonly lifecycle: "accepted_pending_sync";
  readonly localEventId: string;
  readonly syncCommandId: string;
  readonly operatorMembershipId: string;
  readonly eventType: OfflineAttendanceEventType;
  readonly eventAt: string;
  readonly acceptedAt: string;
}

export interface LocalAttendanceEvent {
  readonly localEventId: string;
  readonly operatorMembershipId: string;
  readonly eventType: OfflineAttendanceEventType;
  readonly eventAt: string;
  /** `accepted_pending_sync` = queued locally; `received` = server acknowledged durable receipt. */
  readonly lifecycle: "accepted_pending_sync" | "received";
}

/**
 * The device-local attendance picture for the active offline operator: the latest event (so the clock
 * can show the next action), how many events are still waiting to sync, and a short recent history.
 * Device-local only — not the server attendance feed.
 */
export interface LocalAttendanceState {
  readonly lastEvent: LocalAttendanceEvent | null;
  readonly pending: number;
  readonly recent: readonly LocalAttendanceEvent[];
}

export interface PendingSyncSummary {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly blocked: number;
}

export interface OfflineSyncStatus extends PendingSyncSummary {
  readonly networkOnline: boolean;
  readonly synchronizing: boolean;
  readonly synced: number;
  readonly needsReconciliation: number;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
}

/**
 * A device-local operational report projected entirely from durable local state (accepted sales,
 * the outbox, local customer payments). It is explicitly NOT a company-wide report or a financial
 * close: every figure covers only what this till has rung and the server may still reject/reconcile
 * any pending item. The renderer labels it as such and shows `coverageFrom..coverageTo` + `generatedAt`.
 */
export interface OfflineLocalReport {
  /** When this projection was computed (ISO). The "as of" the UI shows. */
  readonly generatedAt: string;
  /** Currency of the local sales, or null when this till has no local sales yet. */
  readonly currency: string | null;
  /** Earliest / latest `accepted_at` across local sales — the coverage window (null when empty). */
  readonly coverageFrom: string | null;
  readonly coverageTo: string | null;
  readonly sales: {
    /** Number of sales accepted on this device (all lifecycles). */
    readonly count: number;
    /** Sum of sale totals (payable net) rung locally. */
    readonly grossMinor: number;
    /** Sum of amounts settled now (deposit for installments; full total otherwise). */
    readonly collectedMinor: number;
    /** Sum of installment balances recorded as customer debt (0 for fully-settled sales). */
    readonly outstandingMinor: number;
  };
  /** Local sales broken down by their current lifecycle. Separates provisional from server-confirmed. */
  readonly lifecycle: {
    readonly acceptedPendingSync: number;
    readonly synced: number;
    readonly needsReconciliation: number;
  };
  readonly customerPayments: {
    readonly count: number;
    readonly totalMinor: number;
  };
  /** Accepted sales the cashier has not yet acknowledged. */
  readonly unacknowledged: number;
  /** Outbox items still waiting to sync (pending + leased + retry-waiting). */
  readonly pending: number;
  /** Outbox items the server could not accept and that need operator attention. */
  readonly blocked: number;
}

export interface OfflineStaffIdentity {
  readonly membershipId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface OfflineStaffPinInput {
  readonly username: string;
  readonly pin: string;
}

/**
 * Result of verifying a till PIN against the locally cached roster, entirely in the main process.
 * Failures are collapsed to a single reason so a probe cannot distinguish an unknown username from a
 * wrong PIN. `THROTTLED` means too many recent failures for this username; `UNAVAILABLE` means no
 * roster/grant is installed to verify against.
 */
export type OfflineStaffPinResult =
  | { readonly ok: true; readonly operator: OfflineStaffIdentity }
  | { readonly ok: false; readonly reason: "INVALID" | "THROTTLED" | "UNAVAILABLE" };

export interface OfflineBootstrapInput {
  readonly tenantId: string;
  readonly registerId: string;
  readonly displayName: string;
  readonly accessToken: string;
}

export interface OfflineBootstrapResult {
  readonly deviceId: string;
  readonly registerId: string;
  readonly grantId: string;
  readonly snapshotId: string;
  readonly acceptedUntil: string;
  readonly catalogValidUntil: string;
  readonly catalogItemCount: number;
  readonly releasedProjectionCount: number;
}

export interface OfflineBridge {
  getReadiness(): Promise<OfflineReadiness>;
  getCachedCatalog(): Promise<ReadonlyArray<CachedCatalogItem>>;
  getProjectedInventory(): Promise<ReadonlyArray<ProjectedInventoryItem>>;
  /** The customers this till may attach an installment to offline, with their projected balances. */
  getOfflineCustomers(): Promise<ReadonlyArray<OfflineCustomer>>;
  /** Record a customer installment paydown offline; it is queued and synced when connected. */
  recordCustomerPayment(input: OfflineCustomerPaymentInput): Promise<AcceptedOfflinePayment>;
  acceptCashSale(input: OfflineSaleInput): Promise<AcceptedOfflineSale>;
  /** Capture a signed, append-only attendance clock event offline; queued and synced when connected. */
  recordAttendanceEvent(
    input: OfflineAttendanceEventInput,
  ): Promise<AcceptedOfflineAttendanceEvent>;
  /** The device-local attendance state for the active offline operator (last event + pending + recent). */
  getLocalAttendance(): Promise<LocalAttendanceState>;
  getLocalReceipt(localSaleId: string): Promise<LocalReceipt | null>;
  /**
   * Locally accepted sales the cashier has not yet acknowledged, oldest first. On restart this is
   * the durable recovery surface: each entry is a specific committed sale awaiting acknowledgement,
   * never a mere aggregate "pending sync" count.
   */
  getUnacknowledgedSales(): Promise<ReadonlyArray<LocalReceipt>>;
  /** Record that the cashier has seen and acknowledged a specific accepted sale receipt. */
  acknowledgeSale(localSaleId: string): Promise<LocalReceipt>;
  getPendingSyncSummary(): Promise<PendingSyncSummary>;
  /** Device-local operational report (this till only). Never a company-wide/financial report. */
  getLocalReport(): Promise<OfflineLocalReport>;
  getSyncStatus(): Promise<OfflineSyncStatus>;
  requestSync(): Promise<OfflineSyncStatus>;
  bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult>;
  /**
   * Verify a till PIN against the locally cached staff roster. Verification happens entirely in the
   * main process against the active grant's roster; the renderer never receives the stored verifier.
   */
  verifyStaffPin(input: OfflineStaffPinInput): Promise<OfflineStaffPinResult>;
}

export const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  customers: "offline:get-offline-customers",
  recordPayment: "offline:record-customer-payment",
  acceptCash: "offline:accept-cash-sale",
  recordAttendance: "offline:record-attendance-event",
  localAttendance: "offline:get-local-attendance",
  receipt: "offline:get-local-receipt",
  unacknowledged: "offline:get-unacknowledged-sales",
  acknowledge: "offline:acknowledge-sale",
  pendingSummary: "offline:get-pending-sync-summary",
  localReport: "offline:get-local-report",
  syncStatus: "offline:get-sync-status",
  requestSync: "offline:request-sync",
  bootstrap: "offline:bootstrap",
  verifyPin: "offline:verify-staff-pin",
});
