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
 * release build from the same value baked into the renderer. A packaged app reads ONLY that artifact
 * at runtime — never `process.env` — so it cannot drift from the renderer and does not depend on the
 * operator launching Electron from a shell with a matching variable. A missing/invalid artifact fails
 * closed rather than silently pointing at localhost.
 *
 * Development (identified by `VITE_DEV_SERVER_URL`, set by `pnpm dev`) resolves exactly like the
 * renderer — from `process.env.COMMERCE_API_URL` (the `.env` Vite loads) or the localhost default.
 * Any `dist-electron/runtime-config.json` left behind by a prior `pnpm build` is deliberately IGNORED
 * in development: `pnpm dev` never regenerates it, so trusting a stale artifact would silently point
 * main at the wrong packaged origin and drift from the renderer (connected sales would then post to
 * that dead origin and fail as "sale result unknown").
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

  // Development: mirror the renderer's origin and ignore any stale packaged artifact on disk.
  if (isDevelopment) {
    const candidate = env.COMMERCE_API_URL?.trim();
    return candidate ? normalizeApiOrigin(candidate) : DEV_DEFAULT_API_ORIGIN;
  }

  // Packaged: the single canonical source of truth is the generated artifact; never process.env.
  // dist-electron/main/main.js → dist-electron/runtime-config.json
  const configDirectory = options.configDirectory ?? path.join(__dirname, "..");
  const configPath = path.join(configDirectory, RUNTIME_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Packaged runtime configuration was not found at ${configPath}. A release build must generate ` +
        "it (pnpm gen:runtime-config) so the main process and renderer share one canonical API origin.",
    );
  }

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
