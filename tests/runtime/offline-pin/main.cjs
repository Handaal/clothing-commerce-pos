/* eslint-disable @typescript-eslint/no-require-imports */
// Electron runtime acceptance for offline PIN v2 enrollment (real electron.exe, compiled main-process modules,
// real node:sqlite file, REAL OS safeStorage — DPAPI on Windows). The server's role is played by a local stub
// enroll client (no network): the HTTP contract itself is proven by the API suite test:pos:offline:pin-v2-client.
// Same-PIN model (shifted-cafe as is): the offline unlock PIN IS the sign-in PIN; the main process enrols right
// after a successful online sign-in (refreshAfterSignIn).
//   prepare      — register the till, install a lease that authorises enrollment v1 for one person
//   crash-enroll — the server "records" an enrollment, then the process dies BEFORE sealing: nothing usable
//   enroll       — a non-PIN credential is skipped without a server call; the first sign-in enrols the SAME PIN;
//                  a second sign-in with that PIN does not enrol again
//   unlock       — new process: the sign-in PIN unlocks offline; 5 wrong PINs lock the username
//   tamper       — new process: the SQLite lockout row is deleted; the OS-sealed copy keeps the lock
//   scan         — the PIN appears in no file of the profile, in UTF-8 or UTF-16
const { app, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const dist = (name) => path.join(root, "dist-electron/main/offline", name);
const { OfflineAuthorityStore } = require(dist("authority-store.js"));
const { LocalDatabase, localDatabasePath } = require(dist("database.js"));
const { DeviceKeyStore } = require(dist("device-key.js"));
const { OfflinePinEnroller } = require(dist("offline-pin-enroller.js"));
const { OfflinePinEnrollmentStore, offlinePinEnrollmentPath } = require(
  dist("offline-pin-enrollment.js"),
);
const { StaffRosterStore } = require(dist("staff-roster.js"));

const userData = app.getPath("userData");
const phaseArg = process.argv.find((value) => value.startsWith("--phase="));
const phase = phaseArg ? phaseArg.slice("--phase=".length) : "prepare";

// Test-only values for this throwaway profile. Never real credentials.
// 6 digits (POS sign-in PINs are 4–8) so the on-disk scan cannot match by chance.
// ADR-043: 20 digits — longer than the retired 8/12-digit caps, proving no truncation in the packaged runtime.
const SIGN_IN_PIN = "60491873520946182735";
const USERNAME = "dana.acceptance";

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
  enrollment: "93000000-0000-4000-8000-000000000014",
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
const report = (name, value) => fs.writeFileSync(reportPath(name), JSON.stringify(value));
const enrollmentStore = () =>
  new OfflinePinEnrollmentStore(offlinePinEnrollmentPath(userData), protectedStorage());
const stubServer =
  (onCall = () => undefined) =>
  async (input) => {
    onCall(input);
    return {
      membershipId: ids.membership,
      enrollmentId: ids.enrollment,
      verifierVersion: 1,
      enrolledAt: new Date().toISOString(),
    };
  };
const signIn = (pin = SIGN_IN_PIN) => ({
  tenantId: ids.tenant,
  accessToken: "acceptance-session",
  username: USERNAME,
  pin,
  membershipId: ids.membership,
});

async function preparePhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const keys = new DeviceKeyStore(userData, protectedStorage(), () =>
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
          name: "PIN Acceptance Tee",
          active: true,
          variants: [
            {
              variantId: ids.variant,
              sku: "PIN-BLK-M",
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
      offlinePinAuthorizations: [
        {
          membershipId: ids.membership,
          username: USERNAME,
          displayName: "Dana Acceptance",
          enrollmentId: ids.enrollment,
          verifierVersion: 1,
        },
      ],
    },
    observedAt.toISOString(),
  );
  report("prepare", { safeStorage: safeStorage.isEncryptionAvailable() });
  database.close();
  app.quit();
}

async function crashEnrollPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const enroller = new OfflinePinEnroller(
    database,
    enrollmentStore(),
    "http://127.0.0.1:9",
    async () => {
      // The server has recorded the enrollment; the process dies before the verifier is sealed.
      process.reallyExit(86);
    },
  );
  await enroller.enroll(signIn());
  throw new Error("crash seam did not fire");
}

async function enrollPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const store = enrollmentStore();
  const roster = new StaffRosterStore(database, () => new Date(), store);
  const afterCrash = {
    sealedMemberships: store.enrolledMemberships().length,
    unlock: roster.verifyPin({ username: USERNAME, pin: SIGN_IN_PIN }),
  };
  let serverCalls = 0;
  const enroller = new OfflinePinEnroller(
    database,
    store,
    "http://127.0.0.1:9",
    stubServer(() => (serverCalls += 1)),
  );
  const skipped = await enroller.refreshAfterSignIn(signIn("12a"));
  const callsBeforeValid = serverCalls;
  const result = await enroller.refreshAfterSignIn(signIn());
  const again = await enroller.refreshAfterSignIn(signIn());
  report("enroll", {
    afterCrash,
    skipped,
    callsBeforeValid,
    again,
    serverCalls,
    result,
    sealedMemberships: store.enrolledMemberships(),
  });
  database.close();
  app.quit();
}

async function unlockPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const roster = new StaffRosterStore(database, () => new Date(), enrollmentStore());
  const correct = roster.verifyPin({ username: USERNAME, pin: SIGN_IN_PIN });
  const wrong = [];
  for (let n = 0; n < 5; n += 1)
    wrong.push(roster.verifyPin({ username: USERNAME, pin: "000000" }));
  const lockedCorrect = roster.verifyPin({ username: USERNAME, pin: SIGN_IN_PIN });
  report("unlock", { correct, wrong: wrong.map((w) => w.reason), lockedCorrect });
  database.close();
  app.quit();
}

async function tamperPhase() {
  const database = new LocalDatabase(localDatabasePath(userData));
  const before = database.connection
    .prepare("SELECT COUNT(*) AS n FROM offline_pin_lockout")
    .get().n;
  database.connection.exec("DELETE FROM offline_pin_lockout");
  const roster = new StaffRosterStore(database, () => new Date(), enrollmentStore());
  const afterDelete = roster.verifyPin({ username: USERNAME, pin: SIGN_IN_PIN });
  report("tamper", { sqliteRowsBefore: before, afterDelete });
  database.close();
  app.quit();
}

function scanFiles(directory, needles) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        !entry.name.endsWith(".json") ||
        !/^(prepare|enroll|unlock|tamper|scan|acceptance-error)\.json$/.test(entry.name)
      ) {
        let bytes;
        try {
          bytes = fs.readFileSync(full);
        } catch {
          continue; // locked by the OS (e.g. Chromium cache) — not ours
        }
        for (const needle of needles) {
          if (
            bytes.includes(Buffer.from(needle, "utf8")) ||
            bytes.includes(Buffer.from(needle, "utf16le"))
          )
            hits.push({ file: path.relative(directory, full), needle: needle.length });
        }
      }
    }
  };
  walk(directory);
  return hits;
}

async function scanPhase() {
  const sealed = fs.readFileSync(offlinePinEnrollmentPath(userData));
  report("scan", {
    hits: scanFiles(userData, [SIGN_IN_PIN, `"pin":`, `stepUp`]),
    sealedLooksEncrypted: !sealed.toString("utf8").includes("enrollmentId"),
  });
  app.quit();
}

const phases = {
  prepare: preparePhase,
  "crash-enroll": crashEnrollPhase,
  enroll: enrollPhase,
  unlock: unlockPhase,
  tamper: tamperPhase,
  scan: scanPhase,
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
