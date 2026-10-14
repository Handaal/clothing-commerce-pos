import { contextBridge, ipcRenderer } from "electron";

import type { ActivityBridge, ActivityEventInput, ActivityListQuery } from "../shared/activity";
import type { OfflineBridge, OfflineBootstrapInput, OfflineSaleInput } from "../shared/offline";
import type { ReturnsBridge, ReturnSession, ReturnIntent } from "../shared/returns";
import type { ConnectedSaleIntent, ConnectedSaleSession, SalesBridge } from "../shared/sales";

// Sandboxed Electron preloads cannot require arbitrary local modules. Keep this fixed allowlist
// self-contained while importing only erased TypeScript types from the shared contract.
const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  acceptCash: "offline:accept-cash-sale",
  receipt: "offline:get-local-receipt",
  unacknowledged: "offline:get-unacknowledged-sales",
  acknowledge: "offline:acknowledge-sale",
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
  getUnacknowledgedSales: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.unacknowledged),
  acknowledgeSale: (localSaleId: string) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.acknowledge, localSaleId),
  getPendingSyncSummary: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.pendingSummary),
  getSyncStatus: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.syncStatus),
  requestSync: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.requestSync),
  bootstrap: (input: OfflineBootstrapInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.bootstrap, input),
});

contextBridge.exposeInMainWorld("offline", offlineBridge);

const returnsBridge: ReturnsBridge = Object.freeze({
  hasPending: () => ipcRenderer.invoke("returns:has-pending"),
  inspect: (session: ReturnSession) => ipcRenderer.invoke("returns:inspect", session),
  start: (session: ReturnSession, intent: ReturnIntent) =>
    ipcRenderer.invoke("returns:start", session, intent),
  recover: (session: ReturnSession) => ipcRenderer.invoke("returns:recover", session),
  settle: (session: ReturnSession, returnId: string, reference: string) =>
    ipcRenderer.invoke("returns:settle", session, returnId, reference),
  finish: (session: ReturnSession, workflowId: string) =>
    ipcRenderer.invoke("returns:finish", session, workflowId),
});
contextBridge.exposeInMainWorld("returns", returnsBridge);

// Inlined to keep the sandboxed preload self-contained (only erased types cross from shared/sales).
const SALES_IPC_CHANNELS = Object.freeze({
  hasPending: "sales:has-pending",
  submit: "sales:submit",
  recover: "sales:recover",
  acknowledge: "sales:acknowledge",
});

const salesBridge: SalesBridge = Object.freeze({
  hasPending: () => ipcRenderer.invoke(SALES_IPC_CHANNELS.hasPending),
  submit: (session: ConnectedSaleSession, intent: ConnectedSaleIntent) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.submit, session, intent),
  recover: (session: ConnectedSaleSession) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.recover, session),
  acknowledge: (session: ConnectedSaleSession, workflowId: string) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.acknowledge, session, workflowId),
});
contextBridge.exposeInMainWorld("sales", salesBridge);

// Client-only activity ledger. Inlined channel names keep the sandboxed preload self-contained.
const ACTIVITY_IPC_CHANNELS = Object.freeze({
  append: "activity:append",
  list: "activity:list",
});

const activityBridge: ActivityBridge = Object.freeze({
  append: (event: ActivityEventInput) => ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.append, event),
  list: (query: ActivityListQuery) => ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.list, query),
});
contextBridge.exposeInMainWorld("activity", activityBridge);
