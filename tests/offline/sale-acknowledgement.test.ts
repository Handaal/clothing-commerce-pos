import { afterEach, describe, expect, it } from "vitest";

import { ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("offline sale acknowledgement recovery", () => {
  it("treats a freshly accepted sale as durably committed but unacknowledged", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    // Simulates the crash window: SQLite commit succeeded, the receipt was never acknowledged.
    const unacknowledged = harness.sales.getUnacknowledgedSales();
    expect(unacknowledged).toHaveLength(1);
    expect(unacknowledged[0]).toMatchObject({
      localSaleId: accepted.localSaleId,
      localReceiptId: accepted.localReceiptId,
      acknowledgedAt: null,
    });
    expect(harness.sales.getLocalReceipt(accepted.localSaleId)?.acknowledgedAt).toBeNull();
  });

  it("removes a sale from recovery only once the cashier acknowledges it", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const result = harness.sales.acknowledgeSale(accepted.localSaleId);
    expect(result.acknowledgedAt).not.toBeNull();
    expect(harness.sales.getUnacknowledgedSales()).toHaveLength(0);
  });

  it("acknowledgement is write-once and independent of synchronization state", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const first = harness.sales.acknowledgeSale(accepted.localSaleId);
    // Acknowledging again is a no-op that keeps the original timestamp (never a second write).
    const second = harness.sales.acknowledgeSale(accepted.localSaleId);
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
    // A direct attempt to overwrite the acknowledgement is rejected by the schema trigger.
    expect(() =>
      harness.database.connection
        .prepare("UPDATE local_sale SET acknowledged_at = ? WHERE local_sale_id = ?")
        .run("2099-01-01T00:00:00.000Z", accepted.localSaleId),
    ).toThrow(/immutable/);
    // The outbox row is untouched by acknowledgement — sync and acknowledgement are orthogonal.
    expect(harness.database.connection.prepare("SELECT state FROM outbox").get()).toEqual({
      state: "pending",
    });
  });

  it("presents multiple unacknowledged sales deterministically, oldest first", () => {
    // A monotonic clock gives the two sales distinct created_at values so ordering is by acceptance
    // time, not by the random local_sale_id that would otherwise break the tie.
    let tick = Date.parse("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => new Date((tick += 1_000)) });
    harnesses.push(harness);
    const first = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const second = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const pending = harness.sales.getUnacknowledgedSales();
    expect(pending.map((sale) => sale.localSaleId)).toEqual([
      first.localSaleId,
      second.localSaleId,
    ]);
    harness.sales.acknowledgeSale(first.localSaleId);
    expect(harness.sales.getUnacknowledgedSales().map((sale) => sale.localSaleId)).toEqual([
      second.localSaleId,
    ]);
  });
});
