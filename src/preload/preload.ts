import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { ActivityBridge, ActivityEventInput, ActivityListQuery } from "../shared/activity";
import type {
  OfflineAttendanceEventInput,
  OfflineBridge,
  OfflineBootstrapInput,
  OfflineCustomerPaymentInput,
  OfflineSaleInput,
  OfflineStaffPinInput,
} from "../shared/offline";
import type { ReturnsBridge, ReturnSession, ReturnIntent } from "../shared/returns";
import type { ConnectedSaleIntent, ConnectedSaleSession, SalesBridge } from "../shared/sales";
import type {
  PosAuthBridge,
  PosRosterCacheEntry,
  PosUserInput,
  PosUserUpdate,
} from "../shared/pos-auth";
import type { PosSessionBridge } from "../shared/pos-session";

// Sandboxed Electron preloads cannot require arbitrary local modules. Keep this fixed allowlist
// self-contained while importing only erased TypeScript types from the shared contract.
const OFFLINE_IPC_CHANNELS = Object.freeze({
  readiness: "offline:get-readiness",
  catalog: "offline:get-cached-catalog",
  inventory: "offline:get-projected-inventory",
  customers: "offline:get-offline-customers",
  recordPayment: "offline:record-customer-payment",
  acceptCash: "offline:accept-cash-sale",
  recordAttendance: "offline:record-attendance-event",
  localAttendance: "offline:get-local-attendance",
  receipt: "offline:get-local-receipt",
  unacknowledged: "offline:get-unacknowledged-sales",
  acknowledge: "offline:acknowledge-sale",
  pendingSummary: "offline:get-pending-sync-summary",
  localReport: "offline:get-local-report",
  syncStatus: "offline:get-sync-status",
  requestSync: "offline:request-sync",
  bootstrap: "offline:bootstrap",
  verifyPin: "offline:verify-staff-pin",
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

// Per-device display size. The renderer stores the chosen scale (localStorage) and applies it here as
// the frame's zoom factor — exactly like the browser's Ctrl +/−, so layout, fixed elements and portals
// all scale cleanly. It belongs to the machine (a cramped 14" laptop vs a roomy 16"), not the business.
export interface ViewBridge {
  readonly setZoom: (factor: number) => void;
}

const viewBridge: ViewBridge = Object.freeze({
  setZoom: (factor: number) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch {
      // No-op outside a live frame (e.g. a non-Electron test host).
    }
  },
});

contextBridge.exposeInMainWorld("view", viewBridge);

const offlineBridge: OfflineBridge = Object.freeze({
  getReadiness: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.readiness),
  getCachedCatalog: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.catalog),
  getProjectedInventory: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.inventory),
  getOfflineCustomers: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.customers),
  recordCustomerPayment: (input: OfflineCustomerPaymentInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.recordPayment, input),
  acceptCashSale: (input: OfflineSaleInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.acceptCash, input),
  recordAttendanceEvent: (input: OfflineAttendanceEventInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.recordAttendance, input),
  getLocalAttendance: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.localAttendance),
  getLocalReceipt: (localSaleId: string) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.receipt, localSaleId),
  getUnacknowledgedSales: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.unacknowledged),
  acknowledgeSale: (localSaleId: string) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.acknowledge, localSaleId),
  getPendingSyncSummary: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.pendingSummary),
  getLocalReport: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.localReport),
  getSyncStatus: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.syncStatus),
  requestSync: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.requestSync),
  bootstrap: (input: OfflineBootstrapInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.bootstrap, input),
  verifyStaffPin: (input: OfflineStaffPinInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.verifyPin, input),
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

// Device-local POS floor-staff auth (shifted-cafe model). Inlined channel names keep the sandboxed
// preload self-contained; only erased types cross from shared/pos-auth.
const POS_AUTH_IPC_CHANNELS = Object.freeze({
  count: "pos-auth:count",
  roster: "pos-auth:roster",
  login: "pos-auth:login",
  listUsers: "pos-auth:list-users",
  createUser: "pos-auth:create-user",
  updateUser: "pos-auth:update-user",
  setPin: "pos-auth:set-pin",
  verifyPin: "pos-auth:verify-pin",
  replaceRosterCache: "pos-auth:replace-roster",
});

const posAuthBridge: PosAuthBridge = Object.freeze({
  count: () => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.count),
  roster: () => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.roster),
  login: (username: string, pin: string) =>
    ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.login, username, pin),
  listUsers: () => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.listUsers),
  createUser: (input: PosUserInput) => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.createUser, input),
  updateUser: (id: string, update: PosUserUpdate) =>
    ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.updateUser, id, update),
  setPin: (id: string, pin: string) => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.setPin, id, pin),
  verifyPin: (id: string, pin: string) =>
    ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.verifyPin, id, pin),
  replaceRosterCache: (entries: readonly PosRosterCacheEntry[]) =>
    ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.replaceRosterCache, entries),
});
contextBridge.exposeInMainWorld("posAuth", posAuthBridge);

// POS-native (pos_pin) connected session: username + PIN → server access token, owned by the main
// process. Inlined channel names keep the sandboxed preload self-contained; only erased types cross from
// shared/pos-session.
const POS_SESSION_IPC_CHANNELS = Object.freeze({
  login: "pos-session:login",
  verifyCredentials: "pos-session:verify-credentials",
  getSession: "pos-session:get-session",
  getToken: "pos-session:get-token",
  logout: "pos-session:logout",
});

const posSessionBridge: PosSessionBridge = Object.freeze({
  login: (username: string, pin: string) =>
    ipcRenderer.invoke(POS_SESSION_IPC_CHANNELS.login, username, pin),
  verifyCredentials: (username: string, pin: string) =>
    ipcRenderer.invoke(POS_SESSION_IPC_CHANNELS.verifyCredentials, username, pin),
  getSession: () => ipcRenderer.invoke(POS_SESSION_IPC_CHANNELS.getSession),
  getToken: () => ipcRenderer.invoke(POS_SESSION_IPC_CHANNELS.getToken),
  logout: () => ipcRenderer.invoke(POS_SESSION_IPC_CHANNELS.logout),
});
contextBridge.exposeInMainWorld("posSession", posSessionBridge);
