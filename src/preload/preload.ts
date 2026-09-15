import { contextBridge, ipcRenderer } from "electron";

import type { OfflineBridge, OfflineBootstrapInput, OfflineSaleInput } from "../shared/offline";

// Sandboxed Electron preloads cannot require arbitrary local modules. Keep this fixed allowlist
// self-contained while importing only erased TypeScript types from the shared contract.
const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  acceptCash: "offline:accept-cash-sale",
  receipt: "offline:get-local-receipt",
  pendingSummary: "offline:get-pending-sync-summary",
  syncStatus: "offline:get-sync-status",
  requestSync: "offline:request-sync",
  bootstrap: "offline:bootstrap",
});

export interface FoundationBridge {
  readonly platform: NodeJS.Platform;
  readonly versions: Readonly<{ electron: string; chrome: string }>;
}

const foundationBridge: FoundationBridge = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
});

contextBridge.exposeInMainWorld("foundation", foundationBridge);

const offlineBridge: OfflineBridge = Object.freeze({
  getReadiness: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.readiness),
  getCachedCatalog: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.catalog),
  getProjectedInventory: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.inventory),
  acceptCashSale: (input: OfflineSaleInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.acceptCash, input),
  getLocalReceipt: (localSaleId: string) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.receipt, localSaleId),
  getPendingSyncSummary: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.pendingSummary),
  getSyncStatus: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.syncStatus),
  requestSync: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.requestSync),
  bootstrap: (input: OfflineBootstrapInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.bootstrap, input),
});

contextBridge.exposeInMainWorld("offline", offlineBridge);
