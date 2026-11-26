import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { isTransportablePosPin } from "../../shared/pos-auth";

import {
  OFFLINE_INTENT_OPERATIONS,
  OFFLINE_IPC_CHANNELS,
  type OfflineIntentInput,
  type OfflineIntentPayloadObject,
  type ReviewLane,
  type ReviewQuery,
  type ReviewResolutionInput,
  type ReviewRetryInput,
  type OfflineAttendanceEventInput,
  type OfflineBootstrapInput,
  type OfflineCustomerPaymentInput,
  type OfflineReturnInput,
  type OfflineSaleInput,
  type PrepareReturnGrantInput,
  type OfflineStaffPinInput,
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
    return {
      method,
      amountMinor: Number(tender.amountMinor),
      cashReceivedMinor: Number(tender.cashReceivedMinor),
    };
  }
  return { method, amountMinor: Number(tender.amountMinor) };
}

function parseApprover(value: unknown): { username: string; password: string } | undefined {
  if (value === undefined) return undefined;
  const approver = (value ?? {}) as { username?: unknown; password?: unknown };
  if (
    typeof approver.username !== "string" ||
    typeof approver.password !== "string" ||
    approver.username.length > 64 ||
    approver.password.length > 128
  ) {
    throw new TypeError("Approval input is invalid.");
  }
  return { username: approver.username, password: approver.password };
}

function parseVoucherInput(value: unknown): NonNullable<OfflineSaleInput["voucher"]> {
  const voucher = (value ?? {}) as { code?: unknown; voucherGrantId?: unknown; approver?: unknown };
  const code = typeof voucher.code === "string" ? voucher.code.slice(0, 64) : undefined;
  const voucherGrantId =
    typeof voucher.voucherGrantId === "string" ? voucher.voucherGrantId.slice(0, 64) : undefined;
  if (!code && !voucherGrantId) throw new TypeError("Voucher input is invalid.");
  const approver = parseApprover(voucher.approver);
  return {
    ...(code ? { code } : {}),
    ...(voucherGrantId ? { voucherGrantId } : {}),
    ...(approver ? { approver } : {}),
  };
}

export function parseOfflineSaleInput(value: unknown): OfflineSaleInput {
  if (!value || typeof value !== "object") throw new TypeError("Offline sale input is invalid.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new TypeError("Offline sale lines are invalid.");
  }
  const hasTenders = Array.isArray(input.tenders) && input.tenders.length > 0;
  if (
    !hasTenders &&
    (!Number.isSafeInteger(input.cashReceivedMinor) || Number(input.cashReceivedMinor) < 0)
  ) {
    throw new TypeError("Offline cash received is invalid.");
  }
  const tenders = hasTenders
    ? (input.tenders as unknown[]).slice(0, 4).map(parseOfflineTender)
    : undefined;
  if (
    input.customerId !== undefined &&
    (typeof input.customerId !== "string" ||
      input.customerId.trim().length === 0 ||
      input.customerId.length > 200)
  ) {
    throw new TypeError("Offline customer id is invalid.");
  }
  if (
    input.amountPaidMinor !== undefined &&
    (!Number.isSafeInteger(input.amountPaidMinor) || Number(input.amountPaidMinor) < 0)
  ) {
    throw new TypeError("Offline amount paid is invalid.");
  }
  return {
    cashReceivedMinor: Number.isSafeInteger(input.cashReceivedMinor)
      ? Number(input.cashReceivedMinor)
      : 0,
    ...(tenders ? { tenders } : {}),
    ...(input.customerId !== undefined ? { customerId: input.customerId as string } : {}),
    ...(input.amountPaidMinor !== undefined
      ? { amountPaidMinor: Number(input.amountPaidMinor) }
      : {}),
    ...(input.voucher !== undefined ? { voucher: parseVoucherInput(input.voucher) } : {}),
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

export function parseOfflineCustomerPaymentInput(value: unknown): OfflineCustomerPaymentInput {
  if (!value || typeof value !== "object") {
    throw new TypeError("Offline payment input is invalid.");
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.amountMinor) || Number(input.amountMinor) <= 0) {
    throw new TypeError("Offline payment amount is invalid.");
  }
  return {
    customerId: requireString(input.customerId, "customerId"),
    amountMinor: Number(input.amountMinor),
  };
}

export function parseOfflineAttendanceEventInput(value: unknown): OfflineAttendanceEventInput {
  if (!value || typeof value !== "object") {
    throw new TypeError("Offline attendance input is invalid.");
  }
  const input = value as Record<string, unknown>;
  if (input.eventType !== "clock_in" && input.eventType !== "clock_out") {
    throw new TypeError("Offline attendance event type is invalid.");
  }
  return {
    eventType: input.eventType,
    ...(input.membershipId === undefined
      ? {}
      : { membershipId: requireString(input.membershipId, "membershipId") }),
  };
}

export function parsePrepareReturnGrantInput(value: unknown): PrepareReturnGrantInput {
  if (!value || typeof value !== "object") {
    throw new TypeError("Offline return grant input is invalid.");
  }
  const input = value as Record<string, unknown>;
  return {
    tenantId: requireString(input.tenantId, "tenantId"),
    accessToken: requireString(input.accessToken, "accessToken", 16_384),
    orderId: requireString(input.orderId, "orderId"),
  };
}

export function parseOfflineReturnInput(value: unknown): OfflineReturnInput {
  if (!value || typeof value !== "object") throw new TypeError("Offline return input is invalid.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new TypeError("Offline return lines are invalid.");
  }
  return {
    returnGrantId: requireString(input.returnGrantId, "returnGrantId"),
    ...(input.approver !== undefined ? { approver: parseApprover(input.approver) } : {}),
    lines: input.lines.map((raw) => {
      if (!raw || typeof raw !== "object") throw new TypeError("Offline return line is invalid.");
      const line = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0) {
        throw new TypeError("Offline return quantity is invalid.");
      }
      if (line.disposition !== "restock" && line.disposition !== "non_restock") {
        throw new TypeError("Offline return disposition is invalid.");
      }
      return {
        orderLineId: requireString(line.orderLineId, "orderLineId"),
        quantity: Number(line.quantity),
        reason: requireString(line.reason, "reason", 500),
        disposition: line.disposition,
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

export function parseOfflineStaffPinInput(value: unknown): OfflineStaffPinInput {
  if (!value || typeof value !== "object") {
    throw new TypeError("Offline staff PIN input is invalid.");
  }
  const input = value as Record<string, unknown>;
  // ADR-043 §6: digits only, min 4, no product maximum; only the credential transport ceiling applies.
  if (!isTransportablePosPin(input.pin)) {
    throw new TypeError("PIN is invalid.");
  }
  return {
    username: requireString(input.username, "username"),
    pin: input.pin,
  };
}

const INTENT_OPERATIONS = new Set<string>(OFFLINE_INTENT_OPERATIONS);
const REVIEW_LANES = new Set<string>(["sale", "payment", "attendance", "return", "intent"]);
const REVIEW_STATUSES = new Set<string>([
  "all",
  "attention",
  "queued",
  "syncing",
  "retry_wait",
  "blocked",
  "server_received",
  "accepted",
  "needs_review",
]);
const RESOLUTION_KINDS = new Set<string>([
  "investigate",
  "confirm_physical_evidence",
  "void_request",
  "other",
]);

function optionalString(value: unknown, field: string, maximumLength = 200): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, maximumLength);
}

/**
 * Structural guard only (bounded JSON object of primitives/arrays/objects). The operation-specific
 * schema is enforced in main by the SDK canonicalizer before anything is signed or stored.
 */
function parseIntentPayload(value: unknown): OfflineIntentPayloadObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Offline intent payload is invalid.");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) throw new TypeError("Offline intent payload is too large.");
  return JSON.parse(serialized) as OfflineIntentPayloadObject;
}

export function parseOfflineIntentInput(value: unknown): OfflineIntentInput {
  if (!value || typeof value !== "object") throw new TypeError("Offline intent input is invalid.");
  const input = value as Record<string, unknown>;
  if (typeof input.operation !== "string" || !INTENT_OPERATIONS.has(input.operation)) {
    throw new TypeError("Offline intent operation is invalid.");
  }
  return {
    operation: input.operation as OfflineIntentInput["operation"],
    subjectId: optionalString(input.subjectId, "subjectId"),
    baseVersion: optionalString(input.baseVersion, "baseVersion"),
    dependsOnSyncCommandId: optionalString(input.dependsOnSyncCommandId, "dependsOnSyncCommandId"),
    payload: parseIntentPayload(input.payload),
  };
}

function parseReviewLane(value: unknown): ReviewLane {
  if (typeof value !== "string" || !REVIEW_LANES.has(value)) {
    throw new TypeError("Review lane is invalid.");
  }
  return value as ReviewLane;
}

export function parseReviewQuery(value: unknown): ReviewQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("Review query is invalid.");
  const input = value as Record<string, unknown>;
  const lane =
    input.lane === undefined || input.lane === "all" ? "all" : parseReviewLane(input.lane);
  if (
    input.status !== undefined &&
    (typeof input.status !== "string" || !REVIEW_STATUSES.has(input.status))
  ) {
    throw new TypeError("Review status filter is invalid.");
  }
  if (
    input.search !== undefined &&
    (typeof input.search !== "string" || input.search.length > 100)
  ) {
    throw new TypeError("Review search is invalid.");
  }
  return {
    lane,
    status: (input.status as ReviewQuery["status"]) ?? "all",
    search: (input.search as string | undefined) ?? "",
  };
}

export function parseReviewRetryInput(value: unknown): ReviewRetryInput {
  if (!value || typeof value !== "object") throw new TypeError("Review action is invalid.");
  const input = value as Record<string, unknown>;
  return {
    actionId: requireString(input.actionId, "actionId", 100),
    lane: parseReviewLane(input.lane),
    syncCommandId: requireString(input.syncCommandId, "syncCommandId", 100),
  };
}

export function parseReviewResolutionInput(value: unknown): ReviewResolutionInput {
  const base = parseReviewRetryInput(value);
  const input = value as Record<string, unknown>;
  if (typeof input.requestKind !== "string" || !RESOLUTION_KINDS.has(input.requestKind)) {
    throw new TypeError("Resolution kind is invalid.");
  }
  return {
    ...base,
    requestKind: input.requestKind as ReviewResolutionInput["requestKind"],
    note: requireString(input.note, "note", 1000),
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
  handle(OFFLINE_IPC_CHANNELS.customers, () => runtime.getOfflineCustomers());
  handle(OFFLINE_IPC_CHANNELS.recordPayment, (_event, input: unknown) =>
    runtime.recordCustomerPayment(parseOfflineCustomerPaymentInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.acceptCash, (_event, input: unknown) =>
    runtime.acceptCashSale(parseOfflineSaleInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.previewVoucher, (_event, input: unknown) => {
    const parsed = parseOfflineSaleInput({ ...(input as object), cashReceivedMinor: 0 });
    const code = (input as { code?: unknown }).code;
    if (typeof code !== "string" || code.trim() === "" || code.length > 64) {
      throw new TypeError("Voucher code is invalid.");
    }
    return runtime.previewOfflineVoucher({ lines: parsed.lines, code });
  });
  handle(OFFLINE_IPC_CHANNELS.addCustomer, (_event, input: unknown) => {
    const value = (input ?? {}) as { name?: unknown; phone?: unknown };
    if (typeof value.name !== "string" || typeof value.phone !== "string") {
      throw new TypeError("Customer input is invalid.");
    }
    return runtime.addOfflineCustomer({
      name: value.name.slice(0, 200),
      phone: value.phone.slice(0, 32),
    });
  });
  handle(OFFLINE_IPC_CHANNELS.receipt, (_event, localSaleId: unknown) =>
    runtime.getLocalReceipt(requireString(localSaleId, "localSaleId")),
  );
  handle(OFFLINE_IPC_CHANNELS.unacknowledged, () => runtime.getUnacknowledgedSales());
  handle(OFFLINE_IPC_CHANNELS.acknowledge, (_event, localSaleId: unknown) =>
    runtime.acknowledgeSale(requireString(localSaleId, "localSaleId")),
  );
  handle(OFFLINE_IPC_CHANNELS.recordAttendance, (_event, input: unknown) =>
    runtime.recordAttendanceEvent(parseOfflineAttendanceEventInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.localAttendance, (_event, membershipId: unknown) =>
    runtime.getLocalAttendance(
      membershipId === undefined ? undefined : requireString(membershipId, "membershipId"),
    ),
  );
  handle(OFFLINE_IPC_CHANNELS.prepareReturnGrant, (_event, input: unknown) =>
    runtime.prepareReturnGrant(parsePrepareReturnGrantInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.returnGrants, () => runtime.getReturnGrants());
  handle(OFFLINE_IPC_CHANNELS.recordReturn, (_event, input: unknown) =>
    runtime.recordReturn(parseOfflineReturnInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.localReturns, () => runtime.getLocalReturns());
  handle(OFFLINE_IPC_CHANNELS.pendingSummary, () => runtime.getPendingSyncSummary());
  handle(OFFLINE_IPC_CHANNELS.localReport, () => runtime.getLocalReport());
  handle(OFFLINE_IPC_CHANNELS.syncStatus, () => runtime.getSyncStatus());
  handle(OFFLINE_IPC_CHANNELS.requestSync, () => runtime.requestSync());
  handle(OFFLINE_IPC_CHANNELS.bootstrap, (_event, input: unknown) =>
    runtime.bootstrap(parseOfflineBootstrapInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.verifyPin, (_event, input: unknown) =>
    runtime.verifyStaffPin(parseOfflineStaffPinInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.endStaffSession, () => runtime.endStaffSession());
  handle(OFFLINE_IPC_CHANNELS.recordIntent, (_event, input: unknown) =>
    runtime.recordIntent(parseOfflineIntentInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.localIntents, () => runtime.getLocalIntents());
  handle(OFFLINE_IPC_CHANNELS.reviewItems, (_event, query: unknown) =>
    runtime.getReviewItems(parseReviewQuery(query)),
  );
  handle(OFFLINE_IPC_CHANNELS.reviewRetry, (_event, input: unknown) =>
    runtime.reviewRetry(parseReviewRetryInput(input)),
  );
  handle(OFFLINE_IPC_CHANNELS.reviewResolution, (_event, input: unknown) =>
    runtime.reviewRequestResolution(parseReviewResolutionInput(input)),
  );
}
