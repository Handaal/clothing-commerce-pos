import { afterEach, describe, expect, it } from "vitest";

import { AttendanceOutboxStore } from "../../src/main/offline/attendance-outbox-store";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { PaymentOutboxStore } from "../../src/main/offline/payment-outbox-store";
import { offlineReturnsDisabled } from "../../src/main/offline/runtime";
import { OfflineSyncWorker, type OfflineDeliveryClient } from "../../src/main/offline/sync-worker";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

// ADR-042 §13 (online-first POS, bounded emergency offline, post-sync conflict reporting) — till side.
const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const unexpected = (lane: string) => async () => {
  throw new Error(`${lane} was not expected in this test`);
};

function conflictAnswer(kind: "customer_debt" | "attendance", reasonCode: string) {
  return {
    syncStatus: "conflict_recorded" as const,
    ingestionId: "20000000-0000-4000-8000-0000000000c1",
    receivedAt: "2026-09-08T12:00:30.000Z",
    conflict: { id: "30000000-0000-4000-8000-0000000000c1", kind, reasonCode },
  };
}

function rows(harness: OfflineHarness, sql: string, ...args: string[]) {
  return harness.database.connection.prepare(sql).all(...args);
}

describe("ADR-042 §13.5 server-preserved conflicts on the till", () => {
  it("a paydown the server preserves as a conflict is terminal, kept, never retried, and receipted", async () => {
    // The till's cached debt (5000) allows the paydown locally; meanwhile the Website/another channel was
    // paid, so the server's outstanding is lower and it preserves the payment as a conflict.
    const harness = makeHarness({
      bootstrap: bootstrapFixture({
        customers: [
          {
            customerId: ids.customer,
            name: "Layla Hassan",
            phone: "+201000000000",
            outstandingMinor: 5_000,
          },
        ],
      } as never),
    });
    harnesses.push(harness);
    const payment = harness.sales.recordCustomerPayment({
      customerId: ids.customer,
      amountMinor: 100,
    });
    let deliveries = 0;
    const delivery: OfflineDeliveryClient = {
      deliver: unexpected("deliver"),
      deliverReturn: unexpected("deliverReturn"),
      deliverAttendance: unexpected("deliverAttendance"),
      deliverPayment: async (item) => {
        deliveries += 1;
        return {
          ...conflictAnswer("customer_debt", "PAYDOWN_EXCEEDS_OUTSTANDING"),
          localPaymentId: item.localPaymentId,
        };
      },
    };
    const worker = new OfflineSyncWorker(
      new OutboxStore(harness.database, () => new Date()),
      delivery,
      { paymentOutbox: new PaymentOutboxStore(harness.database, () => new Date()) },
    );
    await worker.requestRun();
    await worker.requestRun();
    expect(deliveries).toBe(1);
    expect(
      rows(
        harness,
        "SELECT state FROM payment_outbox WHERE sync_command_id = ?",
        payment.syncCommandId,
      ),
    ).toEqual([{ state: "delivered" }]);
    // The cashier-recorded payment is still on the till, flagged — never deleted or silently "synced".
    expect(
      rows(
        harness,
        "SELECT lifecycle, amount_minor FROM local_customer_payment WHERE local_payment_id = ?",
        payment.localPaymentId,
      ),
    ).toEqual([{ lifecycle: "needs_reconciliation", amount_minor: 100 }]);
    expect(
      rows(
        harness,
        "SELECT command_kind, conflict_kind, reason_code FROM server_sync_conflict_receipt WHERE sync_command_id = ?",
        payment.syncCommandId,
      ),
    ).toEqual([
      {
        command_kind: "customer_payment",
        conflict_kind: "customer_debt",
        reason_code: "PAYDOWN_EXCEEDS_OUTSTANDING",
      },
    ]);
    expect(() =>
      harness.database.connection.prepare("DELETE FROM server_sync_conflict_receipt").run(),
    ).toThrow(/retained/);
  });

  it("a duplicate clock-in preserved by the server is receipted and not retried", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const event = harness.sales.recordAttendanceEvent({ eventType: "clock_in" });
    const delivery: OfflineDeliveryClient = {
      deliver: unexpected("deliver"),
      deliverReturn: unexpected("deliverReturn"),
      deliverPayment: unexpected("deliverPayment"),
      deliverAttendance: async (item) => ({
        ...conflictAnswer("attendance", "ALREADY_CLOCKED_IN"),
        localEventId: item.localEventId,
      }),
    };
    const attendanceOutbox = new AttendanceOutboxStore(harness.database, () => new Date());
    const worker = new OfflineSyncWorker(
      new OutboxStore(harness.database, () => new Date()),
      delivery,
      { attendanceOutbox },
    );
    await worker.requestRun();
    expect(attendanceOutbox.getStatusCounts().pending).toBe(0);
    expect(
      rows(
        harness,
        "SELECT reason_code FROM server_sync_conflict_receipt WHERE sync_command_id = ?",
        event.syncCommandId,
      ),
    ).toEqual([{ reason_code: "ALREADY_CLOCKED_IN" }]);
  });
});

describe("ADR-042 §13 returns are online-only at the main-process boundary", () => {
  it("uses a deterministic online-required refusal", () => {
    const error = offlineReturnsDisabled();
    expect(error).toMatchObject({ code: "OFFLINE_RETURNS_DISABLED" });
    expect(error.message).toMatch(/online-only/);
  });
});
