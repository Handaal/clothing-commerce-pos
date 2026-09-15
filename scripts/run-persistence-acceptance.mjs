import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-persistence-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected persistence acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const application = path.join(root, "tests", "runtime", "persistence-acceptance");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

function run(phase) {
  const result = spawnSync(electron, [application, `--phase=${phase}`], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const errorPath = path.join(userData, "acceptance-error.json");
    const detail = existsSync(errorPath) ? readFileSync(errorPath, "utf8") : result.stderr;
    throw new Error(`Electron persistence acceptance ${phase} failed: ${detail}`);
  }
}

run("prepare");
run("accept");
await new Promise((resolve) => setTimeout(resolve, 1_200));
run("restart");

const first = JSON.parse(readFileSync(path.join(userData, "acceptance-phase1.json"), "utf8"));
const second = JSON.parse(readFileSync(path.join(userData, "acceptance-phase2.json"), "utf8"));
for (const field of ["localSaleId", "localReceiptId", "syncCommandId", "payloadHash"]) {
  if (first[field] !== second[field]) throw new Error(`${field} changed across Electron restart.`);
}
if (
  second.projectedAfterRestart !== first.projectedAfter ||
  second.recoveredLeases !== 1 ||
  second.reclaimedAttempt !== 2 ||
  first.ingestionRequestsSent !== 0 ||
  second.ingestionRequestsSent !== 0
) {
  throw new Error("Persistence acceptance invariants failed.");
}
process.stdout.write(`${JSON.stringify({ first, second }, null, 2)}\n`);
