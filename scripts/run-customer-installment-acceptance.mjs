// Drives the Electron crash/restart proof for OFFLINE NEW CUSTOMER -> INSTALLMENT (local schema v19).
// Self-contained (server stubbed at the delivery seam; the real server path is the cross-repo HTTP suite
// pos-client-adr042-http). Uses a disposable user-data dir, never the developer's profile.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(
  process.env.APPDATA ?? "",
  "commerce-pos-customer-installment-acceptance",
);
if (path.dirname(path.resolve(userData)) !== path.resolve(process.env.APPDATA ?? "")) {
  throw new Error("Refusing to reset an unexpected customer-installment acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "customer-installment");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

function run(phase, expectedStatus = 0) {
  const result = spawnSync(electron, [application, `--phase=${phase}`], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== expectedStatus) {
    const errorPath = path.join(userData, "acceptance-error.json");
    const detail = existsSync(errorPath) ? readFileSync(errorPath, "utf8") : result.stderr;
    throw new Error(`Customer-installment acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("customer-crash", 86);
run("sale-tx-crash", 86);
run("sale-crash", 86);
run("commit-crash", 86);
run("replay");

const read = (name) => JSON.parse(readFileSync(path.join(userData, `${name}.json`), "utf8"));
const pre = read("sale-tx-pre");
const { afterTxCrash } = read("sale");
const replay = read("replay");
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(pre.customerSurvived, "the offline customer did not survive the first crash");
expect(afterTxCrash.sales === 0, "a sale survived a crash inside its own transaction");
expect(
  afterTxCrash.dependencies === 0,
  "a dependency survived a crash inside the sale transaction",
);
expect(
  afterTxCrash.saleOutbox === 0,
  "a sale outbox row survived a crash inside the sale transaction",
);
expect(afterTxCrash.customers === 1, "the customer was lost by the sale-transaction crash");
const customerKey = (key) => key.startsWith("customer:");
expect(
  replay.beforeReplay.length === 1 && customerKey(replay.beforeReplay[0]),
  `before replay only the customer may have reached the server, saw ${JSON.stringify(replay.beforeReplay)}`,
);
expect(
  replay.dependencyBefore === "waiting",
  "the sale was not still waiting after the lost response",
);
const customers = replay.after.filter(customerKey);
const sales = replay.after.filter((key) => key.startsWith("sale:"));
expect(new Set(customers).size === 1, "the customer was dispatched under more than one identity");
expect(sales.length === 1, `expected exactly one sale dispatch, saw ${sales.length}`);
expect(
  replay.after.indexOf(sales[0]) > replay.after.lastIndexOf(customers[customers.length - 1]),
  "the sale was dispatched before the customer was acknowledged",
);
expect(
  sales[0] === `sale:${replay.saleSyncCommandId}:${replay.localCustomerId}`,
  "the sale was not sent with its original identity and the till's customer id",
);
expect(
  replay.dependencyAfter?.state === "ready" &&
    replay.dependencyAfter?.canonical_customer_id === replay.localCustomerId,
  "the dependency was not resolved to the same canonical customer id",
);
expect(replay.saleLifecycle === "synced", `sale lifecycle is ${replay.saleLifecycle}`);
expect(replay.customerOutboxState === "delivered", "customer outbox not delivered");
expect(replay.signedCustomerId === replay.localCustomerId, "signed sale customer id changed");
expect(
  JSON.stringify(replay.signedTenders) === JSON.stringify([{ method: "card", amountMinor: 1000 }]),
  "the true tender method was not preserved",
);

if (failures.length > 0) {
  console.error("Customer-installment acceptance FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
rmSync(userData, { recursive: true, force: true });
console.log(
  "Customer-installment acceptance PASSED (customer crash, in-transaction sale crash, pre-sync crash, " +
    "lost customer response after commit, dependency-ordered replay with original identities).",
);
