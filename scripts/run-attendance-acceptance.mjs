// Drives the packaged Electron OFFLINE ATTENDANCE crash/restart proof (Deliverable B). Self-contained:
// the server is stubbed inside the harness (its real idempotency/append-only semantics are proven by the
// isolated HTTP suite A1-A8), no network required. Uses a disposable user-data dir, never the dev profile.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-attendance-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected attendance acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "attendance");
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
    throw new Error(`Attendance acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("capture-crash", 86); // crashes via process.reallyExit(86) before any send
run("restart-send");
run("commit-crash", 86); // crashes mid-delivery after the server commit (lost response)
run("replay");

const sendReport = JSON.parse(readFileSync(path.join(userData, "restart-send.json"), "utf8"));
const replayReport = JSON.parse(readFileSync(path.join(userData, "replay.json"), "utf8"));
const failures = [];

// Item 1 + 4: durable crash-before-send recovery, exact command, sends once, standalone drain.
if (!sendReport.recoveredExactEvent) failures.push("the captured event did not survive the crash");
if (!sendReport.recoveredProvisional)
  failures.push("the recovered event was not provisional (accepted_pending_sync)");
if (!sendReport.outboxPendingBefore)
  failures.push("the recovered event was not queued pending before send");
if (!sendReport.saleOutboxEmpty)
  failures.push("precondition failed: the sale outbox was not empty for the standalone-drain check");
if (sendReport.dispatchedKeyCount !== 1)
  failures.push(`expected exactly one dispatch on recovery, saw ${sendReport.dispatchedKeyCount}`);
if (sendReport.distinctKeyCount !== 1)
  failures.push(`expected one distinct idempotency key, saw ${sendReport.distinctKeyCount}`);
if (!sendReport.dispatchedOriginalKey)
  failures.push("recovery dispatched a different idempotency key than originally captured");
if (sendReport.lifecycleAfter !== "received")
  failures.push(`event lifecycle after send was ${sendReport.lifecycleAfter}, expected received`);
if (sendReport.outboxStateAfter !== "delivered")
  failures.push(`outbox state after send was ${sendReport.outboxStateAfter}, expected delivered`);
if (!sendReport.serverIngestionRecorded)
  failures.push("no server ingestion id was recorded after a successful send");
if (sendReport.pendingAfter !== 0)
  failures.push(`events still pending after send: ${sendReport.pendingAfter}`);

// Item 2: commit-then-lost-response replays the ORIGINAL key (one identity) and reaches server-received.
if (replayReport.dispatchedKeyCount < 2)
  failures.push("the command was not re-dispatched after the commit-crash");
if (replayReport.distinctKeyCount !== 1)
  failures.push(`expected one distinct key across replay, saw ${replayReport.distinctKeyCount}`);
if (!replayReport.allKeysAreOriginal)
  failures.push("replay dispatched a key other than the original command identity");
if (replayReport.lifecycleAfter !== "received")
  failures.push(`event lifecycle after replay was ${replayReport.lifecycleAfter}, expected received`);
if (replayReport.outboxStateAfter !== "delivered")
  failures.push(`outbox state after replay was ${replayReport.outboxStateAfter}, expected delivered`);
if (replayReport.pendingAfter !== 0)
  failures.push(`events still pending after replay: ${replayReport.pendingAfter}`);

if (failures.length > 0)
  throw new Error(`Attendance acceptance invariants failed: ${failures.join("; ")}`);

process.stdout.write(
  `${JSON.stringify({ ok: true, restartSend: sendReport, replay: replayReport }, null, 2)}\n`,
);
