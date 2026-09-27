import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEV_DEFAULT_API_ORIGIN,
  RUNTIME_CONFIG_FILENAME,
  normalizeApiOrigin,
  readRuntimeConfigOrigin,
} from "../shared/api-origin";

/**
 * Resolve the canonical Commerce API origin for the Electron main process.
 *
 * The single packaged source of truth is `dist-electron/runtime-config.json`, generated once per
 * release build from the same value baked into the renderer. The main process reads that artifact at
 * runtime — it never re-reads `process.env` in a packaged app, so it cannot drift from the renderer
 * and does not depend on the operator launching Electron from a shell with a matching variable.
 *
 * Development (identified by `VITE_DEV_SERVER_URL`, set by `pnpm dev`) has no generated artifact and
 * may fall back to `process.env.COMMERCE_API_URL` or the localhost default. A packaged app with a
 * missing/invalid artifact fails closed rather than silently pointing at localhost.
 */
export function resolveMainApiOrigin(
  options: {
    readonly configDirectory?: string;
    readonly isDevelopment?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = options.env ?? process.env;
  const isDevelopment = options.isDevelopment ?? Boolean(env.VITE_DEV_SERVER_URL);
  // dist-electron/main/main.js → dist-electron/runtime-config.json
  const configDirectory = options.configDirectory ?? path.join(__dirname, "..");
  const configPath = path.join(configDirectory, RUNTIME_CONFIG_FILENAME);

  let raw: string | undefined;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    raw = undefined;
  }

  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Packaged runtime configuration at ${configPath} is not valid JSON.`, {
        cause: error,
      });
    }
    return readRuntimeConfigOrigin(parsed);
  }

  if (isDevelopment) {
    const candidate = env.COMMERCE_API_URL?.trim();
    return candidate ? normalizeApiOrigin(candidate) : DEV_DEFAULT_API_ORIGIN;
  }

  throw new Error(
    `Packaged runtime configuration was not found at ${configPath}. A release build must generate ` +
      "it (pnpm gen:runtime-config) so the main process and renderer share one canonical API origin.",
  );
}
