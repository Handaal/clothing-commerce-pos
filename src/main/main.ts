import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

import { isAllowedRendererNavigation, PRODUCTION_RENDERER_ORIGIN } from "./renderer-origin";
import { startRendererServer } from "./renderer-server";
import { secureWebPreferences } from "./security";

function createWindow(): void {
  const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
  const rendererUrl = developmentServerUrl ?? `${PRODUCTION_RENDERER_ORIGIN}/index.html`;
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

void app.whenReady().then(() => {
  void (async () => {
    if (!process.env.VITE_DEV_SERVER_URL) {
      await startRendererServer(path.join(__dirname, "../../dist"));
    }
    createWindow();
  })();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
