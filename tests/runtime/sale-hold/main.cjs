/* eslint-disable @typescript-eslint/no-require-imports */
// Electron crash/restart proof for ADR-042 §4.6 (Finding A): a sale held because its new customer was
// rejected gets a signed terminal hold. REAL compiled main/offline modules, real safeStorage + device key,
// real SQLite file, disposable user-data dir (app name commerce-pos-sale-hold-acceptance; never the
// developer's profile). The API is stubbed at the delivery seam; every dispatched identity and hold request
// body is appended to logs that survive process death. The real server path is pos-client-adr042-http N4.
//
//   prepare      — enroll + install an offline grant with installments enabled
//   reject-crash — new customer + installment (card deposit); sync: the server REJECTS the customer; the hold
//                  is enqueued in the same transaction; the process dies BEFORE the hold leaves the till
//   send-crash   — reopen; sync: the "server" commits the hold, then the process dies (lost response)
//   replay       — reopen past the lease; sync: the byte-identical hold replays and the original receipt is
//                  acknowledged; the grant close becomes available; the sale itself was never dispatched
const { app, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const dist = (file) => path.join(root, "dist-electron/main/offline", file);
const { OfflineAuthorityStore } = require(dist("authority-store.js"));
const { LocalDatabase, localDatabasePath } = require(dist("database.js"));
const { DeviceKeyStore } = require(dist("device-key.js"));
const { OutboxStore } = require(dist("outbox-store.js"));
const { PaymentOutboxStore } = require(dist("payment-outbox-store.js"));
const { CustomerOutboxStore } = require(dist("customer-outbox-store.js"));
const { SaleHoldOutboxStore } = require(dist("sale-hold-outbox-store.js"));
const { OfflineSaleService } = require(dist("offline-service.js"));
const { OfflineSyncWorker, canonicalizeSaleHold } = require(dist("sync-worker.js"));
const { ApiHttpError } = require(
  path.join(root, "node_modules", "@shifted", "clothing-commerce-sdk"),
);

const userData = app.getPath("userData");
const argPhase = process.argv.find((a) => a.startsWith("--phase="));
const phase = argPhase ? argPhase.slice("--phase=".length) : "prepare";
const reportPath = (name) => path.join(userData, `${name}.json`);
const dispatchLog = path.join(userData, "dispatch.log");
const holdLog = path.join(userData, "hold-requests.log");

const ids = {
  tenant: "95000000-0000-4000-8000-000000000001",
  device: "95000000-0000-4000-8000-000000000002",
  credential: "95000000-0000-4000-8000-000000000003",
  register: "95000000-0000-4000-8000-000000000004",
  branch: "95000000-0000-4000-8000-000000000005",
  location: "95000000-0000-4000-8000-000000000006",
  membership: "95000000-0000-4000-8000-000000000007",
  grant: "95000000-0000-4000-8000-000000000008",
  snapshot: "95000000-0000-4000-8000-000000000009",
  product: "95000000-0000-4000-8000-000000000010",
  brand: "95000000-0000-4000-8000-000000000011",
  variant: "95000000-0000-4000-8000-000000000012",
  price: "95000000-0000-4000-8000-000000000013",
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
async function open() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  return { database, keys };
}
const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

function stubDelivery({ crashBeforeHoldSend = false, crashAfterHoldCommit = false } = {}) {
  const unexpected = (name) => async () => {
    throw new Error(`${name} was not expected in this acceptance`);
  };
  return {
    deliverCustomer: async (item) => {
      fs.appendFileSync(dispatchLog, `customer-rejected:${item.idempotencyKey}\n`);
      throw new ApiHttpError("customer phone must be E.164", 422, "OFFLINE_GRANT_INVALID", null);
    },
    deliverSaleHold: async (item) => {
      if (crashBeforeHoldSend) process.reallyExit(86);
      const body = JSON.parse(item.requestJson);
      fs.appendFileSync(holdLog, `${item.requestJson}\n`);
      fs.appendFileSync(dispatchLog, `hold:${item.syncCommandId}\n`);
      if (crashAfterHoldCommit) process.reallyExit(86);
      return {
        holdId: "ad000000-0000-4000-8000-000000000001",
        saleSyncCommandId: body.command.saleSyncCommandId,
        offlineSaleOrdinal: body.command.offlineSaleOrdinal,
        status: "held_for_reconciliation",
      };
    },
    deliver: async (item) => {
      fs.appendFileSync(dispatchLog, `sale:${item.idempotencyKey}\n`);
      throw new Error("a held sale must never be dispatched");
    },
    deliverPayment: unexpected("deliverPayment"),
    deliverAttendance: unexpected("deliverAttendance"),
    deliverReturn: unexpected("deliverReturn"),
  };
}
function worker(database, keys, delivery, now) {
  return new OfflineSyncWorker(new OutboxStore(database, now), delivery, {
    now,
    paymentOutbox: new PaymentOutboxStore(database, now),
    customerOutbox: new CustomerOutboxStore(database, now),
    saleHoldOutbox: new SaleHoldOutboxStore(database, now),
    saleHoldSigner: {
      sign: (canonical) => keys.signCanonical(canonical),
      credentialId: () =>
        database.connection
          .prepare("SELECT credential_id FROM device_state WHERE status = 'active'")
          .get().credential_id,
      canonicalize: canonicalizeSaleHold,
    },
  });
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
        maxOfflineCreditExposureMinor: 100_000,
      },
      catalog: [
        {
          productId: ids.product,
          brandId: ids.brand,
          name: "Hold Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "SH-BLK-M",
              optionSummary: "Black / M",
              active: true,
              authorizedUnitPriceMinor: 2_500,
              priceId: ids.price,
              priceVersion: issuedAt,
              advisoryInventory: { onHandQuantity: 10, version: 3, asOf: issuedAt },
            },
          ],
        },
      ],
      customers: [],
    },
    observedAt.toISOString(),
  );
  database.close();
  app.quit();
}

async function rejectCrashPhase() {
  const { database, keys } = await open();
  const sales = new OfflineSaleService(database, keys);
  const customer = sales.acceptNewCustomer({ name: "Omar Adel", phone: "+201005550111" });
  const sale = sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 0,
    amountPaidMinor: 1_000,
    customerId: customer.localCustomerId,
    tenders: [{ method: "card", amountMinor: 1_000 }],
  });
  const row = (sql, ...a) => database.connection.prepare(sql).get(...a);
  fs.writeFileSync(
    reportPath("sale"),
    JSON.stringify({
      sale,
      saleRow: row("SELECT * FROM local_sale WHERE local_sale_id = ?", sale.localSaleId),
      outboxRow: row(
        "SELECT canonical_command, request_json, payload_hash FROM outbox WHERE sync_command_id = ?",
        sale.syncCommandId,
      ),
    }),
  );
  await worker(
    database,
    keys,
    stubDelivery({ crashBeforeHoldSend: true }),
    () => new Date(),
  ).requestRun();
  app.exit(1); // unreachable: the stub dies before the hold leaves the till
}

async function sendCrashPhase() {
  const { database, keys } = await open();
  const row = (sql, ...a) => database.connection.prepare(sql).get(...a);
  fs.writeFileSync(
    reportPath("before-send"),
    JSON.stringify({
      hold: row(
        "SELECT state, reason, signature_base64 IS NOT NULL AS signed FROM sale_hold_outbox",
      ),
      holds: row("SELECT COUNT(*) AS n FROM sale_hold_outbox").n,
      close: new OfflineAuthorityStore(database).previousGrantClose() ?? null,
      dependency: row("SELECT state FROM local_customer_dependency WHERE dependent_lane = 'sale'"),
      saleOutbox: row("SELECT state, last_error_code FROM outbox"),
      requestsBefore: lines(holdLog).length,
    }),
  );
  const future = () => new Date(Date.now() + 120_000);
  await worker(database, keys, stubDelivery({ crashAfterHoldCommit: true }), future).requestRun();
  app.exit(1); // unreachable
}

async function replayPhase() {
  const { sale, saleRow, outboxRow } = JSON.parse(fs.readFileSync(reportPath("sale"), "utf8"));
  const { database, keys } = await open();
  const row = (sql, ...a) => database.connection.prepare(sql).get(...a);
  const afterCrash = row("SELECT state, signature_base64 FROM sale_hold_outbox");
  const future = () => new Date(Date.now() + 10 * 60_000);
  await worker(database, keys, stubDelivery(), future).requestRun();
  const service = new OfflineSaleService(database, keys);
  fs.writeFileSync(
    reportPath("replay"),
    JSON.stringify({
      afterCrashState: afterCrash.state,
      hold: row("SELECT state, server_hold_id FROM sale_hold_outbox"),
      signatureUnchanged:
        row("SELECT signature_base64 FROM sale_hold_outbox").signature_base64 ===
        afterCrash.signature_base64,
      requests: lines(holdLog),
      dispatched: lines(dispatchLog),
      close: new OfflineAuthorityStore(database).previousGrantClose() ?? null,
      saleUnchanged:
        JSON.stringify(
          row("SELECT * FROM local_sale WHERE local_sale_id = ?", sale.localSaleId),
        ) === JSON.stringify(saleRow),
      outboxUnchanged:
        JSON.stringify(
          row(
            "SELECT canonical_command, request_json, payload_hash FROM outbox WHERE sync_command_id = ?",
            sale.syncCommandId,
          ),
        ) === JSON.stringify(outboxRow),
      receipt: service.getLocalReceipt(sale.localSaleId),
      saleSyncCommandId: sale.syncCommandId,
    }),
  );
  database.close();
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "reject-crash": rejectCrashPhase,
  "send-crash": sendCrashPhase,
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
