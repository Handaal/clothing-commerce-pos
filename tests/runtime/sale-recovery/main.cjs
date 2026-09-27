/* eslint-disable @typescript-eslint/no-require-imports */
// Packaged Electron crash proof for connected-sale command durability (P1-2).
//   submit-crash — persist + dispatch a connected sale; the "server" commits it; then terminate
//                  BEFORE the acceptance is recorded (renderer never saw the receipt)
//   restart      — reopen; the unresolved command must replay with its ORIGINAL idempotency key, so
//                  the server (idempotent) returns the same Order. Exactly one distinct key is ever
//                  dispatched — a restart never mints a new key or creates a second Order.
//
// The Commerce API is stubbed via the service's clientFactory seam and records every idempotency key
// to a file that survives the crash, so "one Order" is verified across the process boundary.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const { LocalDatabase, localDatabasePath } = require(
  path.join(root, "dist-electron/main/offline/database.js"),
);
const { ConnectedSaleStore } = require(path.join(root, "dist-electron/main/sales/store.js"));
const { ConnectedSaleService } = require(path.join(root, "dist-electron/main/sales/service.js"));

const userData = app.getPath("userData");
const phase = process.argv.includes("--phase=restart") ? "restart" : "submit-crash";
const reportPath = (name) => path.join(userData, `${name}.json`);
const keysLog = () => path.join(userData, "dispatched-keys.log");

const session = { tenantId: "tenant-1", accessToken: "token" };
const intent = {
  registerId: "register-1",
  expectedTotalMinor: 2599,
  cashReceivedMinor: 3000,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

const receipt = {
  saleStatus: "completed",
  order: { id: "order-1", orderNumber: "POS-0001", totalMinor: 2599, currency: "USD", lines: [] },
  payment: { cashReceivedMinor: 3000, changeMinor: 401, currency: "USD" },
};

// Stub Commerce API: records the idempotency key of every accepted POS sale (idempotent by key).
function stubClient() {
  return {
    createPosSale: async (command) => {
      fs.appendFileSync(keysLog(), `${command.idempotencyKey}\n`);
      return receipt;
    },
  };
}

async function submitCrashPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const service = new ConnectedSaleService(new ConnectedSaleStore(database), "http://stub.test", {
    clientFactory: async () => stubClient(),
    afterResponse: () => {
      // The server has committed, but crash BEFORE the acceptance/receipt is recorded or shown.
      process.reallyExit(86);
    },
  });
  await service.submit(session, intent);
  // Unreachable: afterResponse terminates the process.
  app.exit(1);
}

async function restartPhase() {
  if (!app.requestSingleInstanceLock()) throw new Error("single-instance lock unavailable");
  const database = new LocalDatabase(localDatabasePath(userData));
  const store = new ConnectedSaleStore(database);
  const service = new ConnectedSaleService(store, "http://stub.test", {
    clientFactory: async () => stubClient(),
  });

  const pendingBefore = await service.hasPending();
  const outcome = await service.recover(session);
  if (outcome && outcome.status === "accepted")
    await service.acknowledge(session, outcome.workflowId);
  const pendingAfter = await service.hasPending();

  const keys = fs
    .readFileSync(keysLog(), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  fs.writeFileSync(
    reportPath("restart"),
    JSON.stringify({
      pendingBefore,
      recoveredStatus: outcome ? outcome.status : null,
      dispatchedKeyCount: keys.length,
      distinctKeyCount: new Set(keys).size,
      pendingAfter,
    }),
  );
  database.close();
  app.quit();
}

app
  .whenReady()
  .then(() => (phase === "restart" ? restartPhase() : submitCrashPhase()))
  .catch((error) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(reportPath("acceptance-error"), String(error?.stack ?? error));
    app.exit(1);
  });
