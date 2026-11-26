/* eslint-disable @typescript-eslint/no-require-imports */
// Electron runtime crash proof for ADR-042 §13.6 cached-policy offline vouchers (real electron.exe, compiled
// main-process modules, real node:sqlite file, OS safeStorage device key).
//   prepare     — enroll + install a lease whose cached voucher policy reports 2 shared uses left
//   crash-mid   — accept a voucher sale but terminate INSIDE the SQLite transaction (after the outbox insert,
//                 before COMMIT): neither the sale nor a counted voucher use may survive
//   accept-crash— accept a voucher sale, then terminate right after COMMIT (before any acknowledgement)
//   restart     — reopen: exactly the committed voucher sale exists with its signed outbox command; the local
//                 counter still allows exactly ONE more use (2 - 1), then refuses VOUCHER_LOCAL_LIMIT_REACHED
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
const { voucherCodeFingerprint } = require(
  path.join(root, "dist-electron/main/offline/voucher-policy.js"),
);

const userData = app.getPath("userData");
const phaseArg = process.argv.find((value) => value.startsWith("--phase="));
const phase = phaseArg ? phaseArg.slice("--phase=".length) : "prepare";

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
  issuance: "92000000-0000-4000-8000-000000000014",
  promotion: "92000000-0000-4000-8000-000000000015",
  code: "92000000-0000-4000-8000-000000000016",
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
const keyStore = () =>
  new DeviceKeyStore(userData, protectedStorage(), () => session.defaultSession.flushStorageData());
const voucherSale = (sales) =>
  sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 2_599,
    voucher: { code: "SAVE10" },
  });

async function preparePhase() {
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
          name: "Voucher Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "VCH-BLK-M",
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
      voucherPolicies: [
        {
          policyIssuanceId: ids.issuance,
          promotionId: ids.promotion,
          codeId: ids.code,
          codeFingerprint: voucherCodeFingerprint(ids.tenant, "SAVE10"),
          channelPolicyVersion: 1,
          policyDigest: "b".repeat(64),
          calculationVersion: "ov1",
          observedRemaining: 2,
          maxDiscountPerRedemptionMinor: null,
          requiresAdminCredentials: false,
          fetchedAt: issuedAt,
          expiresAt: validUntil,
          terms: {
            promotionId: ids.promotion,
            name: "Ten off",
            codeId: ids.code,
            benefitType: "percentage",
            benefitPercentBp: 1_000,
            benefitAmountMinor: null,
            benefitCurrency: null,
            targetType: "order",
            minSubtotalMinor: null,
            maxDiscountMinor: null,
            endsAt: null,
            targetProductIds: [],
            targetVariantIds: [],
          },
        },
      ],
    },
    observedAt.toISOString(),
  );
  fs.writeFileSync(
    reportPath("prepare"),
    JSON.stringify({
      policies: database.connection
        .prepare("SELECT COUNT(*) AS n FROM offline_voucher_policy")
        .get().n,
    }),
  );
  database.close();
  app.quit();
}

async function crashMidPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  // Terminate the whole process INSIDE the open SQLite transaction (after the outbox row was written).
  const sales = new OfflineSaleService(database, keys, undefined, {
    afterStage(name) {
      if (name === "outbox") process.reallyExit(86);
    },
  });
  voucherSale(sales);
  throw new Error("crash seam did not fire");
}

async function acceptCrashPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const accepted = voucherSale(sales);
  fs.writeFileSync(reportPath("accepted"), JSON.stringify({ localSaleId: accepted.localSaleId }));
  process.reallyExit(86); // committed, never acknowledged
}

async function restartPhase() {
  const accepted = JSON.parse(fs.readFileSync(reportPath("accepted"), "utf8"));
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = keyStore();
  await keys.initializeIfPresent();
  const sales = new OfflineSaleService(database, keys);
  const db = database.connection;
  const salesBefore = db
    .prepare(
      "SELECT local_sale_id, total_minor, discount_total_minor, voucher_code_id FROM local_sale ORDER BY created_at",
    )
    .all();
  const outbox = db
    .prepare("SELECT local_sale_id, request_json, payload_hash FROM outbox WHERE local_sale_id = ?")
    .get(accepted.localSaleId);
  const command = outbox ? JSON.parse(outbox.request_json).command : null;
  const second = voucherSale(sales);
  let thirdRefusal = null;
  try {
    voucherSale(sales);
  } catch (error) {
    thirdRefusal = error.code ?? String(error);
  }
  fs.writeFileSync(
    reportPath("restart"),
    JSON.stringify({
      salesBefore,
      committedSaleSurvived: salesBefore.some((s) => s.local_sale_id === accepted.localSaleId),
      outboxVoucher: command ? command.voucher : null,
      outboxTotal: command ? command.totalMinor : null,
      secondObservedRemaining: JSON.parse(
        db
          .prepare("SELECT request_json FROM outbox WHERE local_sale_id = ?")
          .get(second.localSaleId).request_json,
      ).command.voucher.observedRemaining,
      thirdRefusal,
      voucherSalesAfter: db
        .prepare("SELECT COUNT(*) AS n FROM local_sale WHERE voucher_code_id IS NOT NULL")
        .get().n,
      outboxRowsAfter: db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n,
    }),
  );
  database.close();
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "crash-mid": crashMidPhase,
  "accept-crash": acceptCrashPhase,
  restart: restartPhase,
};

app
  .whenReady()
  .then(() => {
    if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
    const run = phases[phase];
    if (!run) throw new Error(`unknown phase ${phase}`);
    return run();
  })
  .catch((error) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(reportPath("acceptance-error"), String(error?.stack ?? error));
    app.exit(1);
  });
