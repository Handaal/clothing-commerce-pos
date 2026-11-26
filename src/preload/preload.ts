import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { ActivityBridge, ActivityEventInput, ActivityListQuery } from "../shared/activity";
import type {
  OfflineAttendanceEventInput,
  OfflineBridge,
  OfflineBootstrapInput,
  OfflineCustomerPaymentInput,
  OfflineIntentInput,
  OfflineReturnInput,
  OfflineSaleInput,
  OfflineVoucherPreviewInput,
  OfflineNewCustomerInput,
  OfflineStaffPinInput,
  PrepareReturnGrantInput,
  ReviewQuery,
  ReviewResolutionInput,
  ReviewRetryInput,
} from "../shared/offline";
import type { ReturnsBridge, ReturnSession, ReturnIntent } from "../shared/returns";
import type { ConnectedSaleIntent, ConnectedSaleSession, SalesBridge } from "../shared/sales";
import type { PosAuthBridge, PosRosterCacheEntry } from "../shared/pos-auth";
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
  previewVoucher: "offline:preview-voucher",
  addCustomer: "offline:add-customer",
  recordAttendance: "offline:record-attendance-event",
  localAttendance: "offline:get-local-attendance",
  prepareReturnGrant: "offline:prepare-return-grant",
  returnGrants: "offline:get-return-grants",
  recordReturn: "offline:record-return",
  localReturns: "offline:get-local-returns",
  receipt: "offline:get-local-receipt",
  unacknowledged: "offline:get-unacknowledged-sales",
  acknowledge: "offline:acknowledge-sale",
  pendingSummary: "offline:get-pending-sync-summary",
  localReport: "offline:get-local-report",
  syncStatus: "offline:get-sync-status",
  requestSync: "offline:request-sync",
  bootstrap: "offline:bootstrap",
  verifyPin: "offline:verify-staff-pin",
  endStaffSession: "offline:end-staff-session",
  recordIntent: "offline:record-intent",
  localIntents: "offline:get-local-intents",
  reviewItems: "offline:get-review-items",
  reviewRetry: "offline:review-retry",
  reviewResolution: "offline:review-request-resolution",
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
  // Match the native window frame (title bar / border) to the app's light/dark theme.
  readonly setNativeTheme: (theme: "light" | "dark") => Promise<void>;
}

const viewBridge: ViewBridge = Object.freeze({
  setNativeTheme: (theme: "light" | "dark") =>
    ipcRenderer.invoke("view:set-native-theme", theme) as Promise<void>,
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
  previewOfflineVoucher: (input: OfflineVoucherPreviewInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.previewVoucher, input),
  addOfflineCustomer: (input: OfflineNewCustomerInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.addCustomer, input),
  recordAttendanceEvent: (input: OfflineAttendanceEventInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.recordAttendance, input),
  getLocalAttendance: (membershipId?: string) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.localAttendance, membershipId),
  prepareReturnGrant: (input: PrepareReturnGrantInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.prepareReturnGrant, input),
  getReturnGrants: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.returnGrants),
  recordReturn: (input: OfflineReturnInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.recordReturn, input),
  getLocalReturns: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.localReturns),
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
  endStaffSession: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.endStaffSession),
  recordIntent: (input: OfflineIntentInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.recordIntent, input),
  getLocalIntents: () => ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.localIntents),
  getReviewItems: (query: ReviewQuery) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.reviewItems, query),
  reviewRetry: (input: ReviewRetryInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.reviewRetry, input),
  reviewRequestResolution: (input: ReviewResolutionInput) =>
    ipcRenderer.invoke(OFFLINE_IPC_CHANNELS.reviewResolution, input),
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

// Display-only POS roster cache (ADR-043): no login/PIN/verify channel exists. Inlined channel names keep the
// sandboxed preload self-contained; only erased types cross from shared/pos-auth.
const POS_AUTH_IPC_CHANNELS = Object.freeze({
  count: "pos-auth:count",
  roster: "pos-auth:roster",
  replaceRosterCache: "pos-auth:replace-roster",
});

const posAuthBridge: PosAuthBridge = Object.freeze({
  count: () => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.count),
  roster: () => ipcRenderer.invoke(POS_AUTH_IPC_CHANNELS.roster),
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
