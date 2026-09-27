/* eslint-disable @typescript-eslint/no-require-imports */
// Packaged Electron crash proof for offline-sale acknowledgement recovery (P1-3).
//   prepare      — enroll + install a signed offline grant
//   accept-crash — accept a local cash sale, then terminate BEFORE acknowledgement
//   restart      — reopen; the exact committed sale must be recoverable and unacknowledged; after
//                  acknowledgement it must leave recovery and a new sale gets a distinct identity
const { app, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const { OfflineAuthorityStore } = require(
  path.join(root, "dist-electron/main/offline/authority-store.js"),
);
const { LocalDatabase, localDatabasePath } = require(
  path.join(root, "dist-electron/main/offline/database.js"),
);
const { DeviceKeyStore } = require(path.join(root, "dist-electron/main/offline/device-key.js"));
const { OfflineSaleService } = require(
  path.join(root, "dist-electron/main/offline/offline-service.js"),
);

const userData = app.getPath("userData");
const phase = process.argv.includes("--phase=restart")
  ? "restart"
  : process.argv.includes("--phase=accept-crash")
    ? "accept-crash"
    : "prepare";

const ids = {
  tenant: "91000000-0000-4000-8000-000000000001",
  device: "91000000-0000-4000-8000-000000000002",
  credential: "91000000-0000-4000-8000-000000000003",
  register: "91000000-0000-4000-8000-000000000004",
  branch: "91000000-0000-4000-8000-000000000005",
  location: "91000000-0000-4000-8000-000000000006",
  membership: "91000000-0000-4000-8000-000000000007",
  grant: "91000000-0000-4000-8000-000000000008",
  snapshot: "91000000-0000-4000-8000-000000000009",
  product: "91000000-0000-4000-8000-000000000010",
  brand: "91000000-0000-4000-8000-000000000011",
  variant: "91000000-0000-4000-8000-000000000012",
  price: "91000000-0000-4000-8000-000000000013",
};

function protectedStorage() {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptStringAsync: (plaintext) => safeStorage.encryptStringAsync(plaintext),
    decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
  };
}

const reportPath = (name) => path.join(userData, `${name}.json`);

function keyStore() {
  return new DeviceKeyStore(app.getPath("userData"), protectedStorage(), () =>
    session.defaultSession.flushStorageData(),
  );
}

async function preparePhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  const publicKey = await keys.ensureKeyReady();
  const authority = new OfflineAuthorityStore(database);
  const observedAt = new Date();
  const issuedAt = new Date(observedAt.valueOf() - 60_000).toISOString();
  const validUntil = new Date(observedAt.valueOf() + 60 * 60_000).toISOString();
  authority.prepareEnrollment(ids.tenant, ids.register, publicKey, observedAt.toISOString());
  authority.completeEnrollment(
    {
      deviceId: ids.device,
      credentialId: ids.credential,
      registerId: ids.register,
      status: "active",
      publicKeyFingerprint: publicKey.fingerprint,
      activatedAt: issuedAt,
      revokedAt: null,
    },
    ids.tenant,
    observedAt.toISOString(),
  );
  authority.installBootstrap(
    {
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
      issuedAt,
      operatorExpiresAt: validUntil,
      catalogValidUntil: validUntil,
      acceptedUntil: validUntil,
      policy: {
        enabled: true,
        operatorLeaseSeconds: 3_600,
        catalogGrantSeconds: 3_600,
        maxSaleAmountMinor: 100_000,
        maxCumulativeExposureMinor: 500_000,
        maxQuantityPerLine: 20,
        maxPendingOfflineSales: 50,
      },
      catalog: [
        {
          productId: ids.product,
          brandId: ids.brand,
          name: "Ack Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "ACK-BLK-M",
              optionSummary: "Black / M",
              active: true,
              authorizedUnitPriceMinor: 2_599,
              priceId: ids.price,
              priceVersion: issuedAt,
              advisoryInventory: { onHandQuantity: 10, version: 7, asOf: issuedAt },
            },
          ],
        },
      ],
    },
    observedAt.toISOString(),
  );
  database.close();
  app.quit();
}

async function acceptCrashPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const accepted = sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 3_000,
  });
  fs.writeFileSync(
    reportPath("accepted"),
    JSON.stringify({ localSaleId: accepted.localSaleId, localReceiptId: accepted.localReceiptId }),
  );
  // Crash synchronously: the sale is durably committed but was never acknowledged by the cashier.
  process.reallyExit(86);
}

async function restartPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const accepted = JSON.parse(fs.readFileSync(reportPath("accepted"), "utf8"));
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);

  const pendingBefore = sales.getUnacknowledgedSales();
  const recovered = pendingBefore.find((sale) => sale.localSaleId === accepted.localSaleId);
  const acknowledgedResult = recovered ? sales.acknowledgeSale(accepted.localSaleId) : null;
  const pendingAfterAck = sales.getUnacknowledgedSales();

  // A genuinely new sale after acknowledgement must have a distinct identity (never a silent dup).
  const second = sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 3_000,
  });

  fs.writeFileSync(
    reportPath("restart"),
    JSON.stringify({
      recoveredExactSale: Boolean(recovered),
      recoveredUnacknowledged: recovered ? recovered.acknowledgedAt === null : false,
      recoveredReceiptId: recovered ? recovered.localReceiptId : null,
      acknowledgedAt: acknowledgedResult ? acknowledgedResult.acknowledgedAt : null,
      pendingCountBefore: pendingBefore.length,
      remainingAfterAck: pendingAfterAck.some((s) => s.localSaleId === accepted.localSaleId),
      secondSaleDistinct: second.localSaleId !== accepted.localSaleId,
    }),
  );
  database.close();
  app.quit();
}

app
  .whenReady()
  .then(() =>
    phase === "prepare"
      ? preparePhase()
      : phase === "accept-crash"
        ? acceptCrashPhase()
        : restartPhase(),
  )
  .catch((error) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(reportPath("acceptance-error"), String(error?.stack ?? error));
    app.exit(1);
  });
