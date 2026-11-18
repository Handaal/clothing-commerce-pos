import type {
  AcceptedOfflineIntent,
  LocalIntentsState,
  OfflineIntentInput,
  ReviewActionResult,
  ReviewItem,
  ReviewQuery,
  ReviewResolutionInput,
  ReviewRetryInput,
  AcceptedOfflineAttendanceEvent,
  AcceptedOfflinePayment,
  AcceptedOfflineSale,
  CachedCatalogItem,
  AcceptedOfflineReturn,
  LocalAttendanceState,
  LocalReceipt,
  LocalReturnsState,
  OfflineAttendanceEventInput,
  OfflineReturnGrantView,
  OfflineReturnInput,
  PrepareReturnGrantInput,
  OfflineCustomer,
  OfflineCustomerPaymentInput,
  OfflineBootstrapInput,
  OfflineBootstrapResult,
  OfflineLocalReport,
  OfflineReadiness,
  OfflineSaleInput,
  OfflineVoucherPreview,
  OfflineVoucherPreviewInput,
  OfflineNewCustomerInput,
  AcceptedOfflineCustomer,
  OfflineStaffPinInput,
  OfflineStaffPinResult,
  OfflineSyncStatus,
  PendingSyncSummary,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { ActivityStore } from "../activity/store";
import { OfflineAuthorityStore } from "./authority-store";
import { OfflineBootstrapService } from "./bootstrap";
import { LocalDatabase, localDatabasePath } from "./database";
import { DeviceKeyStore, type OsSecureStorage } from "./device-key";
import { OverrideRosterStore, overrideRosterPath } from "./override-roster";
import { CustomerOutboxStore } from "./customer-outbox-store";
import { SaleHoldOutboxStore, type SaleHoldSigner } from "./sale-hold-outbox-store";
import { OfflineAcceptanceError, OfflineSaleService } from "./offline-service";
import { OutboxStore } from "./outbox-store";
import { PaymentOutboxStore } from "./payment-outbox-store";
import { AttendanceOutboxStore } from "./attendance-outbox-store";
import { ReturnOutboxStore } from "./return-outbox-store";
import { IntentOutboxStore } from "./intent-outbox-store";
import { OfflineIntentService } from "./intent-service";
import { OfflineReviewService } from "./review-service";
import {
  OfflineReturnService,
  SdkReturnGrantIssuer,
  type ReturnGrantIssuer,
} from "./return-service";
import { StaffRosterStore } from "./staff-roster";
import { OfflinePinEnrollmentStore, offlinePinEnrollmentPath } from "./offline-pin-enrollment";
import {
  OfflinePinEnroller,
  type OfflinePinEnrollmentInput,
  type OfflinePinRefreshResult,
} from "./offline-pin-enroller";
import { LocalUserStore } from "../local-users/store";
import { ReturnService } from "../returns/service";
import { ReturnStore } from "../returns/store";
import { ConnectedSaleService } from "../sales/service";
import { ConnectedSaleStore } from "../sales/store";
import {
  OfflineSyncWorker,
  SdkOfflineDeliveryClient,
  canonicalizeSaleHold,
  type OfflineDeliveryClient,
  type SyncWorkerTestSeam,
} from "./sync-worker";

export interface OfflineRuntimeOptions {
  readonly now?: () => Date;
  readonly secureStorageDurabilityBarrier?: () => Promise<void>;
  readonly networkOnline?: () => boolean;
  readonly deliveryClient?: OfflineDeliveryClient;
  readonly syncTestSeam?: SyncWorkerTestSeam;
  readonly startSyncWorker?: boolean;
  readonly syncPollIntervalMs?: number;
  /** Test seam for the online return-grant fetch (defaults to the SDK over `apiBaseUrl`). */
  readonly returnGrantIssuer?: ReturnGrantIssuer;
}

/** ADR-042 §13: deterministic online-required refusal for the retired offline-return lane. */
export function offlineReturnsDisabled(): OfflineAcceptanceError {
  return new OfflineAcceptanceError(
    "OFFLINE_RETURNS_DISABLED",
    "Returns are online-only. Reconnect and use the Returns desk; nothing was recorded.",
  );
}

export class OfflineRuntime {
  private constructor(
    private readonly database: LocalDatabase | undefined,
    private readonly sales: OfflineSaleService | undefined,
    private readonly bootstrapService: OfflineBootstrapService | undefined,
    readonly outbox: OutboxStore | undefined,
    private readonly syncWorker: OfflineSyncWorker | undefined,
    private readonly initializationError: string | undefined,
    private readonly returnService?: ReturnService,
    private readonly saleService?: ConnectedSaleService,
    private readonly activityStore?: ActivityStore,
    private readonly staffRoster?: StaffRosterStore,
    private readonly userStore?: LocalUserStore,
    private readonly offlineReturns?: OfflineReturnService,
    private readonly offlineIntents?: OfflineIntentService,
    private readonly review?: OfflineReviewService,
    private readonly pinEnroller?: OfflinePinEnroller,
  ) {
    this.sales?.setOperatorResolver(() => this.currentOperatorMembershipId());
  }

  /** ADR-043 §5.1: member who unlocked offline with a VERIFIED PIN on this till (main-process state only). */
  private offlineOperatorId: string | null = null;
  private sessionOperator: () => string | null = () => null;

  /** The main process supplies the signed-in online operator (used when no offline unlock is active). */
  setSessionOperatorResolver(resolver: () => string | null): void {
    this.sessionOperator = resolver;
  }

  /** End the offline staff session (sign-out / back to the login, or an online sign-in took over). */
  endStaffSession(): void {
    this.offlineOperatorId = null;
  }

  /** Current operator stamped into new offline sales (null => grant operator attribution). */
  currentOperatorMembershipId(): string | null {
    return this.offlineOperatorId ?? this.sessionOperator();
  }

  static async initialize(
    userDataPath: string,
    secureStorage: OsSecureStorage,
    apiBaseUrl: string,
    options: OfflineRuntimeOptions = {},
  ): Promise<OfflineRuntime> {
    const now = options.now ?? (() => new Date());
    let database: LocalDatabase | undefined;
    try {
      database = new LocalDatabase(localDatabasePath(userDataPath), { now });
      const keys = new DeviceKeyStore(
        userDataPath,
        secureStorage,
        options.secureStorageDurabilityBarrier,
      );
      try {
        await keys.initializeIfPresent();
      } catch {
        // The runtime remains available for connected selling and support reads. Readiness performs
        // the same key validation and fails closed with PRIVATE_KEY_UNAVAILABLE.
      }
      const authority = new OfflineAuthorityStore(database);
      // ADR-042 §6.3: admin override verifiers, sealed with the OS key store in their own file.
      const overrideRoster = new OverrideRosterStore(
        overrideRosterPath(userDataPath),
        secureStorage,
        now,
      );
      // Offline PIN v2: device-local, OS-sealed verifiers (never sent to or minted by the server).
      const pinEnrollments = new OfflinePinEnrollmentStore(
        offlinePinEnrollmentPath(userDataPath),
        secureStorage,
        now,
      );
      const sales = new OfflineSaleService(database, keys, now, undefined, overrideRoster);
      const intents = new OfflineIntentService(database, keys, () => sales.getReadiness(), now);
      const outbox = new OutboxStore(database, now);
      outbox.recoverExpiredLeases();
      const paymentOutbox = new PaymentOutboxStore(database, now);
      paymentOutbox.recoverExpiredLeases();
      const attendanceOutbox = new AttendanceOutboxStore(database, now);
      attendanceOutbox.recoverExpiredLeases();
      const returnOutbox = new ReturnOutboxStore(database, now);
      returnOutbox.recoverExpiredLeases();
      const intentOutbox = new IntentOutboxStore(database, now);
      intentOutbox.recoverExpiredLeases();
      const customerOutbox = new CustomerOutboxStore(database, now);
      customerOutbox.recoverExpiredLeases();
      const saleHoldOutbox = new SaleHoldOutboxStore(database, now);
      saleHoldOutbox.recoverExpiredLeases();
      const holdDatabase = database;
      const saleHoldSigner: SaleHoldSigner = {
        sign: (canonical) => keys.signCanonical(canonical),
        credentialId: () => {
          const row = holdDatabase.connection
            .prepare("SELECT credential_id FROM device_state WHERE status = 'active'")
            .get() as { credential_id: string } | undefined;
          if (!row) throw new Error("No active device credential to sign the sale hold.");
          return row.credential_id;
        },
        canonicalize: canonicalizeSaleHold,
      };
      const syncWorker = new OfflineSyncWorker(
        outbox,
        options.deliveryClient ?? new SdkOfflineDeliveryClient(apiBaseUrl),
        {
          now,
          networkOnline: options.networkOnline,
          pollIntervalMs: options.syncPollIntervalMs,
          testSeam: options.syncTestSeam,
          paymentOutbox,
          attendanceOutbox,
          returnOutbox,
          intentOutbox,
          customerOutbox,
          saleHoldOutbox,
          saleHoldSigner,
        },
      );
      // Eager evaluation loads enrolled state and verifies the protected key without requiring it
      // on a connected-only installation that has never enrolled for offline operation.
      sales.getReadiness();
      const runtime = new OfflineRuntime(
        database,
        sales,
        new OfflineBootstrapService(apiBaseUrl, authority, keys, now, overrideRoster),
        outbox,
        syncWorker,
        undefined,
        new ReturnService(new ReturnStore(database, now), apiBaseUrl.replace(/\/+$/, ""), {
          networkOnline: options.networkOnline,
        }),
        new ConnectedSaleService(
          new ConnectedSaleStore(database, now),
          apiBaseUrl.replace(/\/+$/, ""),
          { networkOnline: options.networkOnline },
        ),
        // Client-only activity ledger. Available whenever the local database is healthy, independent
        // of offline-selling enrollment.
        new ActivityStore(database.connection),
        new StaffRosterStore(database, now, pinEnrollments),
        // Device-local POS floor-staff accounts (the shifted-cafe login model). Available whenever the
        // local database is healthy, independent of offline-selling enrollment.
        new LocalUserStore(database, now),
        new OfflineReturnService(
          database,
          keys,
          options.returnGrantIssuer ?? new SdkReturnGrantIssuer(apiBaseUrl),
          now,
          overrideRoster,
        ),
        intents,
        new OfflineReviewService(database, intents, now),
        new OfflinePinEnroller(database, pinEnrollments, apiBaseUrl),
      );
      if (options.startSyncWorker !== false) syncWorker.start();
      return runtime;
    } catch (error) {
      database?.close();
      const message = error instanceof Error ? error.message : "Unknown local persistence failure.";
      return new OfflineRuntime(undefined, undefined, undefined, undefined, undefined, message);
    }
  }

  getReadiness(): OfflineReadiness {
    if (!this.sales) {
      return {
        ready: false,
        reason: "DATABASE_UNHEALTHY",
        message: this.initializationError ?? "Local persistence is unavailable.",
      };
    }
    return this.sales.getReadiness();
  }

  getReturns(): ReturnService {
    if (!this.returnService)
      throw new Error(
        "Connected return persistence is unavailable. Return submission is disabled.",
      );
    return this.returnService;
  }

  getActivityStore(): ActivityStore | undefined {
    return this.activityStore;
  }

  getUserStore(): LocalUserStore | undefined {
    return this.userStore;
  }

  getSales(): ConnectedSaleService {
    if (!this.saleService)
      throw new Error("Connected sale persistence is unavailable. Connected sales are disabled.");
    return this.saleService;
  }

  getCachedCatalog(): ReadonlyArray<CachedCatalogItem> {
    return this.requireSales().getCachedCatalog();
  }

  getProjectedInventory(): ReadonlyArray<ProjectedInventoryItem> {
    return this.requireSales().getProjectedInventory();
  }

  getOfflineCustomers(): ReadonlyArray<OfflineCustomer> {
    return this.requireSales().getOfflineCustomers();
  }

  recordCustomerPayment(input: OfflineCustomerPaymentInput): AcceptedOfflinePayment {
    const result = this.requireSales().recordCustomerPayment(input);
    void this.syncWorker?.requestRun();
    return result;
  }

  recordAttendanceEvent(input: OfflineAttendanceEventInput): AcceptedOfflineAttendanceEvent {
    const result = this.requireSales().recordAttendanceEvent(input);
    void this.syncWorker?.requestRun();
    return result;
  }

  getLocalAttendance(membershipId?: string): LocalAttendanceState {
    if (!this.sales) return { lastEvent: null, pending: 0, recent: [] };
    return this.sales.getLocalAttendance(membershipId);
  }

  // ADR-042 §13: returns are ONLINE-ONLY. The offline-return lane is retired at the main-process boundary:
  // no grant is prepared and no offline return is recorded, signed or queued (the renderer no longer offers
  // it, and a stale renderer/IPC caller gets a deterministic refusal). Online returns use the Returns desk.
  prepareReturnGrant(input: PrepareReturnGrantInput): Promise<OfflineReturnGrantView> {
    void input;
    return Promise.reject(offlineReturnsDisabled());
  }

  getReturnGrants(): ReadonlyArray<OfflineReturnGrantView> {
    return this.offlineReturns?.getGrants() ?? [];
  }

  recordReturn(input: OfflineReturnInput): AcceptedOfflineReturn {
    void input;
    throw offlineReturnsDisabled();
  }

  recordIntent(input: OfflineIntentInput): AcceptedOfflineIntent {
    if (!this.offlineIntents)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    const result = this.offlineIntents.recordIntent(input);
    void this.syncWorker?.requestRun();
    return result;
  }

  getLocalIntents(): LocalIntentsState {
    return (
      this.offlineIntents?.getLocalIntents() ?? { enabledOperations: [], pending: 0, recent: [] }
    );
  }

  getReviewItems(query: ReviewQuery): ReadonlyArray<ReviewItem> {
    return this.review?.list(query) ?? [];
  }

  reviewRetry(input: ReviewRetryInput): ReviewActionResult {
    if (!this.review)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    const result = this.review.retry(input);
    if (result.outcome === "requeued") void this.syncWorker?.requestRun();
    return result;
  }

  reviewRequestResolution(input: ReviewResolutionInput): ReviewActionResult {
    if (!this.review)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    const result = this.review.requestResolution(input);
    if (result.outcome === "requested") void this.syncWorker?.requestRun();
    return result;
  }

  getLocalReturns(): LocalReturnsState {
    return this.offlineReturns?.getLocalReturns() ?? { pending: 0, recent: [] };
  }

  acceptCashSale(input: OfflineSaleInput): AcceptedOfflineSale {
    return this.requireSales().acceptCashSale(input);
  }

  previewOfflineVoucher(input: OfflineVoucherPreviewInput): OfflineVoucherPreview {
    return this.requireSales().previewVoucher(input);
  }

  addOfflineCustomer(input: OfflineNewCustomerInput): AcceptedOfflineCustomer {
    const accepted = this.requireSales().acceptNewCustomer(input);
    void this.syncWorker?.requestRun();
    return accepted;
  }

  getLocalReceipt(localSaleId: string): LocalReceipt | null {
    return this.requireSales().getLocalReceipt(localSaleId);
  }

  getUnacknowledgedSales(): ReadonlyArray<LocalReceipt> {
    return this.requireSales().getUnacknowledgedSales();
  }

  acknowledgeSale(localSaleId: string): LocalReceipt {
    return this.requireSales().acknowledgeSale(localSaleId);
  }

  getPendingSyncSummary(): PendingSyncSummary {
    return this.requireSales().getPendingSyncSummary();
  }

  getLocalReport(): OfflineLocalReport {
    // Resilient like getSyncStatus: before local persistence is initialized there is simply no
    // on-device activity to report, so return an honest empty projection rather than throwing.
    if (!this.sales) {
      return {
        generatedAt: new Date().toISOString(),
        currency: null,
        coverageFrom: null,
        coverageTo: null,
        sales: { count: 0, grossMinor: 0, collectedMinor: 0, outstandingMinor: 0 },
        lifecycle: { acceptedPendingSync: 0, synced: 0, needsReconciliation: 0 },
        customerPayments: { count: 0, totalMinor: 0 },
        unacknowledged: 0,
        pending: 0,
        blocked: 0,
      };
    }
    return this.sales.getLocalReport();
  }

  getSyncStatus(): OfflineSyncStatus {
    if (!this.syncWorker) {
      return {
        pending: 0,
        leased: 0,
        retryWait: 0,
        blocked: 0,
        synced: 0,
        needsReconciliation: 0,
        networkOnline: false,
        synchronizing: false,
        lastAttemptAt: null,
        lastError: this.initializationError ?? "Local synchronization is unavailable.",
      };
    }
    return this.syncWorker.getStatus();
  }

  async requestSync(): Promise<OfflineSyncStatus> {
    if (!this.syncWorker) throw new Error(this.initializationError ?? "Local sync unavailable.");
    await this.syncWorker.requestRun();
    return this.syncWorker.getStatus();
  }

  /**
   * Offline PIN v2, same-PIN model: called by the main process right after a SUCCESSFUL online sign-in with the
   * credential the server just accepted. Prepares offline sign-in on this till with that same PIN. Never throws,
   * never reaches the renderer, never logs the PIN.
   */
  async refreshOfflinePinAfterSignIn(
    input: OfflinePinEnrollmentInput,
  ): Promise<OfflinePinRefreshResult> {
    if (!this.pinEnroller) return { status: "skipped", reason: "TILL_NOT_ENROLLED" };
    return this.pinEnroller.refreshAfterSignIn(input);
  }

  verifyStaffPin(input: OfflineStaffPinInput): OfflineStaffPinResult {
    if (!this.staffRoster) return { ok: false, reason: "UNAVAILABLE" };
    const result = this.staffRoster.verifyPin(input);
    // Only a successful device-bound verification can set the operator; a failure never changes it.
    if (result.ok) this.offlineOperatorId = result.operator.membershipId;
    return result;
  }

  async bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult> {
    if (!this.bootstrapService)
      throw new Error(this.initializationError ?? "Offline bootstrap unavailable.");
    const result = await this.bootstrapService.bootstrap(input);
    // Offline PIN v2: revocations take effect on this device at the first successful online bootstrap.
    this.staffRoster?.pruneToAuthorized();
    void this.syncWorker?.requestRun();
    return result;
  }

  close(): void {
    this.syncWorker?.stop();
    this.database?.close();
  }

  private requireOfflineReturns(): OfflineReturnService {
    if (!this.offlineReturns)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    return this.offlineReturns;
  }

  private requireSales(): OfflineSaleService {
    if (!this.sales)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    return this.sales;
  }
}
