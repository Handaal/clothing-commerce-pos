import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { POS_AUTH_IPC_CHANNELS, type PosRosterCacheEntry } from "../../shared/pos-auth";
import { isAllowedRendererNavigation } from "../renderer-origin";
import { PosAuthError, type LocalUserStore } from "./store";

// ADR-043: display-only roster-cache IPC. There is deliberately no login/PIN/verify channel here — POS
// credentials are verified by the server (pos-session IPC) or the device-bound offline verifier (offline IPC).

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
    throw new Error("POS-auth IPC rejected an untrusted renderer origin.");
  }
}

function requireString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function run<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PosAuthError) throw new Error(`POS_AUTH:${error.code}`);
    throw error;
  }
}

export function registerPosAuthIpc(
  getStore: () => LocalUserStore | undefined,
  rendererUrl: string,
): void {
  const handle = <T extends unknown[], R>(
    channel: string,
    operation: (store: LocalUserStore, ...arguments_: T) => R,
  ) => {
    ipcMain.handle(channel, (event, ...arguments_: T) => {
      assertTrustedSender(event, rendererUrl);
      const store = getStore();
      if (!store) throw new Error("Local roster cache is unavailable.");
      return run(() => operation(store, ...arguments_));
    });
  };

  handle(POS_AUTH_IPC_CHANNELS.count, (store) => store.count());
  handle(POS_AUTH_IPC_CHANNELS.roster, (store) => store.roster());
  handle(POS_AUTH_IPC_CHANNELS.replaceRosterCache, (store, entries: unknown) =>
    store.replaceRosterCache(parseRosterCache(entries)),
  );
}

export function parseRosterCache(value: unknown): PosRosterCacheEntry[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new TypeError("Roster cache is invalid.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new TypeError("Roster entry is invalid.");
    const entry = item as Record<string, unknown>;
    // Only the four display fields are read; anything else on the object (e.g. a stray `pin`) is ignored.
    return {
      username: requireString(entry.username, "username", 32),
      name: requireString(entry.name, "name", 120),
      role: entry.role === "admin" ? "admin" : "cashier",
      active: entry.active === true,
    };
  });
}
