import type {
  AcceptedOfflineAttendanceEvent,
  AcceptedOfflinePayment,
  AcceptedOfflineSale,
  CachedCatalogItem,
  LocalAttendanceState,
  LocalReceipt,
  OfflineAttendanceEventInput,
  OfflineCustomer,
  OfflineCustomerPaymentInput,
  OfflineBootstrapInput,
  OfflineBootstrapResult,
  OfflineLocalReport,
  OfflineReadiness,
  OfflineSaleInput,
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
import { OfflineSaleService } from "./offline-service";
import { OutboxStore } from "./outbox-store";
import { PaymentOutboxStore } from "./payment-outbox-store";
import { AttendanceOutboxStore } from "./attendance-outbox-store";
import { StaffRosterStore } from "./staff-roster";
import { LocalUserStore } from "../local-users/store";
import { ReturnService } from "../returns/service";
import { ReturnStore } from "../returns/store";
import { ConnectedSaleService } from "../sales/service";
import { ConnectedSaleStore } from "../sales/store";
import {
  OfflineSyncWorker,
  SdkOfflineDeliveryClient,
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
  ) {}

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
      const sales = new OfflineSaleService(database, keys, now);
      const outbox = new OutboxStore(database, now);
      outbox.recoverExpiredLeases();
      const paymentOutbox = new PaymentOutboxStore(database, now);
      paymentOutbox.recoverExpiredLeases();
      const attendanceOutbox = new AttendanceOutboxStore(database, now);
      attendanceOutbox.recoverExpiredLeases();
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
        },
      );
      // Eager evaluation loads enrolled state and verifies the protected key without requiring it
      // on a connected-only installation that has never enrolled for offline operation.
      sales.getReadiness();
      const runtime = new OfflineRuntime(
        database,
        sales,
        new OfflineBootstrapService(apiBaseUrl, authority, keys, now),
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
        new StaffRosterStore(database, now),
        // Device-local POS floor-staff accounts (the shifted-cafe login model). Available whenever the
        // local database is healthy, independent of offline-selling enrollment.
        new LocalUserStore(database, now),
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

  getLocalAttendance(): LocalAttendanceState {
    if (!this.sales) return { lastEvent: null, pending: 0, recent: [] };
    return this.sales.getLocalAttendance();
  }

  acceptCashSale(input: OfflineSaleInput): AcceptedOfflineSale {
    return this.requireSales().acceptCashSale(input);
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

  verifyStaffPin(input: OfflineStaffPinInput): OfflineStaffPinResult {
    if (!this.staffRoster) return { ok: false, reason: "UNAVAILABLE" };
    return this.staffRoster.verifyPin(input);
  }

  async bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult> {
    if (!this.bootstrapService)
      throw new Error(this.initializationError ?? "Offline bootstrap unavailable.");
    const result = await this.bootstrapService.bootstrap(input);
    void this.syncWorker?.requestRun();
    return result;
  }

  close(): void {
    this.syncWorker?.stop();
    this.database?.close();
  }

  private requireSales(): OfflineSaleService {
    if (!this.sales)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    return this.sales;
  }
}
