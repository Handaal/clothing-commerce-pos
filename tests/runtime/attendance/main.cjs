/* eslint-disable @typescript-eslint/no-require-imports */
// Packaged Electron crash/restart proof for OFFLINE ATTENDANCE capture durability (Deliverable B).
// Runs the REAL packaged main/offline modules against a disposable user-data dir + SQLite file (never the
// developer's profile — the app name here is commerce-pos-attendance-acceptance). The Commerce API is
// stubbed through the sync worker's delivery seam and records each dispatched idempotency key to a file
// that survives a crash, so "exactly one command identity" is verified across the process boundary. The
// server's real idempotency/append-only semantics are proven separately by the isolated HTTP suite (A1-A8).
//
//   prepare       — enroll + install a signed offline grant
//   capture-crash — capture a clock_in event (durably persisted + queued), then crash BEFORE any send
//   restart-send  — reopen; the exact event/command/idempotency-key must recover and send ONCE, draining
//                   even though the SALE outbox is empty (regression guard for the return->break fix)
//   commit-crash  — capture a clock_out event; the "server" commits (records the key) then the process is
//                   crashed mid-delivery BEFORE the local acknowledgement (lost response after commit)
//   replay        — reopen; the retained command replays with its ORIGINAL idempotency key (one identity),
//                   and the local event reaches server-received (never payroll-final)
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
const { AttendanceOutboxStore } = require(
  path.join(root, "dist-electron/main/offline/attendance-outbox-store.js"),
);
const { OfflineSyncWorker } = require(path.join(root, "dist-electron/main/offline/sync-worker.js"));

const userData = app.getPath("userData");
const argPhase = process.argv.find((a) => a.startsWith("--phase="));
const phase = argPhase ? argPhase.slice("--phase=".length) : "prepare";
const reportPath = (name) => path.join(userData, `${name}.json`);
const keysLog = (name) => path.join(userData, `${name}.log`);

const ids = {
  tenant: "92000000-0000-4000-8000-000000000001",
  device: "92000000-0000-4000-8000-000000000002",
  credential: "92000000-0000-4000-8000-000000000003",
  register: "92000000-0000-4000-8000-000000000004",
  branch: "92000000-0000-4000-8000-000000000005",
  location: "92000000-0000-4000-8000-000000000006",
  membership: "92000000-0000-4000-8000-000000000007",
  grant: "92000000-0000-4000-8000-000000000008",
  snapshot: "92000000-0000-4000-8000-000000000009",
  product: "92000000-0000-4000-8000-000000000010",
  brand: "92000000-0000-4000-8000-000000000011",
  variant: "92000000-0000-4000-8000-000000000012",
  price: "92000000-0000-4000-8000-000000000013",
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

// A stubbed server acknowledgement for a local attendance event. completeDelivery only consumes
// localEventId/ingestionId/receivedAt; the rest mirrors the real IngestOfflineAttendanceResponse shape.
function receivedResponse(item) {
  return {
    syncStatus: "received",
    ingestionId: "aa000000-0000-4000-8000-0000000000a1",
    localEventId: item.localEventId,
    receivedAt: new Date().toISOString(),
    event: {
      membershipId: ids.membership,
      eventType: "clock_in",
      eventAt: new Date().toISOString(),
      adjudication: "pending_policy",
    },
  };
}
// Delivery seam: records every dispatched idempotency key (survives a crash), optionally crashing AFTER
// the "server commit" (the key is logged) but BEFORE the local acknowledgement — the lost-response case.
function stubDelivery(log, { crashAfterCommit = false } = {}) {
  return {
    deliver: async () => {
      throw new Error("deliver (sale) was not expected in the attendance acceptance");
    },
    deliverPayment: async () => {
      throw new Error("deliverPayment was not expected in the attendance acceptance");
    },
    deliverAttendance: async (item) => {
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
function attendanceOutboxRow(database, syncCommandId) {
  return database.connection
    .prepare(
      "SELECT state, server_ingestion_id FROM attendance_outbox WHERE sync_command_id = ?",
    )
    .get(syncCommandId);
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
          name: "Attendance Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "ATT-BLK-M",
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
  const accepted = sales.recordAttendanceEvent({ eventType: "clock_in" });
  fs.writeFileSync(
    reportPath("captured"),
    JSON.stringify({ localEventId: accepted.localEventId, syncCommandId: accepted.syncCommandId }),
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

  // The exact event survived the crash as provisional (accepted_pending_sync), queued with its original id.
  const stateBefore = sales.getLocalAttendance();
  const recovered = stateBefore.recent.find((e) => e.localEventId === captured.localEventId) ?? null;
  const outboxBefore = attendanceOutboxRow(database, captured.syncCommandId);

  // Drain with ONLY the attendance outbox wired and an EMPTY sale outbox — proves the standalone drain
  // (the return->break regression guard): attendance must sync without a pending sale.
  const log = keysLog("send-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log),
    { attendanceOutbox: new AttendanceOutboxStore(database, () => new Date()) },
  );
  await worker.requestRun();

  const stateAfter = sales.getLocalAttendance();
  const recoveredAfter =
    stateAfter.recent.find((e) => e.localEventId === captured.localEventId) ?? null;
  const outboxAfter = attendanceOutboxRow(database, captured.syncCommandId);
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
  const accepted = sales.recordAttendanceEvent({ eventType: "clock_out" });
  fs.writeFileSync(
    reportPath("captured2"),
    JSON.stringify({ localEventId: accepted.localEventId, syncCommandId: accepted.syncCommandId }),
  );
  // The "server" commits (records the key) then the process is crashed mid-delivery, before the local
  // acknowledgement — the classic "committed then lost response" window.
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, () => new Date()),
    stubDelivery(log, { crashAfterCommit: true }),
    { attendanceOutbox: new AttendanceOutboxStore(database, () => new Date()) },
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

  // A fast restart can occur before the crashed worker's lease expires; advance the worker clock past the
  // lease so recovery reclaims and redelivers the retained command (deterministic, test-only time source).
  const future = () => new Date(Date.now() + 120_000);
  const log = keysLog("replay-keys");
  const worker = new OfflineSyncWorker(
    new OutboxStore(database, future),
    stubDelivery(log),
    { attendanceOutbox: new AttendanceOutboxStore(database, future), now: future },
  );
  await worker.requestRun();

  const stateAfter = sales.getLocalAttendance();
  const recovered = stateAfter.recent.find((e) => e.localEventId === captured.localEventId) ?? null;
  const outboxAfter = attendanceOutboxRow(database, captured.syncCommandId);
  const dispatched = distinctKeys(log);

  fs.writeFileSync(
    reportPath("replay"),
    JSON.stringify({
      // The key was dispatched at least twice (commit-crash + replay) but is a single identity.
      dispatchedKeyCount: dispatched.count,
      distinctKeyCount: dispatched.distinct,
      allKeysAreOriginal: dispatched.keys.every((k) => k === captured.syncCommandId),
      lifecycleAfter: recovered ? recovered.lifecycle : null,
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
