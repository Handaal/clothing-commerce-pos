import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_SEVERITIES,
  type ActivityCategory,
  type ActivityEventInput,
  type ActivityListQuery,
  type ActivitySeverity,
} from "../../shared/activity";
import { isAllowedRendererNavigation } from "../renderer-origin";
import type { ActivityStore } from "./store";

// Fixed allowlist, kept separate from the offline channels so each capability surface stays minimal.
export const ACTIVITY_IPC_CHANNELS = Object.freeze({
  append: "activity:append",
  list: "activity:list",
});

const CATEGORY_SET = new Set<string>(ACTIVITY_CATEGORIES);
const SEVERITY_SET = new Set<string>(ACTIVITY_SEVERITIES);

function assertTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!event.senderFrame || !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)) {
    throw new Error("Activity IPC rejected an untrusted renderer origin.");
  }
}

function optionalText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${field} is invalid.`);
  return value.length > maximumLength ? value.slice(0, maximumLength) : value;
}

function requiredText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value.length > maximumLength ? value.slice(0, maximumLength) : value;
}

export function parseActivityEventInput(value: unknown): ActivityEventInput {
  if (!value || typeof value !== "object") throw new TypeError("Activity event is invalid.");
  const input = value as Record<string, unknown>;
  const category = requiredText(input.category, "category", 40);
  if (!CATEGORY_SET.has(category)) throw new TypeError("Activity category is invalid.");
  const severity = requiredText(input.severity, "severity", 20);
  if (!SEVERITY_SET.has(severity)) throw new TypeError("Activity severity is invalid.");
  let details: Record<string, unknown> | null = null;
  if (input.details !== null && input.details !== undefined) {
    if (typeof input.details !== "object" || Array.isArray(input.details)) {
      throw new TypeError("Activity details are invalid.");
    }
    // Bound the stored blob so a runaway payload cannot bloat the ledger.
    const serialized = JSON.stringify(input.details);
    details =
      serialized.length > 4_000 ? { truncated: true } : (input.details as Record<string, unknown>);
  }
  return {
    occurredAt: requiredText(input.occurredAt, "occurredAt", 40),
    actorId: optionalText(input.actorId, "actorId", 200),
    actorName: optionalText(input.actorName, "actorName", 200),
    tenantId: optionalText(input.tenantId, "tenantId", 200),
    section: optionalText(input.section, "section", 60),
    category: category as ActivityCategory,
    action: requiredText(input.action, "action", 80),
    description: requiredText(input.description, "description", 2_000),
    severity: severity as ActivitySeverity,
    details,
  };
}

export function parseActivityListQuery(value: unknown): ActivityListQuery {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") throw new TypeError("Activity query is invalid.");
  const query = value as Record<string, unknown>;
  const result: {
    from?: string;
    to?: string;
    severity?: ActivitySeverity;
    category?: ActivityCategory;
    search?: string;
    limit?: number;
  } = {};
  const from = optionalText(query.from, "from", 40);
  if (from) result.from = from;
  const to = optionalText(query.to, "to", 40);
  if (to) result.to = to;
  const severity = optionalText(query.severity, "severity", 20);
  if (severity) {
    if (!SEVERITY_SET.has(severity)) throw new TypeError("Activity severity is invalid.");
    result.severity = severity as ActivitySeverity;
  }
  const category = optionalText(query.category, "category", 40);
  if (category) {
    if (!CATEGORY_SET.has(category)) throw new TypeError("Activity category is invalid.");
    result.category = category as ActivityCategory;
  }
  const search = optionalText(query.search, "search", 200);
  if (search) result.search = search;
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit)) throw new TypeError("Activity limit is invalid.");
    result.limit = Number(query.limit);
  }
  return result;
}

export function registerActivityIpc(
  resolve: () => ActivityStore | undefined,
  rendererUrl: string,
): void {
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.append, (event, input: unknown) => {
    assertTrustedSender(event, rendererUrl);
    const store = resolve();
    // Activity is best-effort: if local persistence is unavailable, silently drop the line rather
    // than surfacing an error into the cashier flow.
    if (!store) return;
    store.append(parseActivityEventInput(input));
  });
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.list, (event, query: unknown) => {
    assertTrustedSender(event, rendererUrl);
    const store = resolve();
    if (!store) return { items: [] };
    return { items: store.list(parseActivityListQuery(query)) };
  });
}
