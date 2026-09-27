// Drives the packaged Electron offline-ack crash proof (P1-3): accept a local sale, crash before
// acknowledgement, restart, and assert the exact sale is recovered, requires acknowledgement, and
// that a subsequent sale gets a distinct identity. Pure local — no API/network involved.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-offline-ack-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected offline-ack acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "offline-ack");
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
    throw new Error(`Offline-ack acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("accept-crash", 86); // the crash phase terminates with process.reallyExit(86)
run("restart");

const restart = JSON.parse(readFileSync(path.join(userData, "restart.json"), "utf8"));
const failures = [];
if (!restart.recoveredExactSale)
  failures.push("the committed sale was not recovered after restart");
if (!restart.recoveredUnacknowledged)
  failures.push("the recovered sale was not marked unacknowledged");
if (!restart.acknowledgedAt) failures.push("acknowledgement did not persist a timestamp");
if (restart.remainingAfterAck)
  failures.push("the sale still appeared as unacknowledged after acknowledgement");
if (!restart.secondSaleDistinct)
  failures.push("a subsequent sale reused the recovered sale identity");
if (failures.length > 0) throw new Error(`Offline-ack invariants failed: ${failures.join("; ")}`);

process.stdout.write(`${JSON.stringify({ ok: true, restart }, null, 2)}\n`);
