import type {
  AcceptedOfflineSale,
  CachedCatalogItem,
  LocalReceipt,
  OfflineBootstrapInput,
  OfflineBootstrapResult,
  OfflineReadiness,
  OfflineSaleInput,
  PendingSyncSummary,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { OfflineAuthorityStore } from "./authority-store";
import { OfflineBootstrapService } from "./bootstrap";
import { LocalDatabase, localDatabasePath } from "./database";
import { DeviceKeyStore, type OsSecureStorage } from "./device-key";
import { OfflineSaleService } from "./offline-service";
import { OutboxStore } from "./outbox-store";

export class OfflineRuntime {
  private constructor(
    private readonly database: LocalDatabase | undefined,
    private readonly sales: OfflineSaleService | undefined,
    private readonly bootstrapService: OfflineBootstrapService | undefined,
    readonly outbox: OutboxStore | undefined,
    private readonly initializationError: string | undefined,
  ) {}

  static async initialize(
    userDataPath: string,
    secureStorage: OsSecureStorage,
    apiBaseUrl: string,
    now: () => Date = () => new Date(),
    secureStorageDurabilityBarrier: () => Promise<void> = async () => {},
  ): Promise<OfflineRuntime> {
    let database: LocalDatabase | undefined;
    try {
      database = new LocalDatabase(localDatabasePath(userDataPath), { now });
      const keys = new DeviceKeyStore(userDataPath, secureStorage, secureStorageDurabilityBarrier);
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
      // Eager evaluation loads enrolled state and verifies the protected key without requiring it
      // on a connected-only installation that has never enrolled for offline operation.
      sales.getReadiness();
      return new OfflineRuntime(
        database,
        sales,
        new OfflineBootstrapService(apiBaseUrl, authority, keys, now),
        outbox,
        undefined,
      );
    } catch (error) {
      database?.close();
      const message = error instanceof Error ? error.message : "Unknown local persistence failure.";
      return new OfflineRuntime(undefined, undefined, undefined, undefined, message);
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

  getCachedCatalog(): ReadonlyArray<CachedCatalogItem> {
    return this.requireSales().getCachedCatalog();
  }

  getProjectedInventory(): ReadonlyArray<ProjectedInventoryItem> {
    return this.requireSales().getProjectedInventory();
  }

  acceptCashSale(input: OfflineSaleInput): AcceptedOfflineSale {
    return this.requireSales().acceptCashSale(input);
  }

  getLocalReceipt(localSaleId: string): LocalReceipt | null {
    return this.requireSales().getLocalReceipt(localSaleId);
  }

  getPendingSyncSummary(): PendingSyncSummary {
    return this.requireSales().getPendingSyncSummary();
  }

  bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult> {
    if (!this.bootstrapService)
      throw new Error(this.initializationError ?? "Offline bootstrap unavailable.");
    return this.bootstrapService.bootstrap(input);
  }

  close(): void {
    this.database?.close();
  }

  private requireSales(): OfflineSaleService {
    if (!this.sales)
      throw new Error(this.initializationError ?? "Local persistence is unavailable.");
    return this.sales;
  }
}
