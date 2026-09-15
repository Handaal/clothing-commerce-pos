import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
} from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { OfflineAuthorityStore } from "../../src/main/offline/authority-store";
import { LocalDatabase } from "../../src/main/offline/database";
import { DeviceKeyStore, type OsSecureStorage } from "../../src/main/offline/device-key";
import { OfflineSaleService } from "../../src/main/offline/offline-service";
import { OutboxStore } from "../../src/main/offline/outbox-store";

export const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  device: "10000000-0000-4000-8000-000000000002",
  credential: "10000000-0000-4000-8000-000000000003",
  register: "10000000-0000-4000-8000-000000000004",
  branch: "10000000-0000-4000-8000-000000000005",
  location: "10000000-0000-4000-8000-000000000006",
  membership: "10000000-0000-4000-8000-000000000007",
  grant: "10000000-0000-4000-8000-000000000008",
  snapshot: "10000000-0000-4000-8000-000000000009",
  product: "10000000-0000-4000-8000-000000000010",
  brand: "10000000-0000-4000-8000-000000000011",
  variant: "10000000-0000-4000-8000-000000000012",
  price: "10000000-0000-4000-8000-000000000013",
} as const;

export function ingestionResponse(
  localSaleId: string,
  syncStatus: "synced" | "needs_reconciliation" = "synced",
): IngestOfflineSaleResponse {
  const receivedAt = "2026-09-08T12:00:10.000Z";
  const orderId = "20000000-0000-4000-8000-000000000001";
  const paymentId = "20000000-0000-4000-8000-000000000002";
  return {
    syncStatus,
    ingestionId: "20000000-0000-4000-8000-000000000003",
    localSaleId,
    receivedAt,
    order: {
      id: orderId,
      orderNumber: "POS-OFFLINE-1",
      channel: "pos",
      status: "placed",
      brandId: ids.brand,
      branchId: ids.branch,
      registerId: ids.register,
      currency: "USD",
      totalMinor: 2_599,
      actorMembershipId: ids.membership,
      placedAt: receivedAt,
      cancelledAt: null,
      cancelledByMembershipId: null,
      cancellationReason: null,
      notes: null,
      createdAt: receivedAt,
      updatedAt: receivedAt,
      lines: [
        {
          id: "20000000-0000-4000-8000-000000000004",
          lineNumber: 1,
          variantId: ids.variant,
          quantity: 1,
          unitPriceMinor: 2_599,
          lineTotalMinor: 2_599,
          productName: "Foundation Tee",
          variantName: "Black / M",
          sku: "TEE-BLK-M",
          optionSummary: "Black / M",
        },
      ],
    },
    payment: {
      id: paymentId,
      orderId,
      method: "cash",
      status: "captured",
      currency: "USD",
      amountMinor: 2_599,
      cashReceivedMinor: 3_000,
      changeMinor: 401,
      capturedByMembershipId: ids.membership,
      capturedAt: receivedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    },
    fulfillment:
      syncStatus === "synced"
        ? {
            id: "20000000-0000-4000-8000-000000000005",
            orderId,
            inventoryLocationId: ids.location,
            inventoryOperationId: "20000000-0000-4000-8000-000000000006",
            actorMembershipId: ids.membership,
            fulfilledAt: receivedAt,
            createdAt: receivedAt,
            lines: [
              {
                id: "20000000-0000-4000-8000-000000000007",
                lineNumber: 1,
                orderLineId: "20000000-0000-4000-8000-000000000004",
                variantId: ids.variant,
                quantity: 1,
              },
            ],
          }
        : null,
    reconciliation:
      syncStatus === "needs_reconciliation"
        ? {
            id: "20000000-0000-4000-8000-000000000008",
            reason: "insufficient_stock_at_ingestion",
            status: "open",
            createdAt: receivedAt,
            updatedAt: receivedAt,
          }
        : null,
  };
}

export class TestSecureStorage implements OsSecureStorage {
  constructor(readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plaintext: string): Buffer {
    if (!this.available) throw new Error("unavailable");
    return Buffer.from([...plaintext].reverse().join(""), "utf8");
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error("unavailable");
    return [...encrypted.toString("utf8")].reverse().join("");
  }
}

export function bootstrapFixture(
  overrides: Partial<OfflineBootstrapResponse> = {},
): OfflineBootstrapResponse {
  return {
    grantId: ids.grant,
    snapshotId: ids.snapshot,
    schemaVersion: 1,
    minimumClientVersion: "0.5.0",
    tenantId: ids.tenant,
    deviceId: ids.device,
    registerId: ids.register,
    branchId: ids.branch,
    inventoryLocationId: ids.location,
    operatorMembershipId: ids.membership,
    currency: "USD",
    issuedAt: "2026-09-08T10:00:00.000Z",
    operatorExpiresAt: "2026-09-08T20:00:00.000Z",
    catalogValidUntil: "2026-09-08T20:00:00.000Z",
    acceptedUntil: "2026-09-08T20:00:00.000Z",
    policy: {
      enabled: true,
      operatorLeaseSeconds: 36_000,
      catalogGrantSeconds: 36_000,
      maxSaleAmountMinor: 100_000,
      maxCumulativeExposureMinor: 500_000,
      maxQuantityPerLine: 20,
      maxPendingOfflineSales: 50,
    },
    catalog: [
      {
        productId: ids.product,
        brandId: ids.brand,
        name: "Foundation Tee",
        active: true,
        variants: [
          {
            variantId: ids.variant,
            sku: "TEE-BLK-M",
            optionSummary: "Black / M",
            active: true,
            authorizedUnitPriceMinor: 2_599,
            priceId: ids.price,
            priceVersion: "2026-09-08T09:00:00.000Z",
            advisoryInventory: {
              onHandQuantity: 10,
              version: 4,
              asOf: "2026-09-08T09:55:00.000Z",
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

export interface OfflineHarness {
  readonly directory: string;
  readonly database: LocalDatabase;
  readonly keys: DeviceKeyStore;
  readonly authority: OfflineAuthorityStore;
  readonly sales: OfflineSaleService;
  readonly outbox: OutboxStore;
  dispose(): void;
}

export function makeHarness(options?: {
  readonly now?: () => Date;
  readonly bootstrap?: OfflineBootstrapResponse;
  readonly install?: boolean;
  readonly enroll?: boolean;
  readonly saleTestSeam?: ConstructorParameters<typeof OfflineSaleService>[3];
  readonly cacheTestSeam?: ConstructorParameters<typeof OfflineAuthorityStore>[1];
}): OfflineHarness {
  const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-offline-test-"));
  mkdirSync(directory, { recursive: true });
  const now = options?.now ?? (() => new Date("2026-09-08T12:00:00.000Z"));
  const database = new LocalDatabase(path.join(directory, "ledger.sqlite3"), { now });
  const keys = new DeviceKeyStore(directory, new TestSecureStorage());
  const publicKey = keys.ensureKey();
  const authority = new OfflineAuthorityStore(database, options?.cacheTestSeam);
  if (options?.enroll !== false) {
    authority.prepareEnrollment(ids.tenant, ids.register, publicKey, now().toISOString());
    authority.completeEnrollment(
      {
        deviceId: ids.device,
        credentialId: ids.credential,
        registerId: ids.register,
        status: "active",
        publicKeyFingerprint: publicKey.fingerprint,
        activatedAt: "2026-09-08T10:00:00.000Z",
        revokedAt: null,
      },
      ids.tenant,
      now().toISOString(),
    );
  }
  if (options?.install !== false) {
    if (options?.enroll === false) throw new Error("A fixture cache requires fixture enrollment.");
    authority.installBootstrap(options?.bootstrap ?? bootstrapFixture(), now().toISOString());
  }
  return {
    directory,
    database,
    keys,
    authority,
    sales: new OfflineSaleService(database, keys, now, options?.saleTestSeam),
    outbox: new OutboxStore(database, now),
    dispose() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
