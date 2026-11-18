// Drives the Electron runtime crash proof for ADR-042 §13.6 cached-policy offline vouchers: a crash INSIDE the
// sale transaction leaves no sale and no counted voucher use; a crash right after COMMIT keeps exactly the
// committed sale with its signed voucher command; after restart the durable local counter still allows exactly
// the remaining last-known uses and then refuses. Pure local — no API/network involved.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-voucher-crash-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected voucher-crash acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "voucher-crash");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

function run(phase, expectedStatus = 0) {
  const result = spawnSync(electron, [application, `--phase=${phase}`], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== expectedStatus) {
    const errorPath = path.join(userData, "acceptance-error.json");
    const detail = existsSync(errorPath) ? readFileSync(errorPath, "utf8") : result.stderr;
    throw new Error(`Voucher-crash acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("crash-mid", 86);
run("accept-crash", 86);
run("restart");

const prepare = JSON.parse(readFileSync(path.join(userData, "prepare.json"), "utf8"));
const restart = JSON.parse(readFileSync(path.join(userData, "restart.json"), "utf8"));
const failures = [];
if (prepare.policies !== 1) failures.push(`expected 1 cached policy, saw ${prepare.policies}`);
if (restart.salesBefore.length !== 1)
  failures.push(
    `expected exactly the 1 committed sale after the crashes, saw ${restart.salesBefore.length}`,
  );
if (!restart.committedSaleSurvived) failures.push("the committed voucher sale was lost");
if (restart.salesBefore[0]?.discount_total_minor !== 259)
  failures.push("the committed sale lost its cashier-recorded discount");
if (restart.outboxTotal !== 2_340)
  failures.push(`outbox total ${restart.outboxTotal} is not the net 2340`);
if (
  restart.outboxVoucher?.observedRemaining !== 2 ||
  restart.outboxVoucher?.discountTotalMinor !== 259
)
  failures.push("the signed outbox voucher command is not the original");
if (restart.secondObservedRemaining !== 1)
  failures.push("the durable local counter did not survive the restart");
if (restart.thirdRefusal !== "VOUCHER_LOCAL_LIMIT_REACHED")
  failures.push(`third use was not refused locally (${restart.thirdRefusal})`);
if (restart.voucherSalesAfter !== 2 || restart.outboxRowsAfter !== 2)
  failures.push("unexpected sale/outbox rows after restart");
if (failures.length > 0) throw new Error(`Voucher-crash invariants failed: ${failures.join("; ")}`);

process.stdout.write(`${JSON.stringify({ ok: true, prepare, restart }, null, 2)}\n`);
