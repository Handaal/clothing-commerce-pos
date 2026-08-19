import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

import { secureWebPreferences } from "./security";

function createWindow(): void {
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
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentServerUrl) void window.loadURL(developmentServerUrl);
  else void window.loadFile(path.join(__dirname, "../../dist/index.html"));
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
