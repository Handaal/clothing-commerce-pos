import { afterEach, describe, expect, it } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { DeviceKeyStore } from "../../src/main/offline/device-key";
import { OfflineSaleService } from "../../src/main/offline/offline-service";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { ids, makeHarness, TestSecureStorage, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("durable outbox mechanics and restart recovery", () => {
  it("claims once, increments attempts, retries, and marks delivered", () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => current });
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    expect(harness.outbox.listDue()).toHaveLength(1);
    const claim = harness.outbox.claimNext(30_000);
    expect(claim).toMatchObject({
      syncCommandId: accepted.syncCommandId,
      idempotencyKey: accepted.syncCommandId,
      attempts: 1,
    });
    expect(harness.outbox.claimNext(30_000)).toBeNull();
    harness.outbox.releaseForRetry(
      accepted.syncCommandId,
      claim!.leaseId,
      "2026-09-08T12:01:00.000Z",
      { code: "NETWORK", message: "bounded diagnostic" },
    );
    expect(harness.outbox.listDue()).toHaveLength(0);
    current = new Date("2026-09-08T12:01:00.000Z");
    const retry = harness.outbox.claimNext(30_000);
    expect(retry).toMatchObject({ attempts: 2, payloadHash: claim!.payloadHash });
    harness.outbox.markDelivered(accepted.syncCommandId, retry!.leaseId, "server-ingestion-id");
    expect(harness.outbox.listDue()).toHaveLength(0);
    expect(
      harness.database.connection
        .prepare("SELECT state, server_ingestion_id FROM outbox WHERE sync_command_id = ?")
        .get(accepted.syncCommandId),
    ).toEqual({ state: "delivered", server_ingestion_id: "server-ingestion-id" });
  });

  it("marks leased work blocked with bounded diagnostics", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const claim = harness.outbox.claimNext(30_000)!;
    harness.outbox.markBlocked(accepted.syncCommandId, claim.leaseId, {
      code: "X".repeat(200),
      message: "Y".repeat(1_000),
    });
    expect(
      harness.database.connection
        .prepare(
          `SELECT state, length(last_error_code) AS code_length,
            length(last_error_message) AS message_length FROM outbox`,
        )
        .get(),
    ).toEqual({ state: "blocked", code_length: 100, message_length: 500 });
  });

  it("survives close/reopen with the same receipt, signed payload hash, and projection", () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => current });
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 2 }],
      cashReceivedMinor: 6_000,
    });
    const before = harness.database.connection
      .prepare(
        `SELECT payload_hash, canonical_command, request_json
         FROM outbox WHERE sync_command_id = ?`,
      )
      .get(accepted.syncCommandId);
    const databasePath = harness.database.path;
    harness.database.close();

    const reopened = new LocalDatabase(databasePath, { now: () => current });
    const keys = new DeviceKeyStore(harness.directory, new TestSecureStorage());
    const sales = new OfflineSaleService(reopened, keys, () => current);
    const outbox = new OutboxStore(reopened, () => current);
    expect(sales.getLocalReceipt(accepted.localSaleId)).toMatchObject({
      localSaleId: accepted.localSaleId,
      localReceiptId: accepted.localReceiptId,
      totalMinor: 5_198,
      cashReceivedMinor: 6_000,
      changeMinor: 802,
    });
    expect(sales.getProjectedInventory()[0]).toMatchObject({
      pendingQuantity: 2,
      projectedAvailable: 8,
    });
    expect(
      reopened.connection
        .prepare(
          `SELECT payload_hash, canonical_command, request_json
           FROM outbox WHERE sync_command_id = ?`,
        )
        .get(accepted.syncCommandId),
    ).toEqual(before);

    const claim = outbox.claimNext(1_000)!;
    current = new Date("2026-09-08T12:00:01.001Z");
    reopened.close();
    const afterCrash = new LocalDatabase(databasePath, { now: () => current });
    const recovered = new OutboxStore(afterCrash, () => current);
    expect(recovered.recoverExpiredLeases()).toBe(1);
    expect(recovered.claimNext(1_000)).toMatchObject({
      syncCommandId: claim.syncCommandId,
      payloadHash: claim.payloadHash,
      attempts: 2,
    });
    afterCrash.close();
  });

  it("uses a write lock so a claimed command cannot be claimed by another connection", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const secondDatabase = new LocalDatabase(harness.database.path, {
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });
    const second = new OutboxStore(secondDatabase, () => new Date("2026-09-08T12:00:00.000Z"));
    expect(harness.outbox.claimNext(30_000)).not.toBeNull();
    expect(second.claimNext(30_000)).toBeNull();
    secondDatabase.close();
  });
});
