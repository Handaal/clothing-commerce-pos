import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import type { OfflineSaleWriteStage } from "../../src/main/offline/offline-service";
import { ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("atomic immutable local cash sale", () => {
  it("persists trusted line, tender, receipt, and exact signed command facts", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 2 }],
      cashReceivedMinor: 6_000,
    });
    expect(accepted).toMatchObject({
      lifecycle: "accepted_pending_sync",
      totalMinor: 5_198,
      cashReceivedMinor: 6_000,
      changeMinor: 802,
    });
    expect(accepted.localReceiptId).toMatch(/^[A-F0-9]{4}-000001$/);
    expect(accepted.localSaleId).toMatch(/^[a-f0-9-]{36}$/);
    expect(accepted.syncCommandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(harness.sales.getLocalReceipt(accepted.localSaleId)).toEqual(
      expect.objectContaining({
        localReceiptId: accepted.localReceiptId,
        totalMinor: 5_198,
        changeMinor: 802,
        lines: [
          expect.objectContaining({
            sku: "TEE-BLK-M",
            quantity: 2,
            unitPriceMinor: 2_599,
            lineTotalMinor: 5_198,
          }),
        ],
      }),
    );
    const outbox = harness.database.connection
      .prepare(
        `SELECT sync_command_id, idempotency_key, canonical_command, payload_hash,
          request_json, state FROM outbox`,
      )
      .get() as Record<string, string>;
    expect(outbox.sync_command_id).toBe(accepted.syncCommandId);
    expect(outbox.idempotency_key).toBe(accepted.syncCommandId);
    expect(outbox.state).toBe("pending");
    expect(outbox.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    const request = JSON.parse(outbox.request_json) as {
      command: { syncCommandId: string; totalMinor: number } & Record<string, unknown>;
      signature: { credentialId: string; value: string };
    };
    expect(request.command).toMatchObject({
      syncCommandId: accepted.syncCommandId,
      totalMinor: 5_198,
    });
    expect(request.signature.credentialId).toBe(ids.credential);
    expect(request.signature.value).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const { canonicalizeOfflineSaleCommand } = await import("@shifted/clothing-commerce-sdk");
    expect(outbox.canonical_command).toBe(canonicalizeOfflineSaleCommand(request.command as never));
    const publicKey = createPublicKey({
      key: Buffer.from(harness.keys.loadPublicKey().value, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(outbox.canonical_command, "utf8"),
        publicKey,
        Buffer.from(request.signature.value, "base64"),
      ),
    ).toBe(true);
  });

  it("deducts all unreleased accepted local quantities from advisory stock", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    expect(harness.sales.getProjectedInventory()[0]).toMatchObject({
      snapshotOnHand: 10,
      pendingQuantity: 0,
      projectedAvailable: 10,
      advisory: true,
    });
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 2 }],
      cashReceivedMinor: 6_000,
    });
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 3 }],
      cashReceivedMinor: 8_000,
    });
    expect(harness.sales.getProjectedInventory()[0]).toMatchObject({
      pendingQuantity: 5,
      projectedAvailable: 5,
    });
    expect(() =>
      harness.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 6 }],
        cashReceivedMinor: 20_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROJECTED_STOCK_INSUFFICIENT" }));
  });

  it("rejects mutation of accepted commercial facts and exact command identity", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    expect(() =>
      harness.database.connection
        .prepare("UPDATE local_sale_line SET quantity = 2 WHERE local_sale_id = ?")
        .run(accepted.localSaleId),
    ).toThrow(/immutable/);
    expect(() =>
      harness.database.connection
        .prepare("UPDATE local_cash_tender SET cash_received_minor = 9999 WHERE local_sale_id = ?")
        .run(accepted.localSaleId),
    ).toThrow(/immutable/);
    expect(() =>
      harness.database.connection
        .prepare("UPDATE outbox SET request_json = '{}' WHERE sync_command_id = ?")
        .run(accepted.syncCommandId),
    ).toThrow(/immutable/);
  });

  for (const stage of ["sale", "lines", "tender", "outbox"] as const) {
    it(`rolls back every write and the receipt allocation after a ${stage} failure`, () => {
      const harness = makeHarness({
        saleTestSeam: {
          afterStage(actual: OfflineSaleWriteStage) {
            if (actual === stage) throw new Error(`injected ${stage} failure`);
          },
        },
      });
      harnesses.push(harness);
      expect(() =>
        harness.sales.acceptCashSale({
          lines: [{ variantId: ids.variant, quantity: 1 }],
          cashReceivedMinor: 3_000,
        }),
      ).toThrow(`injected ${stage} failure`);
      for (const table of ["local_sale", "local_sale_line", "local_cash_tender", "outbox"]) {
        expect(
          harness.database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
      expect(
        harness.database.connection
          .prepare("SELECT next_receipt_number FROM app_metadata WHERE singleton_id = 1")
          .get(),
      ).toEqual({ next_receipt_number: 1 });
    });
  }
});
