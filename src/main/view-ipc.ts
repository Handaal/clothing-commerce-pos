import { ipcMain, nativeTheme } from "electron";

import { isAllowedRendererNavigation } from "./renderer-origin";

// The window keeps the native OS frame, which follows the OS light/dark setting rather than the
// in-page theme — so a dark POS on a light Windows shows a bright title bar/border strip above the
// app. The renderer reports its chosen theme here and the native frame is switched to match.
export const VIEW_IPC_CHANNELS = Object.freeze({
  setNativeTheme: "view:set-native-theme",
});

export function registerViewIpc(rendererUrl: string): void {
  ipcMain.handle(VIEW_IPC_CHANNELS.setNativeTheme, (event, theme: unknown) => {
    if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
      throw new Error("View IPC rejected an untrusted renderer origin.");
    }
    if (theme !== "light" && theme !== "dark") return;
    nativeTheme.themeSource = theme;
  });
}
