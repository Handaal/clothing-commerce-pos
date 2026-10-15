import { app, BrowserWindow, net, safeStorage, session, shell } from "electron";
import path from "node:path";

import { registerActivityIpc } from "./activity/ipc";
import { registerOfflineIpc } from "./offline/ipc";
import { registerReturnIpc } from "./returns/ipc";
import { registerSalesIpc } from "./sales/ipc";
import { OfflineRuntime } from "./offline/runtime";
import { isAllowedRendererNavigation, PRODUCTION_RENDERER_ORIGIN } from "./renderer-origin";
import { startRendererServer } from "./renderer-server";
import { resolveMainApiOrigin } from "./runtime-config";
import { secureWebPreferences } from "./security";

function createWindow(rendererUrl: string): void {
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      ...secureWebPreferences,
      preload: path.join(__dirname, "../preload/preload.js"),
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isAllowedRendererNavigation(destination, rendererUrl)) event.preventDefault();
  });

  void window.loadURL(rendererUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let offlineRuntime: OfflineRuntime | undefined;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    void (async () => {
      const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
      const rendererUrl = developmentServerUrl ?? `${PRODUCTION_RENDERER_ORIGIN}/index.html`;
      // Single canonical Commerce API origin. In a packaged app this is read from the generated
      // dist-electron/runtime-config.json — the same value baked into the renderer — and fails
      // closed if absent/invalid, so main and renderer can never target different origins.
      const commerceApiUrl = resolveMainApiOrigin();
      if (!developmentServerUrl) {
        await startRendererServer(path.join(__dirname, "../../dist"));
      }
      const osSecureStorage = {
        isEncryptionAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform === "win32" ||
            process.platform === "darwin" ||
            safeStorage.getSelectedStorageBackend() !== "basic_text"),
        encryptString: (plaintext: string) => safeStorage.encryptString(plaintext),
        decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
        isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
        encryptStringAsync: (plaintext: string) => safeStorage.encryptStringAsync(plaintext),
        decryptStringAsync: (encrypted: Buffer) => safeStorage.decryptStringAsync(encrypted),
      };
      offlineRuntime = await OfflineRuntime.initialize(
        app.getPath("userData"),
        osSecureStorage,
        commerceApiUrl,
        {
          networkOnline: () => net.isOnline(),
          secureStorageDurabilityBarrier: async () => session.defaultSession.flushStorageData(),
        },
      );
      registerOfflineIpc(offlineRuntime, rendererUrl);
      registerReturnIpc(() => offlineRuntime!.getReturns(), rendererUrl);
      registerSalesIpc(() => offlineRuntime!.getSales(), rendererUrl);
      registerActivityIpc(() => offlineRuntime!.getActivityStore(), rendererUrl);
      createWindow(rendererUrl);
    })();
    app.on("activate", () => {
      const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
      const rendererUrl = developmentServerUrl ?? `${PRODUCTION_RENDERER_ORIGIN}/index.html`;
      if (BrowserWindow.getAllWindows().length === 0) createWindow(rendererUrl);
    });
  });

  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("before-quit", () => {
    offlineRuntime?.close();
    offlineRuntime = undefined;
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
