/* eslint-disable @typescript-eslint/no-require-imports */
// Packaged Electron crash/restart proof for OFFLINE RETURN capture durability (ADR-041 Decision A, POS
// client lane). Runs the REAL packaged main/offline modules against a disposable user-data dir + SQLite
// file (never the developer's profile — the app name here is commerce-pos-offline-returns-acceptance).
// The Commerce API is stubbed through the return-grant issuer and the sync worker's delivery seam; every
// dispatched idempotency key is logged to a file that survives a crash, so "exactly one command identity"
// is verified across the process boundary. The server's real idempotency, eligibility re-check, withheld
// settlement and RLS are proven separately by the isolated HTTP suite (R0-R8).
//
//   prepare       — enroll + install an offline grant, then fetch + cache an order-bound RETURN grant
//   capture-crash — capture an offline return (durably persisted + queued), then crash BEFORE any send
//   restart-send  — reopen; the exact return/command/key must recover and send ONCE (sale outbox empty),
//                   reaching `synced` with the server's PENDING refund (never settled offline)
//   commit-crash  — capture a second return; the "server" commits (logs the key) then the process is
//                   crashed mid-delivery BEFORE the local acknowledgement (lost response after commit)
//   replay        — reopen; the retained command replays with its ORIGINAL key (one identity) and syncs
const { app, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const dist = (file) => path.join(root, "dist-electron/main/offline", file);
const { OfflineAuthorityStore } = require(dist("authority-store.js"));
const { LocalDatabase, localDatabasePath } = require(dist("database.js"));
const { DeviceKeyStore } = require(dist("device-key.js"));
const { OutboxStore } = require(dist("outbox-store.js"));
const { ReturnOutboxStore } = require(dist("return-outbox-store.js"));
const { OfflineReturnService } = require(dist("return-service.js"));
const { OfflineSyncWorker } = require(dist("sync-worker.js"));

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
  order: "93000000-0000-4000-8000-000000000014",
  lineA: "93000000-0000-4000-8000-000000000015",
  lineB: "93000000-0000-4000-8000-000000000016",
  returnGrant: "93000000-0000-4000-8000-000000000017",
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
const noIssuer = {
  issue: async () => {
    throw new Error("no network grant issuance after prepare");
  },
};
function returnService(database, keys, issuer = noIssuer) {
  return new OfflineReturnService(database, keys, issuer);
}

// A stubbed server outcome: canonical Return + PENDING refund. completeDelivery records exactly these
// server-computed figures; the client never computes refund money.
function syncedResponse(item) {
  return {
    syncStatus: "synced",
    ingestionId: "ab000000-0000-4000-8000-0000000000a1",
    localReturnId: item.localReturnId,
    receivedAt: new Date().toISOString(),
    returnId: "ab000000-0000-4000-8000-0000000000a2",
    refund: {
      id: "ab000000-0000-4000-8000-0000000000a3",
      status: "pending",
      amountMinor: 2_499,
      currency: "USD",
    },
    reconciliation: null,
  };
}
function stubDelivery(log, { crashAfterCommit = false } = {}) {
  const unexpected = (name) => async () => {
    throw new Error(`${name} was not expected in the offline-returns acceptance`);
  };
  return {
    deliver: unexpected("deliver (sale)"),
    deliverPayment: unexpected("deliverPayment"),
    deliverAttendance: unexpected("deliverAttendance"),
    deliverReturn: async (item) => {
      fs.appendFileSync(log, `${item.idempotencyKey}\n`);
      if (crashAfterCommit) process.reallyExit(86);
      return syncedResponse(item);
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
function returnOutboxRow(database, syncCommandId) {
  return database.connection
    .prepare("SELECT state, server_ingestion_id FROM return_outbox WHERE sync_command_id = ?")
    .get(syncCommandId);
}
async function open() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  return { database, keys };
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
          name: "Returns Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "RET-BLK-M",
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
  // ONLINE step: main fetches and caches the order-bound return grant (stubbed issuer).
  const issuer = {
    issue: async (request) => ({
      grant: {
        returnGrantId: ids.returnGrant,
        snapshotId: ids.snapshot,
        schemaVersion: 1,
        minimumClientVersion: "0.1.0",
        tenantId: request.tenantId,
        deviceId: request.deviceId,
        registerId: request.registerId,
        branchId: ids.branch,
        inventoryLocationId: ids.location,
        operatorMembershipId: ids.membership,
        orderId: request.orderId,
        currency: "USD",
        issuedAt,
        expiresAt: validUntil,
        maxRefundableMinor: 5_198,
        allowedReasons: null,
        lines: [
          {
            orderLineId: ids.lineA,
            lineNumber: 1,
            variantId: ids.variant,
            eligibleQuantity: 1,
            unitPriceMinor: 2_599,
          },
          {
            orderLineId: ids.lineB,
            lineNumber: 2,
            variantId: ids.variant,
            eligibleQuantity: 1,
            unitPriceMinor: 2_599,
          },
        ],
      },
      order: {
        header: { id: request.orderId, orderNumber: "POS-RET-1" },
        lines: [
          { lineNumber: 1, productName: "Returns Acceptance Tee", sku: "RET-BLK-M" },
          { lineNumber: 2, productName: "Returns Acceptance Tee", sku: "RET-BLK-M" },
        ],
      },
    }),
  };
  await returnService(database, keys, issuer).prepareGrant({
    tenantId: ids.tenant,
    accessToken: "acceptance-token",
    orderId: ids.order,
  });
  database.close();
  app.quit();
}

async function captureCrashPhase() {
  const { database, keys } = await open();
  const accepted = returnService(database, keys).recordReturn({
    returnGrantId: ids.returnGrant,
    lines: [{ orderLineId: ids.lineA, quantity: 1, reason: "Too small", disposition: "restock" }],
  });
  fs.writeFileSync(
    reportPath("captured"),
    JSON.stringify({
      localReturnId: accepted.localReturnId,
      syncCommandId: accepted.syncCommandId,
    }),
  );
  // Crash synchronously: the return is durably committed + queued but was never sent.
  process.reallyExit(86);
}

async function restartSendPhase() {
  const captured = JSON.parse(fs.readFileSync(reportPath("captured"), "utf8"));
  const { database, keys } = await open();
  const returns = returnService(database, keys);

  const before = returns.getLocalReturns();
  const recovered = before.recent.find((r) => r.localReturnId === captured.localReturnId) ?? null;
  const outboxBefore = returnOutboxRow(database, captured.syncCommandId);

  const log = keysLog("send-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log),
    { returnOutbox: new ReturnOutboxStore(database, () => new Date()) },
  );
  await worker.requestRun();

  const after = returns.getLocalReturns();
  const synced = after.recent.find((r) => r.localReturnId === captured.localReturnId) ?? null;
  const outboxAfter = returnOutboxRow(database, captured.syncCommandId);
  const dispatched = distinctKeys(log);

  fs.writeFileSync(
    reportPath("restart-send"),
    JSON.stringify({
      recoveredExactReturn: Boolean(recovered),
      recoveredProvisional: recovered ? recovered.lifecycle === "accepted_pending_sync" : false,
      recoveredWithoutRefund: recovered ? recovered.refund === null : false,
      outboxPendingBefore: outboxBefore ? outboxBefore.state === "pending" : false,
      saleOutboxEmpty:
        database.connection.prepare("SELECT COUNT(*) AS n FROM outbox").get().n === 0,
      dispatchedKeyCount: dispatched.count,
      distinctKeyCount: dispatched.distinct,
      dispatchedOriginalKey: dispatched.keys[0] === captured.syncCommandId,
      lifecycleAfter: synced ? synced.lifecycle : null,
      refundStatusAfter: synced && synced.refund ? synced.refund.status : null,
      outboxStateAfter: outboxAfter ? outboxAfter.state : null,
      serverIngestionRecorded: outboxAfter ? Boolean(outboxAfter.server_ingestion_id) : false,
      pendingAfter: after.pending,
    }),
  );
  database.close();
  app.quit();
}

async function commitCrashPhase() {
  const { database, keys } = await open();
  const accepted = returnService(database, keys).recordReturn({
    returnGrantId: ids.returnGrant,
    lines: [{ orderLineId: ids.lineB, quantity: 1, reason: "Faulty", disposition: "non_restock" }],
  });
  fs.writeFileSync(
    reportPath("captured2"),
    JSON.stringify({
      localReturnId: accepted.localReturnId,
      syncCommandId: accepted.syncCommandId,
    }),
  );
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log, { crashAfterCommit: true }),
    { returnOutbox: new ReturnOutboxStore(database, () => new Date()) },
  );
  await worker.requestRun();
  // Unreachable: the delivery stub crashes the process.
  app.exit(1);
}

async function replayPhase() {
  const captured = JSON.parse(fs.readFileSync(reportPath("captured2"), "utf8"));
  const { database, keys } = await open();
  const returns = returnService(database, keys);
  // A fast restart can occur before the crashed lease expires; advance the worker clock past the lease
  // so recovery reclaims and redelivers the retained command (deterministic, test-only time source).
  const future = () => new Date(Date.now() + 120_000);
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(new OutboxStore(database, future), stubDelivery(log), {
    returnOutbox: new ReturnOutboxStore(database, future),
    now: future,
  });
  await worker.requestRun();

  const after = returns.getLocalReturns();
  const synced = after.recent.find((r) => r.localReturnId === captured.localReturnId) ?? null;
  const outboxAfter = returnOutboxRow(database, captured.syncCommandId);
  const dispatched = distinctKeys(log);
  fs.writeFileSync(
    reportPath("replay"),
    JSON.stringify({
      dispatchedKeyCount: dispatched.count,
      distinctKeyCount: dispatched.distinct,
      allKeysAreOriginal: dispatched.keys.every((k) => k === captured.syncCommandId),
      lifecycleAfter: synced ? synced.lifecycle : null,
      refundStatusAfter: synced && synced.refund ? synced.refund.status : null,
      outboxStateAfter: outboxAfter ? outboxAfter.state : null,
      serverIngestionRecorded: outboxAfter ? Boolean(outboxAfter.server_ingestion_id) : false,
      pendingAfter: after.pending,
      localReturnCount: database.connection.prepare("SELECT COUNT(*) AS n FROM local_return").get()
        .n,
    }),
  );
  database.close();
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "capture-crash": captureCrashPhase,
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
