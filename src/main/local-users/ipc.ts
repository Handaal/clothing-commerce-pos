import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  POS_AUTH_IPC_CHANNELS,
  type PosRosterCacheEntry,
  type PosUserInput,
  type PosUserUpdate,
} from "../../shared/pos-auth";
import { isAllowedRendererNavigation } from "../renderer-origin";
import { PosAuthError, type LocalUserStore } from "./store";

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
    throw new Error("POS-auth IPC rejected an untrusted renderer origin.");
  }
}

function requireString(value: unknown, field: string, maximumLength = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function parseUserInput(value: unknown): PosUserInput {
  if (!value || typeof value !== "object") throw new TypeError("User input is invalid.");
  const input = value as Record<string, unknown>;
  return {
    username: requireString(input.username, "username", 32),
    name: requireString(input.name, "name", 60),
    role: input.role === "admin" ? "admin" : "cashier",
    pin: requireString(input.pin, "pin", 64),
    permissions: Array.isArray(input.permissions)
      ? input.permissions.filter((item): item is string => typeof item === "string")
      : null,
  };
}

function parseUserUpdate(value: unknown): PosUserUpdate {
  if (!value || typeof value !== "object") throw new TypeError("User update is invalid.");
  const input = value as Record<string, unknown>;
  const update: {
    name?: string;
    role?: "admin" | "cashier";
    permissions?: readonly string[] | null;
    active?: boolean;
  } = {};
  if (input.name !== undefined) update.name = requireString(input.name, "name", 60);
  if (input.role !== undefined) update.role = input.role === "admin" ? "admin" : "cashier";
  if (input.permissions !== undefined) {
    update.permissions = Array.isArray(input.permissions)
      ? input.permissions.filter((item): item is string => typeof item === "string")
      : null;
  }
  if (input.active !== undefined) update.active = input.active === true;
  return update;
}

// Collapse PosAuthError into a tagged payload the renderer can branch on, while any unexpected error
// still surfaces as a generic IPC failure.
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
      if (!store) throw new Error("Local user store is unavailable.");
      return run(() => operation(store, ...arguments_));
    });
  };

  handle(POS_AUTH_IPC_CHANNELS.count, (store) => store.count());
  handle(POS_AUTH_IPC_CHANNELS.roster, (store) => store.roster());
  handle(POS_AUTH_IPC_CHANNELS.login, (store, username: unknown, pin: unknown) =>
    store.login(requireString(username, "username", 32), requireString(pin, "pin", 64)),
  );
  handle(POS_AUTH_IPC_CHANNELS.listUsers, (store) => store.listUsers());
  handle(POS_AUTH_IPC_CHANNELS.createUser, (store, input: unknown) =>
    store.createUser(parseUserInput(input)),
  );
  handle(POS_AUTH_IPC_CHANNELS.updateUser, (store, id: unknown, update: unknown) =>
    store.updateUser(requireString(id, "id", 64), parseUserUpdate(update)),
  );
  handle(POS_AUTH_IPC_CHANNELS.setPin, (store, id: unknown, pin: unknown) =>
    store.setPin(requireString(id, "id", 64), requireString(pin, "pin", 64)),
  );
  handle(POS_AUTH_IPC_CHANNELS.verifyPin, (store, id: unknown, pin: unknown) =>
    store.verifyUserPin(requireString(id, "id", 64), requireString(pin, "pin", 64)),
  );
  handle(POS_AUTH_IPC_CHANNELS.replaceRosterCache, (store, entries: unknown) =>
    store.replaceRosterCache(parseRosterCache(entries)),
  );
}

function parseRosterCache(value: unknown): PosRosterCacheEntry[] {
  if (!Array.isArray(value)) throw new TypeError("Roster cache is invalid.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new TypeError("Roster entry is invalid.");
    const entry = item as Record<string, unknown>;
    return {
      username: requireString(entry.username, "username", 32),
      name: requireString(entry.name, "name", 60),
      role: entry.role === "admin" ? "admin" : "cashier",
      active: entry.active === true,
    };
  });
}
