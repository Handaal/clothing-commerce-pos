import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const electronPath = resolve(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");

function stop(process) {
  if (!process || process.exitCode !== null) return;
  spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function rendererTarget(debuggingPort, expectedOrigin) {
  const endpoint = `http://127.0.0.1:${debuggingPort}/json/list`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl && new URL(page.url).origin === expectedOrigin) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // Electron and its renderer are still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for Electron DevTools on port ${debuggingPort}`);
}

async function readRendererOrigin(webSocketUrl) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out reading the renderer origin"));
    }, 20_000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: "location.origin",
            returnByValue: true,
          },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(
          new Error(
            `Renderer origin probe evaluation failed: ${message.result.exceptionDetails.text}`,
          ),
        );
      } else {
        resolvePromise(message.result.result.value);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to the Electron renderer DevTools target"));
    });
  });
}

async function waitForRendererOrigin(webSocketUrl, expectedOrigin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const origin = await readRendererOrigin(webSocketUrl);
    if (origin === expectedOrigin) return origin;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Electron renderer did not settle on ${expectedOrigin}`);
}

async function observeOrigin(mode) {
  let vite;
  let electron;
  try {
    const debuggingPort = mode === "development" ? 9223 : 9224;
    const expectedOrigin =
      mode === "development" ? "http://127.0.0.1:5173" : "http://127.0.0.1:4173";
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    if (mode === "development") {
      vite = spawn("pnpm.cmd", ["exec", "vite", "--host", "127.0.0.1"], {
        cwd: repositoryRoot,
        env: environment,
        shell: true,
        stdio: "ignore",
      });
      await waitFor("http://127.0.0.1:5173");
      environment.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
    } else {
      delete environment.VITE_DEV_SERVER_URL;
    }
    electron = spawn(electronPath, [".", `--remote-debugging-port=${debuggingPort}`], {
      cwd: repositoryRoot,
      env: environment,
      stdio: "ignore",
    });
    const webSocketUrl = await rendererTarget(debuggingPort, expectedOrigin);
    return await waitForRendererOrigin(webSocketUrl, expectedOrigin);
  } finally {
    stop(electron);
    stop(vite);
  }
}

const developmentOrigin = await observeOrigin("development");
const productionOrigin = await observeOrigin("production");
console.log(JSON.stringify({ developmentOrigin, productionOrigin }));
