import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const userData = path.join(process.env.APPDATA ?? "", "commerce-pos-persistence-acceptance");
const expectedParent = path.resolve(process.env.APPDATA ?? "");
if (path.dirname(path.resolve(userData)) !== expectedParent) {
  throw new Error("Refusing to reset an unexpected persistence acceptance directory.");
}
rmSync(userData, { recursive: true, force: true });

// Resolve the Electron binary through Node's module resolution rather than a hardcoded
// `node_modules/electron/dist/electron.exe`. Under pnpm the latter traverses the
// `node_modules/electron` junction symlink into the virtual store, which the Windows CI runner
// could not spawn (ENOENT -> the old runner collapsed it into "failed: undefined"). `require`
// returns the canonical real path to the executable and is the portable, documented convention.
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw new Error(
    `Electron executable not found (resolved: ${electron}). Ensure \`pnpm install\` ran ` +
      "electron's postinstall so the binary is present before the persistence acceptance.",
  );
}
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
    const detail = existsSync(errorPath)
      ? readFileSync(errorPath, "utf8")
      : [
          result.error && `spawn error ${result.error.code ?? result.error.message}`,
          `status=${result.status}`,
          result.signal && `signal=${result.signal}`,
          result.stderr && `stderr=${result.stderr.trim()}`,
          result.stdout && `stdout=${result.stdout.trim()}`,
        ]
          .filter(Boolean)
          .join(" | ") || "no diagnostic output captured";
    throw new Error(
      `Electron persistence acceptance ${phase} failed [electron=${electron}, app=${application}, cwd=${root}]: ${detail}`,
    );
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
