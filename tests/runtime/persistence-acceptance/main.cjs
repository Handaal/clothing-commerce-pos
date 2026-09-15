/* eslint-disable @typescript-eslint/no-require-imports */
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
const { OutboxStore } = require(path.join(root, "dist-electron/main/offline/outbox-store.js"));

const userData = app.getPath("userData");
const phase = process.argv.includes("--phase=restart")
  ? "restart"
  : process.argv.includes("--phase=accept")
    ? "accept"
    : "prepare";

const ids = {
  tenant: "90000000-0000-4000-8000-000000000001",
  device: "90000000-0000-4000-8000-000000000002",
  credential: "90000000-0000-4000-8000-000000000003",
  register: "90000000-0000-4000-8000-000000000004",
  branch: "90000000-0000-4000-8000-000000000005",
  location: "90000000-0000-4000-8000-000000000006",
  membership: "90000000-0000-4000-8000-000000000007",
  grant: "90000000-0000-4000-8000-000000000008",
  snapshot: "90000000-0000-4000-8000-000000000009",
  product: "90000000-0000-4000-8000-000000000010",
  brand: "90000000-0000-4000-8000-000000000011",
  variant: "90000000-0000-4000-8000-000000000012",
  price: "90000000-0000-4000-8000-000000000013",
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

function reportPath(name) {
  return path.join(userData, `${name}.json`);
}

function outboxFacts(database, syncCommandId) {
  return database.connection
    .prepare(
      `SELECT sync_command_id, payload_hash, state, attempts
       FROM outbox WHERE sync_command_id = ?`,
    )
    .get(syncCommandId);
}

async function preparePhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(app.getPath("userData")));
  const keys = new DeviceKeyStore(app.getPath("userData"), protectedStorage(), () =>
    session.defaultSession.flushStorageData(),
  );
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
          name: "Runtime Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "ACCEPT-BLK-M",
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
  fs.writeFileSync(
    reportPath("acceptance-prepared"),
    JSON.stringify({
      databasePath: database.path,
      sessionDataPath: app.getPath("sessionData"),
      osSecureStorageAvailable: safeStorage.isEncryptionAvailable(),
    }),
  );
  database.close();
  app.quit();
}

async function acceptPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(app.getPath("userData")));
  const keys = new DeviceKeyStore(app.getPath("userData"), protectedStorage(), () =>
    session.defaultSession.flushStorageData(),
  );
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const before = sales.getProjectedInventory()[0];
  const accepted = sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 2 }],
    cashReceivedMinor: 6_000,
  });
  const after = sales.getProjectedInventory()[0];
  const outbox = new OutboxStore(database);
  const claim = outbox.claimNext(1_000);
  const report = {
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      osSecureStorageAvailable: safeStorage.isEncryptionAvailable(),
    },
    databasePath: database.path,
    sessionDataPath: app.getPath("sessionData"),
    product: "Runtime Acceptance Tee",
    sku: "ACCEPT-BLK-M",
    cachedStock: before.snapshotOnHand,
    quantity: 2,
    projectedBefore: before.projectedAvailable,
    projectedAfter: after.projectedAvailable,
    totalMinor: accepted.totalMinor,
    cashReceivedMinor: accepted.cashReceivedMinor,
    changeMinor: accepted.changeMinor,
    localSaleId: accepted.localSaleId,
    localReceiptId: accepted.localReceiptId,
    syncCommandId: accepted.syncCommandId,
    payloadHash: outboxFacts(database, accepted.syncCommandId).payload_hash,
    lifecycle: accepted.lifecycle,
    claimedAttempt: claim.attempts,
    ingestionRequestsSent: 0,
    serverOrderCreated: false,
  };
  fs.writeFileSync(reportPath("acceptance-phase1"), JSON.stringify(report));
  // Intentionally bypass normal shutdown after the committed sale and leased outbox item.
  app.exit(0);
}

async function restartPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const phase1 = JSON.parse(fs.readFileSync(reportPath("acceptance-phase1"), "utf8"));
  const database = new LocalDatabase(localDatabasePath(app.getPath("userData")));
  const keys = new DeviceKeyStore(app.getPath("userData"), protectedStorage(), () =>
    session.defaultSession.flushStorageData(),
  );
  await keys.initializeIfPresent();
  keys.loadPublicKey();
  const sales = new OfflineSaleService(database, keys);
  const outbox = new OutboxStore(database);
  const recoveredLeases = outbox.recoverExpiredLeases();
  const claim = outbox.claimNext(1_000);
  const receipt = sales.getLocalReceipt(phase1.localSaleId);
  const projected = sales.getProjectedInventory()[0];
  const facts = outboxFacts(database, phase1.syncCommandId);
  const report = {
    localSaleId: receipt.localSaleId,
    localReceiptId: receipt.localReceiptId,
    syncCommandId: facts.sync_command_id,
    payloadHash: facts.payload_hash,
    totalMinor: receipt.totalMinor,
    cashReceivedMinor: receipt.cashReceivedMinor,
    changeMinor: receipt.changeMinor,
    projectedAfterRestart: projected.projectedAvailable,
    recoveredLeases,
    reclaimedAttempt: claim.attempts,
    ingestionRequestsSent: 0,
    serverOrderCreated: false,
  };
  fs.writeFileSync(reportPath("acceptance-phase2"), JSON.stringify(report));
  database.close();
  app.quit();
}

app
  .whenReady()
  .then(() =>
    phase === "prepare" ? preparePhase() : phase === "accept" ? acceptPhase() : restartPhase(),
  )
  .catch((error) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(reportPath("acceptance-error"), String(error?.stack ?? error));
    app.exit(1);
  });
