/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const { readFileSync, writeFileSync, realpathSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "../../..");
const directory = realpathSync(process.env.POS_RETURN_CRASH_DIRECTORY);
if (
  path.dirname(directory) !== realpathSync(os.tmpdir()) ||
  !path.basename(directory).startsWith("pos-return-crash-")
)
  throw new Error("Unexpected crash-proof directory");
const input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
const phase = process.env.POS_RETURN_CRASH_PHASE;
if (
  ![
    "create-crash",
    "recover-create",
    "settle-crash",
    "recover-settle",
    "offline-wait",
    "completed-restart",
  ].includes(phase)
)
  throw new Error("Unexpected crash-proof phase");
const url = process.env.POS_RETURNS_TEST_URL;
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("Local test API required");
app.setPath("userData", directory);
const { LocalDatabase, localDatabasePath } = require(
  path.join(root, "dist-electron/main/offline/database.js"),
);
const { ReturnStore } = require(path.join(root, "dist-electron/main/returns/store.js"));
const { ReturnService } = require(path.join(root, "dist-electron/main/returns/service.js"));
app
  .whenReady()
  .then(async () => {
    const database = new LocalDatabase(localDatabasePath(directory));
    const store = new ReturnStore(database);
    const requests = [];
    const sdk = await import("@shifted/clothing-commerce-sdk");
    const service = new ReturnService(store, url, {
      networkOnline: () => phase !== "offline-wait",
      clientFactory: async (session) =>
        sdk.createCommerceClient({
          baseUrl: url,
          client: { type: "pos-desktop", version: "0.1.0" },
          getToken: () => session.accessToken,
          fetch: async (resource, options) => {
            if (options?.method === "POST") {
              const headers = new Headers(options.headers);
              requests.push({
                path: new URL(resource).pathname,
                body: options.body,
                key: headers.get("Idempotency-Key"),
              });
              writeFileSync(
                path.join(directory, `${phase}-requests.json`),
                JSON.stringify(requests),
              );
            }
            return fetch(resource, options);
          },
        }),
      afterResponse: (stage, _row, result) => {
        if (
          (phase === "create-crash" && stage === "prepared") ||
          (phase === "settle-crash" && stage === "settlement_prepared")
        ) {
          writeFileSync(
            path.join(directory, `${phase}-committed.json`),
            JSON.stringify({ pid: process.pid, result }),
          );
          // Deliberately bypass database.close(), workflow acknowledgement and all app shutdown hooks.
          // process.reallyExit terminates synchronously even from a libuv I/O callback context
          // (the SDK fetch-response continuation); process.exit/app.exit defer there and would let
          // the workflow acknowledge before the simulated crash lands.
          process.reallyExit(86);
        }
      },
    });
    const session = { tenantId: input.tenantId, accessToken: process.env.POS_RETURNS_TEST_TOKEN };
    let reply;
    if (phase === "create-crash") reply = await service.start(session, input.intent);
    else if (phase === "settle-crash")
      reply = await service.settle(
        session,
        store.view(store.active()).result.id,
        "Crash proof: cash hand-back attested",
      );
    else reply = await service.recover(session);
    writeFileSync(
      path.join(directory, `${phase}-result.json`),
      JSON.stringify({ pid: process.pid, reply, pending: await service.hasPending() }),
    );
    database.close();
    app.exit(phase === "offline-wait" ? (reply.error ? 0 : 1) : reply.error ? 1 : 0);
  })
  .catch(() => {
    console.error("Return crash-proof process failed; credentials omitted.");
    app.exit(1);
  });
