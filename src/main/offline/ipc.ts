import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  OFFLINE_IPC_CHANNELS,
  type OfflineBootstrapInput,
  type OfflineSaleInput,
  type OfflineTender,
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

const OFFLINE_TENDER_METHODS = new Set(["cash", "card", "instapay", "wallet"]);

function parseOfflineTender(raw: unknown): OfflineTender {
  if (!raw || typeof raw !== "object") throw new TypeError("Offline tender is invalid.");
  const tender = raw as Record<string, unknown>;
  if (typeof tender.method !== "string" || !OFFLINE_TENDER_METHODS.has(tender.method)) {
    throw new TypeError("Offline tender method is invalid.");
  }
  if (!Number.isSafeInteger(tender.amountMinor) || Number(tender.amountMinor) <= 0) {
    throw new TypeError("Offline tender amount is invalid.");
  }
  const method = tender.method as OfflineTender["method"];
  if (tender.cashReceivedMinor !== undefined) {
    if (!Number.isSafeInteger(tender.cashReceivedMinor) || Number(tender.cashReceivedMinor) < 0) {
      throw new TypeError("Offline tender cash received is invalid.");
    }
    return { method, amountMinor: Number(tender.amountMinor), cashReceivedMinor: Number(tender.cashReceivedMinor) };
  }
  return { method, amountMinor: Number(tender.amountMinor) };
}

export function parseOfflineSaleInput(value: unknown): OfflineSaleInput {
  if (!value || typeof value !== "object") throw new TypeError("Offline sale input is invalid.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new TypeError("Offline sale lines are invalid.");
  }
  const hasTenders = Array.isArray(input.tenders) && input.tenders.length > 0;
  if (!hasTenders && (!Number.isSafeInteger(input.cashReceivedMinor) || Number(input.cashReceivedMinor) < 0)) {
    throw new TypeError("Offline cash received is invalid.");
  }
  const tenders = hasTenders
    ? (input.tenders as unknown[]).slice(0, 4).map(parseOfflineTender)
    : undefined;
  return {
    cashReceivedMinor: Number.isSafeInteger(input.cashReceivedMinor)
      ? Number(input.cashReceivedMinor)
      : 0,
    ...(tenders ? { tenders } : {}),
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
