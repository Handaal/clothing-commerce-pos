/* eslint-disable @typescript-eslint/no-require-imports */
// electron-builder afterPack hook.
//
// Why this exists (Windows packaging EPERM, roadmap §21.8): electron-builder 26.15.3's default path extracts
// the Electron zip into `release/win-unpacked.tmp` and then performs ONE non-retried fs.rename of that whole
// directory to `win-unpacked`. On this workstation the project tree is watched by several processes (editor,
// desktop apps, dev servers) and the freshly extracted directory keeps an open handle, so that single rename
// fails with EPERM every time. The package config therefore uses electron-builder's supported `electronDist`
// option to COPY the already-installed, checksum-verified `node_modules/electron/dist` (the identical
// official Electron build, same version as the `electron` devDependency) straight into the output directory —
// no directory rename. For a custom electronDist, electron-builder intentionally skips its post-unpack
// cleanup, so this hook performs exactly that cleanup to keep the output byte-equivalent to the default path:
// remove `resources/default_app.asar` and the top-level `version` file (the LICENSE rename still runs).
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32" && context.electronPlatformName !== "linux") return;
  for (const relative of [path.join("resources", "default_app.asar"), "version"]) {
    const target = path.join(context.appOutDir, relative);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
};
