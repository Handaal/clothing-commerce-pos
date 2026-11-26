/* eslint-disable @typescript-eslint/no-require-imports */
// Electron crash/restart proof for OFFLINE NEW CUSTOMER -> INSTALLMENT (local schema v19 dependency). Runs the
// REAL compiled main/offline modules in Electron (real safeStorage, real SQLite file) against a disposable
// user-data dir (app name commerce-pos-customer-installment-acceptance; never the developer's profile). The
// API is stubbed at the sync worker's delivery seam; every dispatched command identity is appended to a log
// that survives process death, so ordering and "one identity per command" are verified across crashes. The
// real server path is proven by the cross-repo HTTP suite (pos-client-adr042-http N1-N3).
//
//   prepare        — enroll + install an offline grant with installments enabled
//   customer-crash — create a new customer offline, then crash (process.reallyExit) before anything else
//   sale-tx-crash  — reopen; the customer survived; crash INSIDE the installment sale transaction (after the
//                    dependency row, before the outbox row): nothing of the sale may survive
//   sale-crash     — reopen; ring the installment (card deposit) for that customer; crash before any sync
//   commit-crash   — reopen; sync: the "server" commits the CUSTOMER then the process dies before the local
//                    acknowledgement (lost response). The sale must not have been dispatched.
//   replay         — reopen; sync again: the customer replays with its original identity, THEN the sale is
//                    dispatched once, linked to the till's stable customer id; dependency ready; tender kept.
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
const { OfflineSaleService } = require(dist("offline-service.js"));
const { OfflineSyncWorker } = require(dist("sync-worker.js"));

const userData = app.getPath("userData");
const argPhase = process.argv.find((a) => a.startsWith("--phase="));
const phase = argPhase ? argPhase.slice("--phase=".length) : "prepare";
const reportPath = (name) => path.join(userData, `${name}.json`);
const dispatchLog = path.join(userData, "dispatch.log");

const ids = {
  tenant: "94000000-0000-4000-8000-000000000001",
  device: "94000000-0000-4000-8000-000000000002",
  credential: "94000000-0000-4000-8000-000000000003",
  register: "94000000-0000-4000-8000-000000000004",
  branch: "94000000-0000-4000-8000-000000000005",
  location: "94000000-0000-4000-8000-000000000006",
  membership: "94000000-0000-4000-8000-000000000007",
  grant: "94000000-0000-4000-8000-000000000008",
  snapshot: "94000000-0000-4000-8000-000000000009",
  product: "94000000-0000-4000-8000-000000000010",
  brand: "94000000-0000-4000-8000-000000000011",
  variant: "94000000-0000-4000-8000-000000000012",
  price: "94000000-0000-4000-8000-000000000013",
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
function dispatched() {
  if (!fs.existsSync(dispatchLog)) return [];
  return fs
    .readFileSync(dispatchLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
function saleResponse(command) {
  const at = new Date().toISOString();
  const orderId = "ac000000-0000-4000-8000-000000000001";
  return {
    syncStatus: "synced",
    ingestionId: "ac000000-0000-4000-8000-000000000002",
    localSaleId: command.localSaleId,
    receivedAt: at,
    order: {
      id: orderId,
      orderNumber: "POS-OFFLINE-CI-1",
      channel: "pos",
      status: "placed",
      brandId: ids.brand,
      branchId: ids.branch,
      registerId: ids.register,
      currency: "USD",
      totalMinor: command.totalMinor,
      actorMembershipId: ids.membership,
      placedAt: at,
      cancelledAt: null,
      cancelledByMembershipId: null,
      cancellationReason: null,
      notes: null,
      createdAt: at,
      updatedAt: at,
      lines: [
        {
          id: "ac000000-0000-4000-8000-000000000003",
          lineNumber: 1,
          variantId: ids.variant,
          quantity: 1,
          unitPriceMinor: command.totalMinor,
          lineTotalMinor: command.totalMinor,
          productName: "Installment Tee",
          variantName: "Black / M",
          sku: "CI-BLK-M",
          optionSummary: "Black / M",
        },
      ],
    },
    payment: {
      id: "ac000000-0000-4000-8000-000000000004",
      orderId,
      method: "card",
      status: "captured",
      currency: "USD",
      amountMinor: command.amountPaidMinor,
      cashReceivedMinor: null,
      changeMinor: null,
      capturedByMembershipId: ids.membership,
      capturedAt: at,
      createdAt: at,
      updatedAt: at,
    },
    fulfillment: null,
    reconciliation: null,
  };
}
// The "server": records every dispatched identity BEFORE answering (so a crash after it = lost response).
function stubDelivery({ crashAfterCustomerCommit = false } = {}) {
  const unexpected = (name) => async () => {
    throw new Error(`${name} was not expected in this acceptance`);
  };
  return {
    deliverCustomer: async (item) => {
      const command = JSON.parse(item.requestJson).command;
      fs.appendFileSync(dispatchLog, `customer:${item.idempotencyKey}\n`);
      if (crashAfterCustomerCommit) process.reallyExit(86);
      return {
        ingestionId: "ac000000-0000-4000-8000-0000000000c1",
        localCustomerId: command.localCustomerId,
        customerId: command.localCustomerId,
        duplicateOfCustomerId: null,
        receivedAt: new Date().toISOString(),
      };
    },
    deliver: async (item) => {
      const command = JSON.parse(item.requestJson).command;
      fs.appendFileSync(dispatchLog, `sale:${item.idempotencyKey}:${command.customerId}\n`);
      return saleResponse(command);
    },
    deliverPayment: unexpected("deliverPayment"),
    deliverAttendance: unexpected("deliverAttendance"),
    deliverReturn: unexpected("deliverReturn"),
  };
}
function worker(database, delivery, now) {
  return new OfflineSyncWorker(new OutboxStore(database, now), delivery, {
    now,
    paymentOutbox: new PaymentOutboxStore(database, now),
    customerOutbox: new CustomerOutboxStore(database, now),
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
          name: "Installment Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "CI-BLK-M",
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

async function customerCrashPhase() {
  const { database, keys } = await open();
  const customer = new OfflineSaleService(database, keys).acceptNewCustomer({
    name: "Omar Adel",
    phone: "+201005550111",
  });
  fs.writeFileSync(reportPath("customer"), JSON.stringify(customer));
  process.reallyExit(86); // committed customer, nothing else
}

async function saleTxCrashPhase() {
  const customer = JSON.parse(fs.readFileSync(reportPath("customer"), "utf8"));
  const { database, keys } = await open();
  const customerSurvived =
    database.connection
      .prepare("SELECT COUNT(*) AS n FROM local_customer WHERE local_customer_id = ?")
      .get(customer.localCustomerId).n === 1;
  fs.writeFileSync(reportPath("sale-tx-pre"), JSON.stringify({ customerSurvived }));
  const sales = new OfflineSaleService(database, keys, () => new Date(), {
    afterStage(stage) {
      // Die INSIDE the open SQLite transaction, after the dependency row and before the outbox row.
      if (stage === "dependency") process.reallyExit(86);
    },
  });
  sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 0,
    amountPaidMinor: 1_000,
    customerId: customer.localCustomerId,
    tenders: [{ method: "card", amountMinor: 1_000 }],
  });
  app.exit(1); // unreachable
}

async function saleCrashPhase() {
  const customer = JSON.parse(fs.readFileSync(reportPath("customer"), "utf8"));
  const { database, keys } = await open();
  const count = (sql) => database.connection.prepare(sql).get().n;
  const afterTxCrash = {
    sales: count("SELECT COUNT(*) AS n FROM local_sale"),
    dependencies: count("SELECT COUNT(*) AS n FROM local_customer_dependency"),
    saleOutbox: count("SELECT COUNT(*) AS n FROM outbox"),
    customers: count("SELECT COUNT(*) AS n FROM local_customer"),
  };
  const sale = new OfflineSaleService(database, keys).acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 0,
    amountPaidMinor: 1_000,
    customerId: customer.localCustomerId,
    tenders: [{ method: "card", amountMinor: 1_000 }],
  });
  fs.writeFileSync(reportPath("sale"), JSON.stringify({ afterTxCrash, sale }));
  process.reallyExit(86); // committed sale + dependency, never synced
}

async function commitCrashPhase() {
  const { database } = await open();
  await worker(
    database,
    stubDelivery({ crashAfterCustomerCommit: true }),
    () => new Date(),
  ).requestRun();
  app.exit(1); // unreachable: the stub crashes after the customer "commit"
}

async function replayPhase() {
  const customer = JSON.parse(fs.readFileSync(reportPath("customer"), "utf8"));
  const { sale } = JSON.parse(fs.readFileSync(reportPath("sale"), "utf8"));
  const { database } = await open();
  const beforeReplay = dispatched();
  const dependencyBefore = database.connection
    .prepare("SELECT state FROM local_customer_dependency WHERE dependent_sync_command_id = ?")
    .get(sale.syncCommandId);
  // Past the crashed lease (deterministic, test-only time source).
  const future = () => new Date(Date.now() + 120_000);
  await worker(database, stubDelivery(), future).requestRun();
  const row = (sql, ...args) => database.connection.prepare(sql).get(...args);
  const request = JSON.parse(
    row("SELECT request_json FROM outbox WHERE sync_command_id = ?", sale.syncCommandId)
      .request_json,
  );
  fs.writeFileSync(
    reportPath("replay"),
    JSON.stringify({
      beforeReplay,
      dependencyBefore: dependencyBefore ? dependencyBefore.state : null,
      after: dispatched(),
      dependencyAfter: row(
        "SELECT state, canonical_customer_id FROM local_customer_dependency WHERE dependent_sync_command_id = ?",
        sale.syncCommandId,
      ),
      saleLifecycle: row(
        "SELECT lifecycle FROM local_sale WHERE local_sale_id = ?",
        sale.localSaleId,
      ).lifecycle,
      customerOutboxState: row(
        "SELECT state FROM customer_outbox WHERE local_customer_id = ?",
        customer.localCustomerId,
      ).state,
      signedCustomerId: request.command.customerId,
      signedTenders: request.command.tenders,
      localCustomerId: customer.localCustomerId,
      saleSyncCommandId: sale.syncCommandId,
    }),
  );
  database.close();
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "customer-crash": customerCrashPhase,
  "sale-tx-crash": saleTxCrashPhase,
  "sale-crash": saleCrashPhase,
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
