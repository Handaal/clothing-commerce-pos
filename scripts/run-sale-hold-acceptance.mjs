// Drives the Electron crash/restart proof for ADR-042 §4.6 (Finding A: terminal hold for a sale whose new
// customer was rejected). Self-contained (server stubbed at the delivery seam; the real server path is the
// cross-repo HTTP suite pos-client-adr042-http N4). Uses a disposable user-data dir, never the developer's
// profile.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-sale-hold-acceptance");
if (path.dirname(path.resolve(userData)) !== path.resolve(process.env.APPDATA ?? "")) {
  throw new Error("Refusing to reset an unexpected sale-hold acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "sale-hold");
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
    throw new Error(`Sale-hold acceptance ${phase} exited ${result.status}: ${detail}`);
  }
}

run("prepare");
run("reject-crash", 86);
run("send-crash", 86);
run("replay");

const read = (name) => JSON.parse(readFileSync(path.join(userData, `${name}.json`), "utf8"));
const before = read("before-send");
const replay = read("replay");
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// After the crash before send: hold enqueued (atomically with the rejection), not sent, close withheld.
expect(before.holds === 1, "exactly one hold must exist after the crash before send");
// The crash happened after the hold was claimed and signed (once, immutably) but before transmission:
// it is "leased" and becomes due again when the lease expires (proven by the next phase).
expect(
  before.hold?.state === "leased",
  `hold should be leased (claimed, unsent), was ${before.hold?.state}`,
);
expect(before.hold?.signed === 1, "the hold must be signed exactly once before any send");
expect(before.hold?.reason === "customer_dependency_rejected", "hold reason mismatch");
expect(before.requestsBefore === 0, "no hold request may have left the till before the crash");
expect(before.close === null, "the grant close must be withheld before acknowledgement");
expect(before.dependency?.state === "held_customer_rejected", "the dependency must be held");
expect(before.saleOutbox?.state === "blocked", "the held sale's outbox row must stay blocked");
// After the lost response + replay: two byte-identical requests, one acknowledged hold.
expect(
  replay.afterCrashState === "leased",
  `after the lost response the hold should be leased, was ${replay.afterCrashState}`,
);
expect(replay.hold?.state === "acknowledged", `hold not acknowledged: ${replay.hold?.state}`);
expect(replay.signatureUnchanged, "the hold signature changed between attempts");
expect(replay.requests.length === 2, `expected 2 hold requests, saw ${replay.requests.length}`);
expect(
  replay.requests[0] === replay.requests[1],
  "the replayed hold request is not byte-identical",
);
expect(
  !replay.dispatched.some((entry) => entry.startsWith("sale:")),
  "the held sale itself was dispatched",
);
expect(
  replay.close && replay.close.finalSaleOrdinal === 1,
  `the grant close should report final ordinal 1, got ${JSON.stringify(replay.close)}`,
);
expect(replay.saleUnchanged, "the local sale row changed");
expect(replay.outboxUnchanged, "the signed sale command changed");
expect(
  replay.receipt?.reconciliationHold === "held_for_reconciliation",
  `receipt hold state: ${replay.receipt?.reconciliationHold}`,
);
expect(
  replay.receipt?.tenders?.[0]?.confirmation === "awaiting_provider_confirmation",
  "the card deposit must show as awaiting provider confirmation, never captured",
);

if (failures.length > 0) {
  throw new Error(`Sale-hold acceptance failed:\n- ${failures.join("\n- ")}`);
}
console.log(
  "PASS sale-hold acceptance: crash before send, lost response after commit, byte-identical replay, close recovered",
);
