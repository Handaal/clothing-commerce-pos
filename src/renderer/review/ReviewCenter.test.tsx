// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfflineBridge, ReviewItem } from "../../shared/offline";
import { buildDeskIntent, OfflineIntentPanel } from "../offline/OfflineIntentPanel";
import { I18nProvider } from "../shell/i18n";
import { ReviewCenter } from "./ReviewCenter";

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}
afterEach(cleanup);

const blocked: ReviewItem = {
  lane: "intent",
  syncCommandId: "cmd-1",
  localId: "local-1",
  label: "inventory.receive",
  status: "blocked",
  attempts: 2,
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:01:00.000Z",
  serverIngestionId: null,
  serverReceivedAt: null,
  lastErrorCode: "OFFLINE_INTENT_DISABLED",
  lastErrorMessage: "This offline operation is not enabled for this register.",
  payloadHash: "a".repeat(64),
  evidence: [{ key: "subjectId", value: "variant-1" }],
  allowedActions: ["retry"],
  actions: [],
};
const accepted: ReviewItem = {
  ...blocked,
  syncCommandId: "cmd-2",
  lane: "sale",
  label: "R-0001",
  status: "accepted",
  lastErrorCode: null,
  lastErrorMessage: null,
  serverIngestionId: "srv-2",
  allowedActions: [],
};
const conflicted: ReviewItem = {
  ...blocked,
  syncCommandId: "cmd-3",
  label: "inventory.count",
  status: "needs_review",
  lastErrorCode: null,
  lastErrorMessage: null,
  serverIngestionId: "srv-3",
  evidence: [{ key: "serverOutcome", value: "OIX_STALE_BASE" }],
  allowedActions: [],
};
const policyBlocked: ReviewItem = {
  ...conflicted,
  syncCommandId: "cmd-4",
  label: "inventory.adjust",
  status: "policy_blocked",
  evidence: [{ key: "serverOutcome", value: "OIP_POLICY_NOT_CONFIGURED" }],
};

function bridge(overrides: Partial<OfflineBridge> = {}): OfflineBridge {
  return {
    getReviewItems: vi.fn(async () => [blocked, accepted, conflicted, policyBlocked]),
    reviewRetry: vi.fn(async (input) => ({
      actionId: input.actionId,
      outcome: "requeued" as const,
      detail: null,
      relatedSyncCommandId: null,
    })),
    reviewRequestResolution: vi.fn(async (input) => ({
      actionId: input.actionId,
      outcome: "requested" as const,
      detail: null,
      relatedSyncCommandId: "cmd-9",
    })),
    ...overrides,
  } as unknown as OfflineBridge;
}

describe("ReviewCenter", () => {
  it("lists local commands with honest status labels and starts on the attention filter", async () => {
    const offline = bridge();
    render(<ReviewCenter bridge={offline} />);
    expect(await screen.findByText("Goods received")).toBeTruthy();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Refused by server")).toBeTruthy();
    expect(table.getByText("Applied by server")).toBeTruthy();
    expect(table.getByText("Needs reconciliation")).toBeTruthy();
    expect(table.getByText("Blocked: no approved policy")).toBeTruthy();
    expect(offline.getReviewItems).toHaveBeenCalledWith({
      lane: "all",
      status: "attention",
      search: "",
    });
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("shows evidence, local vs server ids, and offers only the allowed actions", async () => {
    render(<ReviewCenter bridge={bridge()} />);
    fireEvent.click(await screen.findByText("Goods received"));
    expect(screen.getByText(/kept exactly as saved/)).toBeTruthy();
    expect(screen.getByText("local-1")).toBeTruthy();
    expect(screen.getAllByText("Not yet").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Retry unchanged" })).toBeTruthy();

    fireEvent.click(screen.getByText("R-0001"));
    expect(screen.queryByRole("button", { name: "Retry unchanged" })).toBeNull();
    expect(screen.getByText("No action is needed or allowed here.")).toBeTruthy();
  });

  it("reuses the same action id when a retry click fails, so the action is never duplicated", async () => {
    const reviewRetry = vi.fn().mockRejectedValueOnce(new Error("ipc")).mockResolvedValueOnce({
      actionId: "x",
      outcome: "requeued",
      detail: null,
      relatedSyncCommandId: null,
    });
    render(<ReviewCenter bridge={bridge({ reviewRetry })} />);
    fireEvent.click(await screen.findByText("Goods received"));
    fireEvent.click(screen.getByRole("button", { name: "Retry unchanged" }));
    await screen.findByText(/will not be duplicated/);
    fireEvent.click(screen.getByRole("button", { name: "Retry unchanged" }));
    await screen.findByText("Queued again, unchanged");
    const [first, second] = reviewRetry.mock.calls.map((call) => call[0].actionId);
    expect(first).toBe(second);
  });

  it("is an operator reconciliation view, not an approval desk: no manager request, no override of a server decision", async () => {
    const offline = bridge();
    render(<ReviewCenter bridge={offline} />);
    fireEvent.click(await screen.findByText("Stock count"));
    expect(screen.getByText(/found a conflict with current data/)).toBeTruthy();
    expect(screen.getByText("OIX_STALE_BASE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry unchanged" })).toBeNull();
    expect(screen.queryByText(/manager/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approv|manager|resolution|request/i })).toBeNull();
    fireEvent.click(screen.getByText("Stock adjustment"));
    expect(screen.getByText(/No approved rule exists/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry unchanged" })).toBeNull();
    await waitFor(() => expect(offline.reviewRequestResolution).not.toHaveBeenCalled());
  });
});

describe("OfflineIntentPanel", () => {
  const catalog = [
    {
      productId: "p",
      productName: "Foundation Tee",
      brandId: "b",
      brandName: null,
      categories: [],
      variantId: "variant-1",
      sku: "TEE-M",
      optionSummary: null,
      currency: "USD",
      unitPriceMinor: 1000,
      priceId: "price",
      priceVersion: "v",
    },
  ];
  function intentBridge(enabled: string[]) {
    return {
      getLocalIntents: vi.fn(async () => ({ enabledOperations: enabled, pending: 0, recent: [] })),
      getReadiness: vi.fn(async () => ({ ready: true, deviceId: "device-1" })),
      getCachedCatalog: vi.fn(async () => catalog),
      getProjectedInventory: vi.fn(async () => [
        {
          variantId: "variant-1",
          sku: "TEE-M",
          snapshotOnHand: 5,
          pendingQuantity: 0,
          projectedAvailable: 5,
          version: 7,
          asOf: "2026-09-08T10:00:00.000Z",
          advisory: true,
        },
      ]),
      recordIntent: vi.fn(async () => ({})),
    } as unknown as OfflineBridge;
  }

  it("says honestly when the register has not enabled any offline request", async () => {
    render(<OfflineIntentPanel operations={["inventory.receive"]} bridge={intentBridge([])} />);
    expect(
      await screen.findByText("Offline requests are not enabled for this register."),
    ).toBeTruthy();
    expect(screen.getByText(/records a signed request/)).toBeTruthy();
  });

  it("records an offline goods receive as a provisional request (never a stock change)", async () => {
    const offline = intentBridge(["inventory.receive", "settings.change_request"]);
    render(
      <OfflineIntentPanel
        operations={["inventory.receive", "inventory.adjust"]}
        bridge={offline}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Goods received" }));
    // inventory.adjust is not enabled server-side, so it is not offered.
    expect(screen.queryByRole("button", { name: "Stock adjustment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Item" }));
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Foundation Tee/ }));
    fireEvent.change(screen.getByLabelText("Quantity received"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save request" }));
    await screen.findByText(/server will decide automatically/);
    expect(offline.recordIntent).toHaveBeenCalledWith({
      operation: "inventory.receive",
      subjectId: "variant-1",
      baseVersion: null,
      dependsOnSyncCommandId: null,
      payload: { variantId: "variant-1", quantity: 3, supplierDocumentRef: null, note: null },
    });
  });

  it("builds exact schema payloads and refuses incomplete forms", () => {
    const empty = {
      variantId: "v",
      quantity: "",
      reference: "",
      reason: "",
      note: "",
      settingKey: "",
      requestedValue: "",
    };
    const advisory = {
      variantId: "v",
      sku: "s",
      snapshotOnHand: 5,
      pendingQuantity: 0,
      projectedAvailable: 5,
      version: 7,
      asOf: "x",
      advisory: true as const,
    };
    expect(buildDeskIntent("inventory.receive", empty, { deviceId: null, advisory })).toBeNull();
    expect(
      buildDeskIntent(
        "inventory.adjust",
        { ...empty, quantity: "0", reason: "lost" },
        {
          deviceId: null,
          advisory,
        },
      ),
    ).toBeNull();
    expect(
      buildDeskIntent("inventory.count", { ...empty, quantity: "4" }, { deviceId: null, advisory }),
    ).toMatchObject({
      baseVersion: "7",
      payload: { countedQuantity: 4, observedAdvisoryQuantity: 5 },
    });
    expect(
      buildDeskIntent(
        "settings.device_revoke_request",
        { ...empty, reason: "Stolen" },
        {
          deviceId: "device-1",
          advisory: undefined,
        },
      ),
    ).toMatchObject({ subjectId: "device-1", payload: { targetDeviceId: "device-1" } });
    expect(
      buildDeskIntent(
        "settings.change_request",
        { ...empty, settingKey: "Bad Key", reason: "x" },
        {
          deviceId: null,
          advisory: undefined,
        },
      ),
    ).toBeNull();
  });
});
