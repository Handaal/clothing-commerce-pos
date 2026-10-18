import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import {
  RUNTIME_CONFIG_FILENAME,
  readRuntimeConfigOrigin,
  resolveApiOrigin,
} from "./src/shared/api-origin.ts";

/**
 * The renderer's Commerce API origin is baked at build time. To guarantee it matches the value the
 * Electron main process reads at runtime, a production build consumes the SAME generated artifact
 * (dist-electron/runtime-config.json, produced by scripts/generate-runtime-config.mjs). Development
 * has no artifact and resolves from the environment with the localhost default.
 */
function resolveRendererOrigin(mode: string, cwd: string): string {
  if (mode === "production") {
    const configPath = resolve(cwd, "dist-electron", RUNTIME_CONFIG_FILENAME);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Production renderer build requires ${configPath}. Run \`pnpm gen:runtime-config\` first ` +
          "so the renderer and Electron main share one canonical Commerce API origin.",
        { cause: error },
      );
    }
    return readRuntimeConfigOrigin(parsed);
  }
  const environment = loadEnv(mode, cwd, "");
  return resolveApiOrigin({ value: environment.COMMERCE_API_URL, mode: "development" });
}

export default defineConfig(({ mode }) => {
  const cwd = process.cwd();
  const environment = loadEnv(mode, cwd, "");
  const commerceApiUrl = resolveRendererOrigin(mode, cwd);

  return {
    plugins: [react()],
    define: {
      "import.meta.env.COMMERCE_API_URL": JSON.stringify(commerceApiUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(
        environment.VITE_CLERK_PUBLISHABLE_KEY ?? "",
      ),
    },
    build: {
      outDir: "dist",
    },
    test: {
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});
