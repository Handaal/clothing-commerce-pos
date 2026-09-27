import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  OFFLINE_IPC_CHANNELS,
  type OfflineBootstrapInput,
  type OfflineSaleInput,
} from "../../shared/offline";
import { isAllowedRendererNavigation } from "../renderer-origin";
import { OfflineRuntime } from "./runtime";

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
    throw new Error("Offline IPC rejected an untrusted renderer origin.");
  }
}

function requireString(value: unknown, field: string, maximumLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

export function parseOfflineSaleInput(value: unknown): OfflineSaleInput {
  if (!value || typeof value !== "object") throw new TypeError("Offline sale input is invalid.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new TypeError("Offline sale lines are invalid.");
  }
  if (!Number.isSafeInteger(input.cashReceivedMinor) || Number(input.cashReceivedMinor) < 0) {
    throw new TypeError("Offline cash received is invalid.");
  }
  return {
    cashReceivedMinor: Number(input.cashReceivedMinor),
    lines: input.lines.map((raw) => {
      if (!raw || typeof raw !== "object") throw new TypeError("Offline sale line is invalid.");
      const line = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0) {
        throw new TypeError("Offline sale quantity is invalid.");
      }
      return {
        variantId: requireString(line.variantId, "variantId"),
        quantity: Number(line.quantity),
      };
    }),
  };
}

export function parseOfflineBootstrapInput(value: unknown): OfflineBootstrapInput {
  if (!value || typeof value !== "object")
    throw new TypeError("Offline bootstrap input is invalid.");
  const input = value as Record<string, unknown>;
  return {
    tenantId: requireString(input.tenantId, "tenantId"),
    registerId: requireString(input.registerId, "registerId"),
    displayName: requireString(input.displayName, "displayName"),
    accessToken: requireString(input.accessToken, "accessToken", 16_384),
  };
}

export function registerOfflineIpc(runtime: OfflineRuntime, rendererUrl: string): void {
  const handle = <T extends unknown[], R>(
    channel: string,
    operation: (event: IpcMainInvokeEvent, ...arguments_: T) => R,
  ) => {
    ipcMain.handle(channel, (event, ...arguments_: T) => {
      assertTrustedSender(event, rendererUrl);
      return operation(event, ...arguments_);
    });
  };
  handle(OFFLINE_IPC_CHANNELS.readiness, () => runtime.getReadiness());
  handle(OFFLINE_IPC_CHANNELS.catalog, () => runtime.getCachedCatalog());
  handle(OFFLINE_IPC_CHANNELS.inventory, () => runtime.getProjectedInventory());
  handle(OFFLINE_IPC_CHANNELS.acceptCash, (_event, input: unknown) =>
    runtime.acceptCashSale(parseOfflineSaleInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.receipt, (_event, localSaleId: unknown) =>
    runtime.getLocalReceipt(requireString(localSaleId, "localSaleId")),
  );
  handle(OFFLINE_IPC_CHANNELS.unacknowledged, () => runtime.getUnacknowledgedSales());
  handle(OFFLINE_IPC_CHANNELS.acknowledge, (_event, localSaleId: unknown) =>
    runtime.acknowledgeSale(requireString(localSaleId, "localSaleId")),
  );
  handle(OFFLINE_IPC_CHANNELS.pendingSummary, () => runtime.getPendingSyncSummary());
  handle(OFFLINE_IPC_CHANNELS.syncStatus, () => runtime.getSyncStatus());
  handle(OFFLINE_IPC_CHANNELS.requestSync, () => runtime.requestSync());
  handle(OFFLINE_IPC_CHANNELS.bootstrap, (_event, input: unknown) =>
    runtime.bootstrap(parseOfflineBootstrapInput(input)),
  );
}
