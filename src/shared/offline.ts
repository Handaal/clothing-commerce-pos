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

export interface OfflineSaleInput {
  readonly lines: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
  readonly cashReceivedMinor: number;
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
}

export interface LocalReceipt {
  readonly localSaleId: string;
  readonly localReceiptId: string;
  readonly lifecycle: "accepted_pending_sync" | "synced" | "needs_reconciliation";
  readonly acceptedAt: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly cashReceivedMinor: number;
  readonly changeMinor: number;
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

export interface PendingSyncSummary {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly blocked: number;
}

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
}

export interface OfflineBridge {
  getReadiness(): Promise<OfflineReadiness>;
  getCachedCatalog(): Promise<ReadonlyArray<CachedCatalogItem>>;
  getProjectedInventory(): Promise<ReadonlyArray<ProjectedInventoryItem>>;
  acceptCashSale(input: OfflineSaleInput): Promise<AcceptedOfflineSale>;
  getLocalReceipt(localSaleId: string): Promise<LocalReceipt | null>;
  getPendingSyncSummary(): Promise<PendingSyncSummary>;
  bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult>;
}

export const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  acceptCash: "offline:accept-cash-sale",
  receipt: "offline:get-local-receipt",
  pendingSummary: "offline:get-pending-sync-summary",
  bootstrap: "offline:bootstrap",
});
