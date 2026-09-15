import { contextBridge, ipcRenderer } from "electron";

import {
  OFFLINE_IPC_CHANNELS,
  type OfflineBridge,
  type OfflineBootstrapInput,
  type OfflineSaleInput,
} from "../shared/offline";

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
  bootstrap: (input: OfflineBootstrapInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.bootstrap, input),
});

contextBridge.exposeInMainWorld("offline", offlineBridge);
