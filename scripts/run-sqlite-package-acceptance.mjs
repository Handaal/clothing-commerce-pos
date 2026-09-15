import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const appData = path.resolve(process.env.APPDATA ?? "");
const userData = path.join(appData, "commerce-pos-sqlite-probe");
if (path.dirname(path.resolve(userData)) !== appData) {
  throw new Error("Refusing to reset an unexpected SQLite probe directory.");
}
rmSync(userData, { recursive: true, force: true });

const builder = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");
const packaged = spawnSync(
  process.execPath,
  [
    builder,
    "--projectDir",
    "tests\\runtime\\sqlite-probe",
    "--config",
    "electron-builder.yml",
    "--dir",
  ],
  { cwd: root, encoding: "utf8", timeout: 120_000 },
);
if (packaged.status !== 0) {
  throw new Error(String(packaged.error ?? packaged.stderr ?? packaged.stdout));
}

const executable = path.join(
  root,
  "release",
  "sqlite-probe",
  "win-unpacked",
  "Commerce POS SQLite Probe.exe",
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const launched = spawnSync(executable, [], {
  cwd: root,
  env: environment,
  encoding: "utf8",
  timeout: 30_000,
});
if (launched.status !== 0) throw new Error(launched.stderr || launched.stdout);

const report = JSON.parse(readFileSync(path.join(userData, "sqlite-runtime-probe.json"), "utf8"));
if (
  report.packaged !== true ||
  report.value !== "electron-node-sqlite-ok" ||
  report.journalMode !== "wal" ||
  report.synchronous !== 2 ||
  report.foreignKeys !== 1
) {
  throw new Error("Packaged Electron SQLite probe returned unexpected settings.");
}
rmSync(path.join(root, "tests", "runtime", "sqlite-probe", "pnpm-lock.yaml"), { force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
