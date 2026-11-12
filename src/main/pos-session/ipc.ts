import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { POS_SESSION_IPC_CHANNELS } from "../../shared/pos-session";
import { isAllowedRendererNavigation } from "../renderer-origin";
import type { PosSessionManager } from "./manager";

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
    throw new Error("POS-session IPC rejected an untrusted renderer origin.");
  }
}

function requireString(value: unknown, field: string, maximumLength = 64): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

export function registerPosSessionIpc(
  getManager: () => PosSessionManager | undefined,
  rendererUrl: string,
): void {
  const manager = (event: IpcMainInvokeEvent): PosSessionManager => {
    assertTrustedSender(event, rendererUrl);
    const instance = getManager();
    if (!instance) throw new Error("POS session manager is unavailable.");
    return instance;
  };

  ipcMain.handle(POS_SESSION_IPC_CHANNELS.login, (event, username: unknown, pin: unknown) =>
    manager(event).login(requireString(username, "username", 32), requireString(pin, "pin", 64)),
  );
  ipcMain.handle(
    POS_SESSION_IPC_CHANNELS.verifyCredentials,
    (event, username: unknown, pin: unknown) =>
      manager(event).verifyCredentials(
        requireString(username, "username", 32),
        requireString(pin, "pin", 64),
      ),
  );
  ipcMain.handle(POS_SESSION_IPC_CHANNELS.getSession, (event) => manager(event).getSession());
  ipcMain.handle(POS_SESSION_IPC_CHANNELS.getToken, (event) => manager(event).getToken());
  ipcMain.handle(POS_SESSION_IPC_CHANNELS.logout, (event) => manager(event).logout());
}
