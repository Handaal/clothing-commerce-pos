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
  // ADR-042 §5: an offline voucher (by code, or by grant id for an automatic one). When the voucher needs
  // approval, a manager types their POS username + override password here; it is checked in the main
  // process and never stored.
  readonly voucher?: {
    readonly code?: string;
    readonly voucherGrantId?: string;
    readonly approver?: { readonly username: string; readonly password: string };
  };
}

export interface OfflineVoucherPreviewInput {
  readonly lines: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
  readonly code: string;
}

export interface OfflineVoucherPreview {
  readonly label: string;
  readonly discountTotalMinor: number;
  readonly netTotalMinor: number;
  readonly requiresApproval: boolean;
  /**
   * ADR-042 §13.6: freshness of the cached policy the discount was priced from. The discount is PROVISIONAL:
   * the server confirms it at sync against live shared usage (the Website may use the same voucher meanwhile);
   * if it disagrees the sale still stands as recorded and a voucher conflict is reported.
   */
  readonly policy?: {
    readonly fetchedAt: string;
    readonly expiresAt: string;
    /** Shared remaining usage the server reported at fetch (null = no finite limit). */
    readonly remainingAtFetch: number | null;
    /** This till's own uses counted against that number since the fetch. */
    readonly localUsesSinceFetch: number;
    readonly provisional: true;
  };
}

/** ADR-042 §8: a new customer captured offline. */
export interface OfflineNewCustomerInput {
  readonly name: string;
  readonly phone: string;
}

export interface AcceptedOfflineCustomer {
  readonly localCustomerId: string;
  readonly name: string;
  readonly phone: string;
  readonly acceptedAt: string;
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
  /**
   * ADR-042 §13.3: tenders as signed. No payment gateway exists: each tender is cashier-recorded.
   * 'recorded_locally' until the sale syncs; 'recorded_in_server_ledger' afterwards.
   */
  readonly tenders: ReadonlyArray<{
    readonly method: "cash" | "card" | "instapay" | "wallet";
    readonly amountMinor: number;
    readonly confirmation: "recorded_locally" | "recorded_in_server_ledger";
  }>;
  /**
   * ADR-042 §4.6: a sale whose new customer was rejected is never sent as a sale; its terminal hold is
   * pending, acknowledged by the server (held_for_reconciliation) or refused. Null for every other sale.
   */
  readonly reconciliationHold: "hold_pending" | "held_for_reconciliation" | "hold_refused" | null;
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
  /** Created on this till while offline (name + phone only); absent for snapshot customers. */
  readonly createdOffline?: true;
  /** True until the server has accepted this offline-created customer. */
  readonly pendingSync?: boolean;
}

export type OfflineAttendanceEventType = "clock_in" | "clock_out";

export interface OfflineAttendanceEventInput {
  readonly eventType: OfflineAttendanceEventType;
  /** Team member being clocked; omitted for the signed-in operator's own clock. */
  readonly membershipId?: string;
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
  readonly membershipId: string;
  readonly eventType: OfflineAttendanceEventType;
  readonly eventAt: string;
  readonly acceptedAt: string;
}

export interface LocalAttendanceEvent {
  readonly localEventId: string;
  readonly operatorMembershipId: string;
  readonly membershipId: string;
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

/** Ask main to fetch (online, with the operator session) and cache an offline return grant for an order. */
export interface PrepareReturnGrantInput {
  readonly tenantId: string;
  readonly accessToken: string;
  readonly orderId: string;
}

export interface OfflineReturnGrantLineView {
  readonly orderLineId: string;
  readonly lineNumber: number;
  readonly variantId: string;
  readonly productName: string | null;
  readonly sku: string | null;
  readonly optionSummary: string | null;
  /** Server-frozen remaining-eligible quantity at grant issuance. */
  readonly grantedQuantity: number;
  /** grantedQuantity minus what this device has already captured against the order since issuance. */
  readonly remainingQuantity: number;
}

/**
 * A cached, server-issued offline return grant. It authorizes capturing a return of these lines up to
 * `remainingQuantity` until `expiresAt`. It carries no refund amount authority: the refund is computed
 * by the server on sync and created PENDING (never settled offline).
 */
export interface OfflineReturnGrantView {
  readonly returnGrantId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Null ⇒ any non-empty reason; otherwise the reason must be one of these. */
  readonly allowedReasons: readonly string[] | null;
  /** ADR-042 §6/§7: a manager's POS username + override password is needed to capture the return. */
  readonly requiresAdminCredentials: boolean;
  readonly lines: readonly OfflineReturnGrantLineView[];
}

export interface OfflineReturnLineInput {
  readonly orderLineId: string;
  readonly quantity: number;
  readonly reason: string;
  readonly disposition: "restock" | "non_restock";
}

export interface OfflineReturnInput {
  readonly returnGrantId: string;
  readonly lines: readonly OfflineReturnLineInput[];
  // ADR-042 §6/§7: required when the grant says requiresAdminCredentials. Checked in the main process.
  readonly approver?: { readonly username: string; readonly password: string };
}

export type LocalReturnLifecycle = "accepted_pending_sync" | "synced" | "needs_reconciliation";

/** A return captured offline. `refund` is present only once the server computed it (always PENDING). */
export interface LocalOfflineReturn {
  readonly localReturnId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly currency: string;
  readonly acceptedAt: string;
  readonly lifecycle: LocalReturnLifecycle;
  readonly serverReturnId: string | null;
  readonly refund: {
    readonly id: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly status: "pending";
  } | null;
  readonly reconciliationReason: string | null;
  readonly lines: ReadonlyArray<{
    readonly orderLineId: string;
    readonly lineNumber: number | null;
    readonly productName: string | null;
    readonly sku: string | null;
    readonly quantity: number;
    readonly reason: string;
    readonly disposition: "restock" | "non_restock";
  }>;
}

export interface AcceptedOfflineReturn {
  readonly lifecycle: "accepted_pending_sync";
  readonly localReturnId: string;
  readonly syncCommandId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly acceptedAt: string;
}

export interface LocalReturnsState {
  /** Offline return commands still waiting to sync (pending + leased + retry-waiting). */
  readonly pending: number;
  readonly recent: readonly LocalOfflineReturn[];
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

// ---- Offline operation intents (all-desks lane) ----------------------------------------------------
// A desk action recorded offline. It is signed, stored and queued locally and never changes anything on
// the till. On sync the server decides AUTOMATICALLY under the register's handler policy: applied
// (typed business effect committed), rejected, needs_reconciliation or blocked_policy (fails closed when
// no owner-approved policy exists). There is no human approval step. "review.resolution_request" is
// retired: the server always rejects it and the till never offers it.
export const OFFLINE_INTENT_OPERATIONS = [
  "inventory.receive",
  "inventory.adjust",
  "inventory.count",
  "suppliers.purchase_draft",
  "suppliers.goods_receipt",
  "suppliers.payment_intent",
  "staff.attendance_correction_request",
  "staff.role_change_request",
  "settings.change_request",
  "settings.device_revoke_request",
  "customers.create",
  "customers.update",
  "review.resolution_request",
] as const;
export type OfflineIntentOperation = (typeof OFFLINE_INTENT_OPERATIONS)[number];

export type OfflineIntentPayloadValue =
  string | number | boolean | null | OfflineIntentPayloadObject | OfflineIntentPayloadValue[];
export interface OfflineIntentPayloadObject {
  readonly [key: string]: OfflineIntentPayloadValue;
}

export interface OfflineIntentInput {
  readonly operation: OfflineIntentOperation;
  readonly subjectId: string | null;
  readonly baseVersion: string | null;
  readonly dependsOnSyncCommandId: string | null;
  readonly payload: OfflineIntentPayloadObject;
}

export interface AcceptedOfflineIntent {
  readonly lifecycle: "accepted_pending_sync";
  readonly localIntentId: string;
  readonly syncCommandId: string;
  readonly operation: OfflineIntentOperation;
  readonly acceptedAt: string;
}

export interface LocalIntent {
  readonly localIntentId: string;
  readonly syncCommandId: string;
  readonly operation: OfflineIntentOperation;
  readonly subjectId: string | null;
  readonly payload: OfflineIntentPayloadObject;
  readonly acceptedAt: string;
  /** `received` = the server stored it AND decided it automatically (see `disposition`). */
  readonly lifecycle: "accepted_pending_sync" | "received";
  readonly outboxState: "pending" | "leased" | "retry_wait" | "delivered" | "blocked";
  readonly serverReceivedAt: string | null;
  readonly lastErrorCode: string | null;
  /**
   * The server's final machine disposition (null until synced). There is no human approval step:
   * applied (business effect committed) | rejected (never applied) | needs_reconciliation (conflict
   * with canonical state; nothing applied) | blocked_policy (no approved handler policy; nothing applied).
   */
  readonly disposition: OfflineIntentDisposition | null;
  readonly dispositionCode: string | null;
}

export type OfflineIntentDisposition =
  "applied" | "rejected" | "needs_reconciliation" | "blocked_policy";

export interface LocalIntentsState {
  /** Operations the active grant's register policy opts into (empty ⇒ none can be recorded offline). */
  readonly enabledOperations: ReadonlyArray<OfflineIntentOperation>;
  readonly pending: number;
  readonly recent: ReadonlyArray<LocalIntent>;
}

// ---- Review / reconciliation center ----------------------------------------------------------------
export type ReviewLane = "sale" | "payment" | "attendance" | "return" | "intent";
/**
 * One honest status per command, derived from the durable outbox + local lifecycle + server disposition:
 * queued (saved locally, not sent) | syncing | retry_wait (transient failure, will retry) |
 * blocked (transport refused the command; exact retry possible) | server_received (stored provisionally,
 * e.g. attendance awaiting payroll policy; never a person's approval) | accepted (server applied it
 * canonically) | needs_review (server marked a conflict for operator reconciliation; nothing applied) |
 * rejected (server refused it deterministically; never applied) | policy_blocked (no approved handler
 * policy; fails closed, nothing applied).
 */
export type ReviewStatus =
  | "queued"
  | "syncing"
  | "retry_wait"
  | "blocked"
  | "server_received"
  | "accepted"
  | "needs_review"
  | "rejected"
  | "policy_blocked";
export type ReviewActionKind = "retry" | "resolution_request";
export type ReviewResolutionKind =
  "investigate" | "confirm_physical_evidence" | "void_request" | "other";

export interface ReviewActionRecord {
  readonly actionId: string;
  readonly action: ReviewActionKind;
  readonly outcome: "requeued" | "requested" | "refused";
  readonly outcomeDetail: string | null;
  readonly note: string | null;
  readonly relatedSyncCommandId: string | null;
  readonly createdAt: string;
}

export interface ReviewItem {
  readonly lane: ReviewLane;
  readonly syncCommandId: string;
  readonly localId: string;
  /** Lane-specific short label (operation, receipt id, clock event…), safe to display. */
  readonly label: string;
  readonly status: ReviewStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly serverIngestionId: string | null;
  readonly serverReceivedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly payloadHash: string;
  /** Safe evidence only: identifiers, amounts in minor units, reasons. Never keys/signatures/PII. */
  readonly evidence: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly allowedActions: ReadonlyArray<ReviewActionKind>;
  readonly actions: ReadonlyArray<ReviewActionRecord>;
}

export interface ReviewQuery {
  readonly lane?: ReviewLane | "all";
  /** "attention" = blocked + needs_review + retry_wait + rejected + policy_blocked. */
  readonly status?: ReviewStatus | "all" | "attention";
  readonly search?: string;
}

export interface ReviewRetryInput {
  readonly actionId: string;
  readonly lane: ReviewLane;
  readonly syncCommandId: string;
}

export interface ReviewResolutionInput {
  readonly actionId: string;
  readonly lane: ReviewLane;
  readonly syncCommandId: string;
  readonly requestKind: ReviewResolutionKind;
  readonly note: string;
}

export interface ReviewActionResult {
  readonly actionId: string;
  readonly outcome: "requeued" | "requested" | "refused";
  readonly detail: string | null;
  readonly relatedSyncCommandId: string | null;
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
  previewOfflineVoucher(input: OfflineVoucherPreviewInput): Promise<OfflineVoucherPreview>;
  addOfflineCustomer(input: OfflineNewCustomerInput): Promise<AcceptedOfflineCustomer>;
  /** Capture a signed, append-only attendance clock event offline; queued and synced when connected. */
  recordAttendanceEvent(
    input: OfflineAttendanceEventInput,
  ): Promise<AcceptedOfflineAttendanceEvent>;
  /** The device-local attendance state for the active offline operator (last event + pending + recent). */
  getLocalAttendance(membershipId?: string): Promise<LocalAttendanceState>;
  /**
   * ONLINE: fetch a server-issued offline return grant for an order (plus its server line labels) with
   * the operator's session and cache it durably, so the return can still be captured if the link drops.
   * Reuses a cached grant for the order while it remains comfortably inside its window.
   */
  prepareReturnGrant(input: PrepareReturnGrantInput): Promise<OfflineReturnGrantView>;
  /** Cached return grants still inside their window, with locally remaining quantities. */
  getReturnGrants(): Promise<ReadonlyArray<OfflineReturnGrantView>>;
  /** Capture a signed return offline under a cached grant; queued and synced when connected. */
  recordReturn(input: OfflineReturnInput): Promise<AcceptedOfflineReturn>;
  /** Device-local offline returns (pending count + recent history with server outcomes). */
  getLocalReturns(): Promise<LocalReturnsState>;
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
  /** ADR-043 §5.1: end the offline staff session (clears the main-process operator stamped into sales). */
  endStaffSession(): Promise<void>;
  /**
   * Offline PIN v2 (ONLINE): enrol the signed-in person's own NEW offline PIN on this till. The PIN is turned
   * into a device-bound verifier in the main process and sealed with the OS key store; it is never sent to the
   * server. Effective after the next online bootstrap.
   */
  /** Record a provisional offline operation intent (only operations the grant enables). */
  recordIntent(input: OfflineIntentInput): Promise<AcceptedOfflineIntent>;
  /** Enabled intent operations + device-local intent history. */
  getLocalIntents(): Promise<LocalIntentsState>;
  /** Every offline command across lanes with its honest status, evidence and allowed actions. */
  getReviewItems(query: ReviewQuery): Promise<ReadonlyArray<ReviewItem>>;
  /** Re-queue the EXACT same blocked command (idempotent by actionId; audited). */
  reviewRetry(input: ReviewRetryInput): Promise<ReviewActionResult>;
  /** Submit an explicit, signed resolution request for a blocked/needs-review command (audited). */
  reviewRequestResolution(input: ReviewResolutionInput): Promise<ReviewActionResult>;
}

export const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  customers: "offline:get-offline-customers",
  recordPayment: "offline:record-customer-payment",
  acceptCash: "offline:accept-cash-sale",
  previewVoucher: "offline:preview-voucher",
  addCustomer: "offline:add-customer",
  recordAttendance: "offline:record-attendance-event",
  localAttendance: "offline:get-local-attendance",
  prepareReturnGrant: "offline:prepare-return-grant",
  returnGrants: "offline:get-return-grants",
  recordReturn: "offline:record-return",
  localReturns: "offline:get-local-returns",
  receipt: "offline:get-local-receipt",
  unacknowledged: "offline:get-unacknowledged-sales",
  acknowledge: "offline:acknowledge-sale",
  pendingSummary: "offline:get-pending-sync-summary",
  localReport: "offline:get-local-report",
  syncStatus: "offline:get-sync-status",
  requestSync: "offline:request-sync",
  bootstrap: "offline:bootstrap",
  verifyPin: "offline:verify-staff-pin",
  endStaffSession: "offline:end-staff-session",
  recordIntent: "offline:record-intent",
  localIntents: "offline:get-local-intents",
  reviewItems: "offline:get-review-items",
  reviewRetry: "offline:review-retry",
  reviewResolution: "offline:review-request-resolution",
});
