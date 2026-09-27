// Resolve the one canonical Commerce API origin for a release build and write it into
// dist-electron/runtime-config.json. This artifact is the SINGLE source both the packaged Electron
// main process (runtime read) and the Vite renderer build (compile-time define) consume, so the two
// can never drift. Run before `vite build` and before `electron-builder` packages `dist-electron/**`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CONFIG_FILENAME, resolveApiOrigin } from "../src/shared/api-origin.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal dotenv loader: does not overwrite an already-present process.env value. */
function loadDotEnv(root) {
  let text;
  try {
    text = readFileSync(resolve(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
const mode = modeArg ?? (process.env.NODE_ENV === "development" ? "development" : "production");

loadDotEnv(repositoryRoot);

const commerceApiUrl = resolveApiOrigin({ value: process.env.COMMERCE_API_URL, mode });

const outputDirectory = resolve(repositoryRoot, "dist-electron");
mkdirSync(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, RUNTIME_CONFIG_FILENAME);
writeFileSync(outputPath, `${JSON.stringify({ commerceApiUrl }, null, 2)}\n`, "utf8");

process.stdout.write(`Resolved canonical Commerce API origin (${mode}): ${commerceApiUrl}\n`);
process.stdout.write(`Wrote ${outputPath}\n`);
