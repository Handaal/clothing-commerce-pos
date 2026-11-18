// Drives the packaged Electron OFFLINE RETURNS crash/restart proof (ADR-041 Decision A, POS lane).
// Self-contained: the server is stubbed inside the harness (its real idempotency, eligibility re-check,
// withheld settlement and RLS are proven by the isolated HTTP suite R0-R8), no network required. Uses a
// disposable user-data dir, never the developer's profile.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-offline-returns-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected offline-returns acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "offline-returns");
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
    throw new Error(`Offline-returns acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("capture-crash", 86); // crashes via process.reallyExit(86) before any send
run("restart-send");
run("commit-crash", 86); // crashes mid-delivery after the server commit (lost response)
run("replay");

const send = JSON.parse(readFileSync(path.join(userData, "restart-send.json"), "utf8"));
const replay = JSON.parse(readFileSync(path.join(userData, "replay.json"), "utf8"));
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// Crash-before-send: exact return recovers provisional (no refund claimed), sends once, original key.
expect(send.recoveredExactReturn, "the captured return did not survive the crash");
expect(
  send.recoveredProvisional,
  "the recovered return was not provisional (accepted_pending_sync)",
);
expect(send.recoveredWithoutRefund, "a refund was shown before the server computed one");
expect(send.outboxPendingBefore, "the recovered return was not queued pending before send");
expect(send.saleOutboxEmpty, "precondition failed: the sale outbox was not empty");
expect(send.dispatchedKeyCount === 1, `expected one dispatch, saw ${send.dispatchedKeyCount}`);
expect(send.distinctKeyCount === 1, `expected one distinct key, saw ${send.distinctKeyCount}`);
expect(send.dispatchedOriginalKey, "recovery dispatched a different idempotency key");
expect(send.lifecycleAfter === "synced", `lifecycle after send was ${send.lifecycleAfter}`);
expect(send.refundStatusAfter === "pending", `refund after send was ${send.refundStatusAfter}`);
expect(send.outboxStateAfter === "delivered", `outbox after send was ${send.outboxStateAfter}`);
expect(send.serverIngestionRecorded, "no server ingestion id recorded after send");
expect(send.pendingAfter === 0, `returns still pending after send: ${send.pendingAfter}`);

// Commit-then-lost-response: replays the ORIGINAL key (one identity) and reaches synced/pending refund.
expect(replay.dispatchedKeyCount >= 2, "the command was not re-dispatched after the commit-crash");
expect(
  replay.distinctKeyCount === 1,
  `expected one key across replay, saw ${replay.distinctKeyCount}`,
);
expect(replay.allKeysAreOriginal, "replay dispatched a key other than the original identity");
expect(replay.lifecycleAfter === "synced", `lifecycle after replay was ${replay.lifecycleAfter}`);
expect(
  replay.refundStatusAfter === "pending",
  `refund after replay was ${replay.refundStatusAfter}`,
);
expect(
  replay.outboxStateAfter === "delivered",
  `outbox after replay was ${replay.outboxStateAfter}`,
);
expect(replay.pendingAfter === 0, `returns still pending after replay: ${replay.pendingAfter}`);
expect(replay.localReturnCount === 2, `expected 2 local returns, saw ${replay.localReturnCount}`);

if (failures.length > 0)
  throw new Error(`Offline-returns acceptance invariants failed: ${failures.join("; ")}`);

process.stdout.write(`${JSON.stringify({ ok: true, restartSend: send, replay }, null, 2)}\n`);
