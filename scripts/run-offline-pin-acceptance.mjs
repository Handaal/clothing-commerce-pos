// Drives the Electron runtime acceptance for offline PIN v2 enrollment (same-PIN model) (tests/runtime/offline-pin): real
// electron.exe, compiled main-process modules, real SQLite, REAL OS safeStorage (DPAPI on Windows). Local only —
// the server is a stub here; the HTTP contract is proven by the API suite test:pos:offline:pin-v2-client.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-offline-pin-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected offline-PIN acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "offline-pin");
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
    throw new Error(`Offline-PIN acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}
const read = (name) => JSON.parse(readFileSync(path.join(userData, `${name}.json`), "utf8"));

try {
  run("prepare");
  run("crash-enroll", 86);
  run("enroll");
  run("unlock");
  run("tamper");
  run("scan");

  const prepare = read("prepare");
  const enroll = read("enroll");
  const unlock = read("unlock");
  const tamper = read("tamper");
  const scan = read("scan");
  const failures = [];
  if (prepare.safeStorage !== true) failures.push("OS safeStorage is not available");
  if (enroll.afterCrash.sealedMemberships !== 0)
    failures.push("a crash between server record and local seal left a sealed verifier");
  if (enroll.afterCrash.unlock.ok !== false) failures.push("crash-interrupted enrollment unlocked");
  if (enroll.skipped?.status !== "skipped" || enroll.skipped?.reason !== "PIN_FORMAT")
    failures.push(`non-PIN credential not skipped: ${JSON.stringify(enroll.skipped)}`);
  if (enroll.callsBeforeValid !== 0) failures.push("a skipped credential reached the server");
  if (enroll.serverCalls !== 1 || enroll.result?.status !== "enrolled")
    failures.push("first sign-in did not enrol exactly once");
  if (enroll.again?.status !== "current") failures.push("a repeat sign-in enrolled again");
  if (unlock.correct.ok !== true) failures.push("enrolled PIN did not unlock in a new process");
  if (
    unlock.wrong.slice(0, 4).some((r) => r !== "INVALID") ||
    unlock.lockedCorrect.reason !== "THROTTLED"
  )
    failures.push(`lockout not enforced: ${JSON.stringify(unlock)}`);
  if (tamper.sqliteRowsBefore !== 1 || tamper.afterDelete.reason !== "THROTTLED")
    failures.push(`deleting the SQLite lockout row reset the lock: ${JSON.stringify(tamper)}`);
  if (scan.hits.length !== 0)
    failures.push(`secret material found on disk: ${JSON.stringify(scan.hits)}`);
  if (scan.sealedLooksEncrypted !== true)
    failures.push("sealed enrollment file is readable plaintext");
  if (failures.length > 0) throw new Error(`Offline-PIN invariants failed: ${failures.join("; ")}`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, enroll: { skipped: enroll.skipped, result: enroll.result, again: enroll.again, serverCalls: enroll.serverCalls }, unlock, tamper, scan }, null, 2)}\n`,
  );
} finally {
  rmSync(userData, { recursive: true, force: true });
}
