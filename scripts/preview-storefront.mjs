// Dev preview launcher: runs the storefront's Next dev server in ITS own cwd on port 3002.
// Spawns node directly on next's JS entry (never a .cmd) to avoid the Node 24 / Windows spawn EINVAL.
import { spawn } from "node:child_process";
import path from "node:path";

const dir = path.resolve("C:/Users/ydelk/Desktop/clothing-commerce-storefront");
const nextBin = path.join(dir, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextBin, "dev", "-p", "3002"], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, PORT: "3002" },
});
child.on("exit", (code) => process.exit(code ?? 0));
