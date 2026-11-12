import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { AttendanceOutboxStore } from "../../src/main/offline/attendance-outbox-store";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { OfflineSyncWorker, type OfflineDeliveryClient } from "../../src/main/offline/sync-worker";
import { makeHarness, type OfflineHarness } from "./fixtures";

const { ApiNetworkError } = createRequire(__filename)("@shifted/clothing-commerce-sdk") as {
  ApiNetworkError: new (message: string) => Error;
};

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

// The sale/payment lanes are never exercised here (no rows queued), so throwing stubs fail loudly if
// that assumption ever regresses.
const unexpectedSale: OfflineDeliveryClient["deliver"] = async () => {
  throw new Error("deliver (sale) was not expected in this test");
};
const unexpectedPayment: OfflineDeliveryClient["deliverPayment"] = async () => {
  throw new Error("deliverPayment was not expected in this test");
};

// A faithful "received" (provisional, pending_policy) server acknowledgement for a local event.
function attendanceResponse(localEventId: string) {
  return {
    syncStatus: "received" as const,
    ingestionId: "20000000-0000-4000-8000-0000000000a1",
    localEventId,
    receivedAt: "2026-09-08T12:00:30.000Z",
    event: {
      membershipId: "10000000-0000-4000-8000-000000000007",
      eventType: "clock_in" as const,
      eventAt: "2026-09-08T12:00:00.000Z",
      adjudication: "pending_policy" as const,
    },
  };
}

describe("offline attendance synchronization lane", () => {
  it("delivers a queued clock event, marks it server-received (not payroll-final), and clears the outbox", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.recordAttendanceEvent({ eventType: "clock_in" });

    const attendanceOutbox = new AttendanceOutboxStore(harness.database, () => new Date());
    let delivered: { idempotencyKey: string; canonical: string } | null = null;
    const delivery: OfflineDeliveryClient = {
      deliver: unexpectedSale,
      deliverPayment: unexpectedPayment,
      deliverAttendance: async (item) => {
        delivered = { idempotencyKey: item.idempotencyKey, canonical: item.canonicalCommand };
        return attendanceResponse(item.localEventId);
      },
    };
    const worker = new OfflineSyncWorker(
      new OutboxStore(harness.database, () => new Date()),
      delivery,
      {
        attendanceOutbox,
      },
    );

    await worker.requestRun();

    // The lane delivered exactly the persisted command, keyed by the stable syncCommandId.
    expect(delivered).not.toBeNull();
    expect(delivered!.idempotencyKey).toBe(accepted.syncCommandId);

    const counts = attendanceOutbox.getStatusCounts();
    expect(counts.pending).toBe(0);
    expect(counts.leased).toBe(0);
    expect(counts.received).toBe(1);

    const outbox = harness.database.connection
      .prepare("SELECT state, server_ingestion_id FROM attendance_outbox")
      .get() as { state: string; server_ingestion_id: string };
    expect(outbox.state).toBe("delivered");
    expect(outbox.server_ingestion_id).toBe("20000000-0000-4000-8000-0000000000a1");

    // The local event is now server-received — NOT "synced as final payroll".
    const event = harness.database.connection
      .prepare("SELECT lifecycle FROM local_attendance_event")
      .get() as { lifecycle: string };
    expect(event.lifecycle).toBe("received");
  });

  it("retries a transient failure without duplicating the event", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => clock });
    harnesses.push(harness);
    harness.sales.recordAttendanceEvent({ eventType: "clock_in" });

    const attendanceOutbox = new AttendanceOutboxStore(harness.database, () => clock);
    let attempts = 0;
    const delivery: OfflineDeliveryClient = {
      deliver: unexpectedSale,
      deliverPayment: unexpectedPayment,
      deliverAttendance: async (item) => {
        attempts += 1;
        if (attempts === 1) throw new ApiNetworkError("offline");
        return attendanceResponse(item.localEventId);
      },
    };
    const worker = new OfflineSyncWorker(new OutboxStore(harness.database, () => clock), delivery, {
      attendanceOutbox,
      now: () => clock,
    });

    await worker.requestRun();
    // After the transient failure the event is queued for retry, still exactly one row, not delivered.
    expect(attendanceOutbox.getStatusCounts()).toMatchObject({ retryWait: 1, received: 0 });

    // Advance past the retry backoff and run again — it now succeeds, with exactly one received event.
    clock = new Date("2026-09-08T12:05:00.000Z");
    await worker.requestRun();
    expect(attempts).toBe(2);
    const counts = attendanceOutbox.getStatusCounts();
    expect(counts).toMatchObject({ pending: 0, retryWait: 0, received: 1 });
    expect(
      (
        harness.database.connection
          .prepare("SELECT COUNT(*) AS n FROM local_attendance_event")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("recovers a crashed lease on restart and replays the exact same command/idempotency key", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => clock });
    harnesses.push(harness);
    const accepted = harness.sales.recordAttendanceEvent({ eventType: "clock_in" });

    // Simulate a crash: a worker claimed (leased) the item but died before delivering.
    const crashed = new AttendanceOutboxStore(harness.database, () => clock);
    const claimed = crashed.claimNext(30_000)!;
    expect(claimed.idempotencyKey).toBe(accepted.syncCommandId);
    const originalCanonical = claimed.canonicalCommand;
    expect(attendanceCountByState(harness, "leased")).toBe(1);

    // Restart well after the lease expired; a fresh worker must recover and redeliver.
    clock = new Date("2026-09-08T12:10:00.000Z");
    const attendanceOutbox = new AttendanceOutboxStore(harness.database, () => clock);
    let replayed: { idempotencyKey: string; canonical: string } | null = null;
    const delivery: OfflineDeliveryClient = {
      deliver: unexpectedSale,
      deliverPayment: unexpectedPayment,
      deliverAttendance: async (item) => {
        replayed = { idempotencyKey: item.idempotencyKey, canonical: item.canonicalCommand };
        return attendanceResponse(item.localEventId);
      },
    };
    const worker = new OfflineSyncWorker(new OutboxStore(harness.database, () => clock), delivery, {
      attendanceOutbox,
      now: () => clock,
    });

    await worker.requestRun();

    // The recovered command is byte-for-byte the one the crashed worker held — exact replay identity.
    expect(replayed).not.toBeNull();
    expect(replayed!.idempotencyKey).toBe(accepted.syncCommandId);
    expect(replayed!.canonical).toBe(originalCanonical);
    expect(attendanceOutbox.getStatusCounts()).toMatchObject({
      leased: 0,
      pending: 0,
      received: 1,
    });
  });
});

function attendanceCountByState(harness: OfflineHarness, state: string): number {
  return (
    harness.database.connection
      .prepare("SELECT COUNT(*) AS n FROM attendance_outbox WHERE state = ?")
      .get(state) as { n: number }
  ).n;
}
