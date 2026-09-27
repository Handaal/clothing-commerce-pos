// Commerce API origin consistency acceptance.
//
// Proves the P1-1 invariant: the renderer (compile-time baked) and the Electron main process
// (runtime read) resolve the SAME canonical Commerce API origin from ONE generated artifact, that a
// non-default origin is carried into the packaged build, that invalid origins are rejected, and that
// a missing production configuration fails closed instead of silently pointing main at localhost.
//
// This is intentionally cross-platform (no Electron spawn) so it runs as a required gate on any CI
// runner. It builds the renderer once with a distinguishing loopback origin.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_CONFIG_FILENAME,
  normalizeApiOrigin,
  resolveApiOrigin,
} from "../src/shared/api-origin.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISTINGUISHING_ORIGIN = "http://127.0.0.1:59107";

function fail(message) {
  process.stderr.write(`origin:check FAILED — ${message}\n`);
  process.exit(1);
}

// 1. Unit-level guarantees on the single shared resolver.
if (
  resolveApiOrigin({ value: "https://api.example.com/", mode: "production" }) !==
  "https://api.example.com"
)
  fail("resolver did not normalize a valid production origin");
try {
  resolveApiOrigin({ value: "not-a-url", mode: "production" });
  fail("resolver accepted an invalid origin");
} catch {
  /* expected */
}
try {
  resolveApiOrigin({ value: "ftp://api.example.com", mode: "production" });
  fail("resolver accepted a non-http(s) origin");
} catch {
  /* expected */
}
try {
  resolveApiOrigin({ value: "", mode: "production" });
  fail("resolver did not fail closed on a missing production origin");
} catch {
  /* expected */
}

// 2. Generate the canonical artifact and build the renderer from it with a distinguishing origin.
const generate = spawnSync(
  process.execPath,
  ["scripts/generate-runtime-config.mjs", "--mode=production"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, COMMERCE_API_URL: DISTINGUISHING_ORIGIN },
  },
);
if (generate.status !== 0) fail("generate-runtime-config did not succeed");

const configPath = join(repositoryRoot, "dist-electron", RUNTIME_CONFIG_FILENAME);
const mainResolved = normalizeApiOrigin(
  JSON.parse(readFileSync(configPath, "utf8")).commerceApiUrl,
);
if (mainResolved !== DISTINGUISHING_ORIGIN)
  fail(`packaged artifact origin ${mainResolved} != configured ${DISTINGUISHING_ORIGIN}`);

// Invoke Vite through Node directly rather than the `pnpm`/`pnpm.cmd` shim. Node 24 refuses to spawn
// a `.cmd`/`.bat` file without `shell: true` (EINVAL), which made this step fail-closed with a
// swallowed error on the Windows CI runner. Spawning the resolved JS bin with `process.execPath`
// is the portable convention already used by this repo's other acceptance runners, and it inherits
// the full environment (PATH, CI variables, and the generated runtime-config artifact on disk).
const rendererBuild = spawnSync(
  process.execPath,
  [join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"), "build"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);
if (rendererBuild.status !== 0) {
  const details = [
    rendererBuild.error && `error=${rendererBuild.error.code ?? rendererBuild.error.message}`,
    `status=${rendererBuild.status}`,
    rendererBuild.signal && `signal=${rendererBuild.signal}`,
  ]
    .filter(Boolean)
    .join(" ");
  fail(`renderer build did not succeed (${details})`);
}

// 3. Extract the origin baked into the renderer bundle and assert it matches the packaged artifact.
const assetsDir = join(repositoryRoot, "dist", "assets");
const bundleOrigins = new Set();
for (const file of readdirSync(assetsDir)) {
  if (!file.endsWith(".js")) continue;
  const text = readFileSync(join(assetsDir, file), "utf8");
  for (const match of text.matchAll(/https?:\/\/127\.0\.0\.1:\d+|https?:\/\/localhost:\d+/g)) {
    bundleOrigins.add(match[0]);
  }
}
if (!bundleOrigins.has(DISTINGUISHING_ORIGIN))
  fail(
    `renderer bundle did not bake ${DISTINGUISHING_ORIGIN}; found ${[...bundleOrigins].join(", ")}`,
  );
if (bundleOrigins.has("http://localhost:3000"))
  fail("renderer bundle still contains the localhost:3000 default alongside the configured origin");

// 4. Fail-closed is asserted in-process in step 1 (resolveApiOrigin throws for a missing production
// origin). Restore the default (dev) artifact so a subsequent normal build is not left with the
// distinguishing probe origin.
writeFileSync(
  configPath,
  `${JSON.stringify({ commerceApiUrl: resolveApiOrigin({ value: "", mode: "development" }) }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  JSON.stringify({
    ok: true,
    packagedOrigin: mainResolved,
    rendererBakedOrigin: DISTINGUISHING_ORIGIN,
    mainEqualsRenderer: true,
  }) + "\n",
);
