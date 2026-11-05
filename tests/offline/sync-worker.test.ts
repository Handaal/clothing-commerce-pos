import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import {
  OfflineSyncWorker,
  SdkOfflineDeliveryClient,
  readExactPersistedRequest,
  type OfflineDeliveryClient,
} from "../../src/main/offline/sync-worker";
import { bootstrapFixture, ingestionResponse, makeHarness, type OfflineHarness } from "./fixtures";

const { ApiHttpError, ApiNetworkError } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as {
  ApiHttpError: new (
    message: string,
    status: number,
    code: string,
    requestId: string | null,
  ) => Error;
  ApiNetworkError: new (message: string) => Error;
};

// None of these tests wire a paymentOutbox into the worker, so the payment lane is never drained
// and deliverPayment is never invoked. A throwing stub satisfies the interface and fails loudly if
// that assumption ever regresses.
const unexpectedPayment: OfflineDeliveryClient["deliverPayment"] = async () => {
  throw new Error("deliverPayment was not expected in this test");
};

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function acceptOne(harness: OfflineHarness) {
  return harness.sales.acceptCashSale({
    lines: [{ variantId: "10000000-0000-4000-8000-000000000012", quantity: 1 }],
    cashReceivedMinor: 3_000,
  });
}

describe("offline synchronization worker", () => {
  it("passes the persisted JSON unchanged through the SDK with the stable idempotency key", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = acceptOne(harness);
    const item = harness.outbox.claimNext(30_000)!;
    let sentBody = "";
    let sentHeaders = new Headers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
        sentBody = String(init?.body);
        sentHeaders = new Headers(init?.headers);
        return Response.json(ingestionResponse(accepted.localSaleId));
      }),
    );
    const response = await new SdkOfflineDeliveryClient("https://commerce.example.test").deliver(
      item,
    );
    expect(response.ingestionId).toBe("20000000-0000-4000-8000-000000000003");
    expect(sentBody).toBe(item.requestJson);
    expect(sentHeaders.get("Idempotency-Key")).toBe(item.syncCommandId);
    expect(sentHeaders.get("X-Tenant-Id")).toBe(item.tenantId);
    expect(sentHeaders.get("Authorization")).toBeNull();
  });

  it("delivers the exact persisted request and atomically records a synced result", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = acceptOne(harness);
    const deliver = vi.fn<OfflineDeliveryClient["deliver"]>(async (item) => {
      const request = readExactPersistedRequest(item);
      expect(request.command.syncCommandId).toBe(accepted.syncCommandId);
      expect(request.signature.credentialId).toBe(item.credentialId);
      return ingestionResponse(accepted.localSaleId);
    });
    const worker = new OfflineSyncWorker(harness.outbox, { deliver, deliverPayment: unexpectedPayment });
    await worker.runOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(harness.outbox.getStatusCounts()).toMatchObject({ pending: 0, synced: 1 });
    expect(
      harness.database.connection
        .prepare(
          `SELECT lifecycle, server_order_id, server_payment_id, server_fulfillment_id,
            server_reconciliation_id FROM local_sale`,
        )
        .get(),
    ).toEqual({
      lifecycle: "synced",
      server_order_id: "20000000-0000-4000-8000-000000000001",
      server_payment_id: "20000000-0000-4000-8000-000000000002",
      server_fulfillment_id: "20000000-0000-4000-8000-000000000005",
      server_reconciliation_id: null,
    });
  });

  it("retries transient failures and blocks permanent authority failures", async () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const transient = makeHarness({ now: () => current });
    harnesses.push(transient);
    acceptOne(transient);
    const transientWorker = new OfflineSyncWorker(
      transient.outbox,
      { deliver: async () => Promise.reject(new ApiNetworkError("offline")), deliverPayment: unexpectedPayment },
      { now: () => current },
    );
    await transientWorker.runOnce();
    expect(transient.outbox.getStatusCounts()).toMatchObject({ retryWait: 1, blocked: 0 });
    current = new Date("2026-09-08T12:00:05.000Z");

    const permanent = makeHarness();
    harnesses.push(permanent);
    acceptOne(permanent);
    const permanentWorker = new OfflineSyncWorker(permanent.outbox, {
      deliver: async () =>
        Promise.reject(
          new ApiHttpError("signature invalid", 401, "OFFLINE_SIGNATURE_INVALID", null),
        ),
      deliverPayment: unexpectedPayment,
    });
    await permanentWorker.runOnce();
    expect(permanent.outbox.getStatusCounts()).toMatchObject({ retryWait: 0, blocked: 1 });
  });

  it("does not claim pending work while the network is unavailable", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    acceptOne(harness);
    const deliver = vi.fn<OfflineDeliveryClient["deliver"]>();
    const worker = new OfflineSyncWorker(
      harness.outbox,
      { deliver, deliverPayment: unexpectedPayment },
      { networkOnline: () => false },
    );
    await worker.runOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(harness.outbox.getStatusCounts()).toMatchObject({ pending: 1, leased: 0 });
  });

  it("replays the same command after a crash following server commit without duplicating", async () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => current });
    harnesses.push(harness);
    const accepted = acceptOne(harness);
    const serverResults = new Map<string, ReturnType<typeof ingestionResponse>>();
    let canonicalCreates = 0;
    const uploaded: Array<{ idempotencyKey: string; requestJson: string }> = [];
    const delivery: OfflineDeliveryClient = {
      async deliver(item) {
        uploaded.push({ idempotencyKey: item.idempotencyKey, requestJson: item.requestJson });
        let response = serverResults.get(item.idempotencyKey);
        if (!response) {
          response = ingestionResponse(accepted.localSaleId);
          serverResults.set(item.idempotencyKey, response);
          canonicalCreates += 1;
        }
        return response;
      },
      deliverPayment: unexpectedPayment,
    };
    const crashing = new OfflineSyncWorker(harness.outbox, delivery, {
      now: () => current,
      testSeam: {
        afterServerCommit() {
          throw new Error("simulated process crash before local acknowledgement");
        },
      },
    });
    await expect(crashing.runOnce()).rejects.toThrow("simulated process crash");
    expect(harness.outbox.getStatusCounts()).toMatchObject({ leased: 1, synced: 0 });

    current = new Date("2026-09-08T12:00:30.001Z");
    const databasePath = harness.database.path;
    harness.database.close();
    const reopened = new LocalDatabase(databasePath, { now: () => current });
    const recovered = new OutboxStore(reopened, () => current);
    expect(recovered.recoverExpiredLeases()).toBe(1);
    const restarted = new OfflineSyncWorker(recovered, delivery, { now: () => current });
    await restarted.runOnce();

    expect(uploaded).toHaveLength(2);
    expect(uploaded[1]).toEqual(uploaded[0]);
    expect(canonicalCreates).toBe(1);
    expect(recovered.getStatusCounts()).toMatchObject({ synced: 1, pending: 0, leased: 0 });
    reopened.close();
  });

  it("recovers a crash lease that expires after a fast restart", async () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => current });
    harnesses.push(harness);
    const accepted = acceptOne(harness);
    const claimed = harness.outbox.claimNext(30_000)!;
    expect(claimed.syncCommandId).toBe(accepted.syncCommandId);

    const deliver = vi.fn<OfflineDeliveryClient["deliver"]>(async () =>
      ingestionResponse(accepted.localSaleId),
    );
    const restarted = new OfflineSyncWorker(harness.outbox, { deliver, deliverPayment: unexpectedPayment }, { now: () => current });
    await restarted.runOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(harness.outbox.getStatusCounts()).toMatchObject({ leased: 1, synced: 0 });

    current = new Date("2026-09-08T12:00:30.001Z");
    await restarted.runOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(harness.outbox.getStatusCounts()).toMatchObject({ leased: 0, synced: 1 });
  });

  it("records reconciliation and only releases synced projections after a newer snapshot", async () => {
    const synced = makeHarness();
    harnesses.push(synced);
    const accepted = acceptOne(synced);
    const syncedWorker = new OfflineSyncWorker(synced.outbox, {
      deliver: async () => ingestionResponse(accepted.localSaleId),
      deliverPayment: unexpectedPayment,
    });
    await syncedWorker.runOnce();
    expect(synced.sales.getProjectedInventory()[0].pendingQuantity).toBe(1);
    const released = synced.authority.installBootstrap(
      bootstrapFixture({
        grantId: "30000000-0000-4000-8000-000000000001",
        snapshotId: "30000000-0000-4000-8000-000000000002",
        issuedAt: "2026-09-08T12:01:00.000Z",
        operatorExpiresAt: "2026-09-08T20:00:00.000Z",
        catalogValidUntil: "2026-09-08T20:00:00.000Z",
        acceptedUntil: "2026-09-08T20:00:00.000Z",
      }),
      "2026-09-08T12:01:00.000Z",
    );
    expect(released).toBe(1);
    expect(synced.sales.getProjectedInventory()[0].pendingQuantity).toBe(0);

    const governed = makeHarness();
    harnesses.push(governed);
    const governedSale = acceptOne(governed);
    const governedWorker = new OfflineSyncWorker(governed.outbox, {
      deliver: async () => ingestionResponse(governedSale.localSaleId, "needs_reconciliation"),
      deliverPayment: unexpectedPayment,
    });
    await governedWorker.runOnce();
    expect(governed.outbox.getStatusCounts()).toMatchObject({ needsReconciliation: 1 });
    expect(
      governed.database.connection
        .prepare(
          `SELECT lifecycle, server_payment_id, server_fulfillment_id,
            server_reconciliation_id, reconciliation_reason FROM local_sale`,
        )
        .get(),
    ).toEqual({
      lifecycle: "needs_reconciliation",
      server_payment_id: "20000000-0000-4000-8000-000000000002",
      server_fulfillment_id: null,
      server_reconciliation_id: "20000000-0000-4000-8000-000000000008",
      reconciliation_reason: "insufficient_stock_at_ingestion",
    });
    expect(governed.sales.getProjectedInventory()[0].pendingQuantity).toBe(1);
  });
});
