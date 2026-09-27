// Drives the packaged Electron connected-sale crash proof (P1-2): dispatch a sale, crash after the
// server commits but before acceptance is recorded, restart, and assert the retained command is
// replayed with its ORIGINAL idempotency key so exactly one Order is ever created. Self-contained:
// the Commerce API is stubbed inside the harness, no network required.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-sale-recovery-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected sale-recovery acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "sale-recovery");
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
    throw new Error(`Sale-recovery acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("submit-crash", 86); // crashes via process.reallyExit(86) after the server commits
run("restart");

const restart = JSON.parse(readFileSync(path.join(userData, "restart.json"), "utf8"));
const failures = [];
if (!restart.pendingBefore) failures.push("no unresolved connected sale survived the crash");
if (restart.recoveredStatus !== "accepted")
  failures.push(`recovery did not accept the sale (status=${restart.recoveredStatus})`);
if (restart.distinctKeyCount !== 1)
  failures.push(`expected exactly one distinct idempotency key, saw ${restart.distinctKeyCount}`);
if (restart.dispatchedKeyCount < 2)
  failures.push("the command was not actually re-dispatched on recovery");
if (restart.pendingAfter) failures.push("the workflow remained unresolved after acknowledgement");
if (failures.length > 0) throw new Error(`Sale-recovery invariants failed: ${failures.join("; ")}`);

process.stdout.write(`${JSON.stringify({ ok: true, restart }, null, 2)}\n`);
