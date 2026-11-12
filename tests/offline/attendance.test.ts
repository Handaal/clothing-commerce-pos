import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

// Deliverable B — offline attendance capture, POS-local durable slice (real SQLite, real main-process
// service). These prove the device side only: a signed, immutable, append-only clock event persisted to
// local_attendance_event + attendance_outbox inside ONE transaction before any network, shown as
// provisional (accepted_pending_sync) and never as server-confirmed payroll. Server acceptance is proven
// separately by the isolated real-API attendance integration suite.
describe("offline attendance capture", () => {
  it("persists an immutable signed clock event to the local table and outbox in one transaction", async () => {
    const harness = makeHarness();
    harnesses.push(harness);

    const accepted = harness.sales.recordAttendanceEvent({ eventType: "clock_in" });
    expect(accepted).toMatchObject({
      lifecycle: "accepted_pending_sync",
      eventType: "clock_in",
      operatorMembershipId: ids.membership,
    });
    expect(accepted.localEventId).toMatch(/^[a-f0-9-]{36}$/);
    expect(accepted.syncCommandId).toMatch(/^[a-f0-9-]{36}$/);
    // eventAt is the device clock and equals acceptedAt (server re-bounds both against the grant window).
    expect(accepted.eventAt).toBe(accepted.acceptedAt);

    const event = harness.database.connection
      .prepare(
        `SELECT local_event_id, operator_membership_id, event_type, event_at, accepted_at, lifecycle
         FROM local_attendance_event`,
      )
      .get() as Record<string, string>;
    expect(event).toMatchObject({
      local_event_id: accepted.localEventId,
      operator_membership_id: ids.membership,
      event_type: "clock_in",
      lifecycle: "accepted_pending_sync",
    });

    const outbox = harness.database.connection
      .prepare(
        `SELECT sync_command_id, local_event_id, idempotency_key, canonical_command, payload_hash,
          signature_base64, credential_id, request_json, state FROM attendance_outbox`,
      )
      .get() as Record<string, string>;
    expect(outbox.sync_command_id).toBe(accepted.syncCommandId);
    expect(outbox.local_event_id).toBe(accepted.localEventId);
    // The idempotency key is the sync command id and must be replayed unchanged on the wire.
    expect(outbox.idempotency_key).toBe(accepted.syncCommandId);
    expect(outbox.state).toBe("pending");
    expect(outbox.credential_id).toBe(ids.credential);
    expect(outbox.payload_hash).toMatch(/^[a-f0-9]{64}$/);

    const request = JSON.parse(outbox.request_json) as {
      command: Record<string, unknown>;
      signature: { algorithm: string; credentialId: string; value: string };
    };
    expect(request.command).toMatchObject({
      schemaVersion: 1,
      localEventId: accepted.localEventId,
      syncCommandId: accepted.syncCommandId,
      grantId: ids.grant,
      deviceId: ids.device,
      registerId: ids.register,
      operatorMembershipId: ids.membership,
      eventType: "clock_in",
      eventAt: accepted.eventAt,
      acceptedAt: accepted.acceptedAt,
    });
    expect(request.signature.algorithm).toBe("Ed25519");
    expect(request.signature.credentialId).toBe(ids.credential);

    // The stored canonical command is exactly the SDK canonicalization the server will re-derive, the
    // payload hash is its sha256, and the signature verifies against the device key — i.e. the exact
    // command identity is preserved for replay.
    const { canonicalizeOfflineAttendanceCommand } = await import("@shifted/clothing-commerce-sdk");
    const canonical = canonicalizeOfflineAttendanceCommand(request.command as never);
    expect(outbox.canonical_command).toBe(canonical);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(outbox.payload_hash);
    const publicKey = createPublicKey({
      key: Buffer.from(harness.keys.loadPublicKey().value, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(outbox.signature_base64, "base64")),
    ).toBe(true);
  });

  it("surfaces the local attendance state with pending count, recent history, and next-action toggle", () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => clock });
    harnesses.push(harness);

    expect(harness.sales.getLocalAttendance()).toEqual({ lastEvent: null, pending: 0, recent: [] });

    harness.sales.recordAttendanceEvent({ eventType: "clock_in" });
    clock = new Date("2026-09-08T12:05:00.000Z");
    harness.sales.recordAttendanceEvent({ eventType: "clock_out" });

    const state = harness.sales.getLocalAttendance();
    expect(state.pending).toBe(2);
    expect(state.recent).toHaveLength(2);
    // Most recent first — last captured event is clock_out, so the next clock action is clock_in.
    expect(state.lastEvent?.eventType).toBe("clock_out");
    expect(state.recent[0]?.eventType).toBe("clock_out");
    expect(state.recent[1]?.eventType).toBe("clock_in");
    expect(state.recent.every((event) => event.lifecycle === "accepted_pending_sync")).toBe(true);
  });

  it("fails closed when no offline authority is installed (never a false success)", () => {
    const harness = makeHarness({ install: false });
    harnesses.push(harness);
    expect(() => harness.sales.recordAttendanceEvent({ eventType: "clock_in" })).toThrow();
    // No partial write: neither the local event nor an outbox row exists.
    expect(
      (harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM local_attendance_event")
        .get() as { n: number }).n,
    ).toBe(0);
    expect(
      (harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM attendance_outbox")
        .get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects a malformed event type", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    expect(() =>
      harness.sales.recordAttendanceEvent({ eventType: "lunch" as never }),
    ).toThrow();
    expect(
      (harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM attendance_outbox")
        .get() as { n: number }).n,
    ).toBe(0);
  });
});
