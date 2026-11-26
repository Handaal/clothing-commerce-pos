/* eslint-disable @typescript-eslint/no-require-imports */
// Packaged Electron crash/restart proof for PROVISIONAL OFFLINE INTENTS (all-desks lane).
// Runs the REAL packaged main/offline modules against a disposable user-data dir + SQLite file (never the
// developer's profile — the app name here is commerce-pos-intents-acceptance). The Commerce API is stubbed
// through the sync worker's delivery seam and records each dispatched idempotency key to a file that
// survives a crash. The server's real idempotency / pending-review semantics are proven separately by the
// isolated HTTP suite (I0–I10) and the cross-repo POS-client suite (C0–C4).
//
//   prepare       — enroll + install a signed grant whose policy opts into inventory.receive
//   capture-crash — record an inventory.receive intent (durably persisted + queued), crash BEFORE any send
//   restart-send  — reopen; the exact intent/command/key recovers and sends ONCE with an empty sale outbox
//   commit-crash  — record a second intent; the "server" commits (logs the key) then the process crashes
//                   mid-delivery BEFORE the local acknowledgement (lost response after commit)
//   replay        — reopen; the retained command replays with its ORIGINAL key (one identity), reaches
//                   server-received, and the review center reports it as server_received (pending review)
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
const { IntentOutboxStore } = require(
  path.join(root, "dist-electron/main/offline/intent-outbox-store.js"),
);
const { OfflineSyncWorker } = require(path.join(root, "dist-electron/main/offline/sync-worker.js"));
const { OfflineIntentService } = require(
  path.join(root, "dist-electron/main/offline/intent-service.js"),
);
const { OfflineReviewService } = require(
  path.join(root, "dist-electron/main/offline/review-service.js"),
);

const userData = app.getPath("userData");
const argPhase = process.argv.find((a) => a.startsWith("--phase="));
const phase = argPhase ? argPhase.slice("--phase=".length) : "prepare";
const reportPath = (name) => path.join(userData, `${name}.json`);
const keysLog = (name) => path.join(userData, `${name}.log`);

const ids = {
  tenant: "93000000-0000-4000-8000-000000000001",
  device: "93000000-0000-4000-8000-000000000002",
  credential: "93000000-0000-4000-8000-000000000003",
  register: "93000000-0000-4000-8000-000000000004",
  branch: "93000000-0000-4000-8000-000000000005",
  location: "93000000-0000-4000-8000-000000000006",
  membership: "93000000-0000-4000-8000-000000000007",
  grant: "93000000-0000-4000-8000-000000000008",
  snapshot: "93000000-0000-4000-8000-000000000009",
  product: "93000000-0000-4000-8000-000000000010",
  brand: "93000000-0000-4000-8000-000000000011",
  variant: "93000000-0000-4000-8000-000000000012",
  price: "93000000-0000-4000-8000-000000000013",
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
function keyStore() {
  return new DeviceKeyStore(userData, protectedStorage(), () =>
    session.defaultSession.flushStorageData(),
  );
}

// A stubbed server acknowledgement for a local intent (mirrors IngestOfflineIntentResponse).
function receivedResponse(item) {
  return {
    syncStatus: "received",
    ingestionId: "ab000000-0000-4000-8000-0000000000b1",
    localIntentId: item.localIntentId,
    receivedAt: new Date().toISOString(),
    // Automatic server disposition (no human approval): the stub mirrors an applied receive.
    intent: {
      operation: "inventory.receive",
      disposition: "applied",
      code: "OIA_STOCK_POSTED",
      policyVersion: "acceptance-E-1",
      decidedAt: new Date().toISOString(),
      detail: { quantityDelta: 2, onHandAfter: 12 },
    },
  };
}
// Delivery seam: records every dispatched idempotency key (survives a crash), optionally crashing AFTER
// the "server commit" (the key is logged) but BEFORE the local acknowledgement — the lost-response case.
function stubDelivery(log, { crashAfterCommit = false } = {}) {
  return {
    deliver: async () => {
      throw new Error("deliver (sale) was not expected in the intent acceptance");
    },
    deliverPayment: async () => {
      throw new Error("deliverPayment was not expected in the intent acceptance");
    },
    deliverAttendance: async () => {
      throw new Error("deliverAttendance was not expected in the intent acceptance");
    },
    deliverReturn: async () => {
      throw new Error("deliverReturn was not expected in the intent acceptance");
    },
    deliverIntent: async (item) => {
      fs.appendFileSync(log, `${item.idempotencyKey}\n`);
      if (crashAfterCommit) process.reallyExit(86);
      return receivedResponse(item);
    },
  };
}
function distinctKeys(log) {
  if (!fs.existsSync(log)) return { count: 0, distinct: 0, keys: [] };
  const keys = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { count: keys.length, distinct: new Set(keys).size, keys };
}
function intentOutboxRow(database, syncCommandId) {
  return database.connection
    .prepare("SELECT state, server_ingestion_id FROM intent_outbox WHERE sync_command_id = ?")
    .get(syncCommandId);
}

function receiveIntent(quantity) {
  return {
    operation: "inventory.receive",
    subjectId: ids.variant,
    baseVersion: null,
    dependsOnSyncCommandId: null,
    payload: { variantId: ids.variant, quantity, supplierDocumentRef: "DN-ACCEPT", note: null },
  };
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
        intentOperations: ["inventory.receive", "review.resolution_request"],
      },
      catalog: [
        {
          productId: ids.product,
          brandId: ids.brand,
          name: "Intent Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "INT-BLK-M",
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

async function capeCrashPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const intents = new OfflineIntentService(database, keys, () => sales.getReadiness());
  const accepted = intents.recordIntent(receiveIntent(5));
  fs.writeFileSync(
    reportPath("captured"),
    JSON.stringify({
      localIntentId: accepted.localIntentId,
      syncCommandId: accepted.syncCommandId,
    }),
  );
  // Crash synchronously: the event is durably committed + queued but was never sent.
  process.reallyExit(86);
}

async function restartSendPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const captured = JSON.parse(fs.readFileSync(reportPath("captured"), "utf8"));
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const intents = new OfflineIntentService(database, keys, () => sales.getReadiness());

  // The exact event survived the crash as provisional (accepted_pending_sync), queued with its original id.
  const stateBefore = intents.getLocalIntents();
  const recovered =
    stateBefore.recent.find((e) => e.localIntentId === captured.localIntentId) ?? null;
  const outboxBefore = intentOutboxRow(database, captured.syncCommandId);

  // Drain with ONLY the intent outbox wired and an EMPTY sale outbox — proves the standalone drain
  // (standalone-lane guard): intents must sync without a pending sale.
  const log = keysLog("send-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log),
    { intentOutbox: new IntentOutboxStore(database, () => new Date()) },
  );
  await worker.requestRun();

  const stateAfter = intents.getLocalIntents();
  const recoveredAfter =
    stateAfter.recent.find((e) => e.localIntentId === captured.localIntentId) ?? null;
  const outboxAfter = intentOutboxRow(database, captured.syncCommandId);
  const dispatched = distinctKeys(log);

  fs.writeFileSync(
    reportPath("restart-send"),
    JSON.stringify({
      recoveredExactEvent: Boolean(recovered),
      recoveredProvisional: recovered ? recovered.lifecycle === "accepted_pending_sync" : false,
      outboxPendingBefore: outboxBefore ? outboxBefore.state === "pending" : false,
      saleOutboxEmpty:
        database.connection.prepare("SELECT COUNT(*) AS n FROM outbox").get().n === 0,
      dispatchedKeyCount: dispatched.count,
      distinctKeyCount: dispatched.distinct,
      dispatchedOriginalKey: dispatched.keys[0] === captured.syncCommandId,
      lifecycleAfter: recoveredAfter ? recoveredAfter.lifecycle : null,
      outboxStateAfter: outboxAfter ? outboxAfter.state : null,
      serverIngestionRecorded: outboxAfter ? Boolean(outboxAfter.server_ingestion_id) : false,
      pendingAfter: stateAfter.pending,
    }),
  );
  database.close();
  app.quit();
}

async function commitCrashPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const intents = new OfflineIntentService(database, keys, () => sales.getReadiness());
  const accepted = intents.recordIntent(receiveIntent(2));
  fs.writeFileSync(
    reportPath("captured2"),
    JSON.stringify({
      localIntentId: accepted.localIntentId,
      syncCommandId: accepted.syncCommandId,
    }),
  );
  // The "server" commits (records the key) then the process is crashed mid-delivery, before the local
  // acknowledgement — the classic "committed then lost response" window.
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log, { crashAfterCommit: true }),
    { intentOutbox: new IntentOutboxStore(database, () => new Date()) },
  );
  await worker.requestRun();
  // Unreachable: the delivery stub crashes the process.
  app.exit(1);
}

async function replayPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const captured = JSON.parse(fs.readFileSync(reportPath("captured2"), "utf8"));
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const intents = new OfflineIntentService(database, keys, () => sales.getReadiness());

  // A fast restart can occur before the crashed worker's lease expires; advance the worker clock past the
  // lease so recovery reclaims and redelivers the retained command (deterministic, test-only time source).
  const future = () => new Date(Date.now() + 120_000);
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(new OutboxStore(database, future), stubDelivery(log), {
    intentOutbox: new IntentOutboxStore(database, future),
    now: future,
  });
  await worker.requestRun();

  const stateAfter = intents.getLocalIntents();
  const recovered =
    stateAfter.recent.find((e) => e.localIntentId === captured.localIntentId) ?? null;
  const outboxAfter = intentOutboxRow(database, captured.syncCommandId);
  const dispatched = distinctKeys(log);

  fs.writeFileSync(
    reportPath("replay"),
    JSON.stringify({
      // The key was dispatched at least twice (commit-crash + replay) but is a single identity.
      dispatchedKeyCount: dispatched.count,
      distinctKeyCount: dispatched.distinct,
      allKeysAreOriginal: dispatched.keys.every((k) => k === captured.syncCommandId),
      reviewStatus:
        new OfflineReviewService(database, intents)
          .list({ lane: "intent" })
          .find((item) => item.syncCommandId === captured.syncCommandId)?.status ?? null,
      lifecycleAfter: recovered ? recovered.lifecycle : null,
      dispositionAfter: recovered ? recovered.disposition : null,
      outboxStateAfter: outboxAfter ? outboxAfter.state : null,
      serverIngestionRecorded: outboxAfter ? Boolean(outboxAfter.server_ingestion_id) : false,
      pendingAfter: stateAfter.pending,
    }),
  );
  database.close();
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "capture-crash": capeCrashPhase,
  "restart-send": restartSendPhase,
  "commit-crash": commitCrashPhase,
  replay: replayPhase,
};

app
  .whenReady()
  .then(() => (phases[phase] ?? preparePhase)())
  .catch((error) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(reportPath("acceptance-error"), String(error?.stack ?? error));
    app.exit(1);
  });
