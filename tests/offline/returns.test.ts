import { createHash, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  IngestOfflineReturnResponse,
  OfflineReturnGrantResponse,
  OrderDetailResponse,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };
import { afterEach, describe, expect, it } from "vitest";

import { OutboxStore } from "../../src/main/offline/outbox-store";
import { ReturnOutboxStore } from "../../src/main/offline/return-outbox-store";
import {
  OfflineReturnService,
  type ReturnGrantIssueRequest,
  type ReturnGrantIssuer,
} from "../../src/main/offline/return-service";
import {
  OfflineSyncWorker,
  readExactPersistedReturnRequest,
  type OfflineDeliveryClient,
} from "../../src/main/offline/sync-worker";
import { parseOfflineReturnInput, parsePrepareReturnGrantInput } from "../../src/main/offline/ipc";
import {
  OverrideRosterStore,
  deriveOverrideDeviceVerifierForTest,
} from "../../src/main/offline/override-roster";
import { ids, makeHarness, TestSecureStorage, type OfflineHarness } from "./fixtures";

const { ApiNetworkError, ApiHttpError } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as {
  ApiNetworkError: new (message: string) => Error;
  ApiHttpError: new (...args: never[]) => Error;
};

const order = "30000000-0000-4000-8000-000000000001";
const lineA = "30000000-0000-4000-8000-000000000002";
const lineB = "30000000-0000-4000-8000-000000000003";
const returnGrantId = "30000000-0000-4000-8000-000000000004";

function grantFixture(
  overrides: Partial<OfflineReturnGrantResponse> = {},
): OfflineReturnGrantResponse {
  return {
    returnGrantId,
    snapshotId: ids.snapshot,
    schemaVersion: 1,
    minimumClientVersion: "0.1.0",
    tenantId: ids.tenant,
    deviceId: ids.device,
    registerId: ids.register,
    branchId: ids.branch,
    inventoryLocationId: ids.location,
    operatorMembershipId: ids.membership,
    orderId: order,
    currency: "USD",
    issuedAt: "2026-09-08T11:55:00.000Z",
    expiresAt: "2026-09-08T20:00:00.000Z",
    maxRefundableMinor: 7_797,
    requiresAdminCredentials: false,
    allowedReasons: null,
    lines: [
      {
        orderLineId: lineA,
        lineNumber: 1,
        variantId: ids.variant,
        eligibleQuantity: 2,
        unitPriceMinor: 2_599,
      },
      {
        orderLineId: lineB,
        lineNumber: 2,
        variantId: ids.variant,
        eligibleQuantity: 1,
        unitPriceMinor: 2_599,
      },
    ],
    ...overrides,
  };
}

function orderFixture(): OrderDetailResponse {
  return {
    header: { id: order, orderNumber: "POS-1001" },
    lines: [
      { lineNumber: 1, productName: "Foundation Tee", sku: "TEE-BLK-M" },
      { lineNumber: 2, productName: "Foundation Tee", sku: "TEE-BLK-L" },
    ],
  } as unknown as OrderDetailResponse;
}

class FakeIssuer implements ReturnGrantIssuer {
  readonly calls: ReturnGrantIssueRequest[] = [];
  constructor(private readonly grant: () => OfflineReturnGrantResponse = () => grantFixture()) {}
  async issue(request: ReturnGrantIssueRequest) {
    this.calls.push(request);
    return { grant: this.grant(), order: orderFixture() };
  }
}

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup(options: Parameters<typeof makeHarness>[0] & { issuer?: FakeIssuer } = {}) {
  const harness = makeHarness(options);
  harnesses.push(harness);
  const issuer = options.issuer ?? new FakeIssuer();
  const now = options.now ?? (() => new Date("2026-09-08T12:00:00.000Z"));
  const returns = new OfflineReturnService(harness.database, harness.keys, issuer, now);
  return { harness, issuer, returns };
}

const session = { tenantId: ids.tenant, accessToken: "token-value", orderId: order };

function count(harness: OfflineHarness, table: string): number {
  return (
    harness.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function syncedResponse(localReturnId: string): IngestOfflineReturnResponse {
  return {
    syncStatus: "synced",
    ingestionId: "40000000-0000-4000-8000-000000000001",
    localReturnId,
    receivedAt: "2026-09-08T12:00:30.000Z",
    returnId: "40000000-0000-4000-8000-000000000002",
    refund: {
      id: "40000000-0000-4000-8000-000000000003",
      status: "pending",
      amountMinor: 2_499,
      currency: "USD",
    },
    reconciliation: null,
  } as IngestOfflineReturnResponse;
}

function withheldResponse(localReturnId: string): IngestOfflineReturnResponse {
  return {
    syncStatus: "needs_reconciliation",
    ingestionId: "40000000-0000-4000-8000-000000000011",
    localReturnId,
    receivedAt: "2026-09-08T12:00:30.000Z",
    returnId: null,
    refund: null,
    reconciliation: {
      id: "40000000-0000-4000-8000-000000000012",
      reason: "eligibility_drift_at_ingestion",
      status: "open",
    },
  } as IngestOfflineReturnResponse;
}

const unexpected = (name: string) => async () => {
  throw new Error(`${name} was not expected in this test`);
};

function returnWorker(
  harness: OfflineHarness,
  deliverReturn: OfflineDeliveryClient["deliverReturn"],
  now: () => Date = () => new Date("2026-09-08T12:00:00.000Z"),
) {
  const returnOutbox = new ReturnOutboxStore(harness.database, now);
  const worker = new OfflineSyncWorker(
    new OutboxStore(harness.database, now),
    {
      deliver: unexpected("deliver"),
      deliverPayment: unexpected("deliverPayment"),
      deliverAttendance: unexpected("deliverAttendance"),
      deliverReturn,
    },
    { returnOutbox, now },
  );
  return { worker, returnOutbox };
}

describe("offline return grant preparation (online)", () => {
  it("caches the server grant with server order labels and reuses it while comfortably in window", async () => {
    const { harness, issuer, returns } = setup();
    const view = await returns.prepareGrant(session);
    expect(issuer.calls).toHaveLength(1);
    // Main binds the request to the enrolled device — the renderer never supplies device/register.
    expect(issuer.calls[0]).toMatchObject({
      tenantId: ids.tenant,
      deviceId: ids.device,
      registerId: ids.register,
      orderId: order,
      accessToken: "token-value",
    });
    expect(view).toMatchObject({
      returnGrantId,
      orderNumber: "POS-1001",
      allowedReasons: null,
      expiresAt: "2026-09-08T20:00:00.000Z",
    });
    expect(view.lines.map((line) => [line.productName, line.sku, line.remainingQuantity])).toEqual([
      ["Foundation Tee", "TEE-BLK-M", 2],
      ["Foundation Tee", "TEE-BLK-L", 1],
    ]);
    await returns.prepareGrant(session);
    expect(issuer.calls).toHaveLength(1);
    expect(count(harness, "offline_return_grant")).toBe(1);
    expect(returns.getGrants()).toHaveLength(1);
  });

  it("rejects a grant bound to another device and caches nothing", async () => {
    const issuer = new FakeIssuer(() =>
      grantFixture({ deviceId: "99999999-0000-4000-8000-000000000000" }),
    );
    const { harness, returns } = setup({ issuer });
    await expect(returns.prepareGrant(session)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(count(harness, "offline_return_grant")).toBe(0);
  });

  it("refuses a tenant that is not the enrolled device's before any network call", async () => {
    const { issuer, returns } = setup();
    await expect(
      returns.prepareGrant({ ...session, tenantId: "88888888-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(issuer.calls).toHaveLength(0);
  });

  it("fails closed on an unenrolled installation", async () => {
    const { issuer, returns } = setup({ enroll: false, install: false });
    await expect(returns.prepareGrant(session)).rejects.toMatchObject({
      code: "DEVICE_NOT_ENROLLED",
    });
    expect(issuer.calls).toHaveLength(0);
    expect(returns.getGrants()).toEqual([]);
  });

  it("hides expired grants from the offline desk", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const { returns } = setup({ now: () => clock });
    await returns.prepareGrant(session);
    clock = new Date("2026-09-08T20:00:01.000Z");
    expect(returns.getGrants()).toEqual([]);
  });
});

describe("offline return capture (device-local, real SQLite)", () => {
  it("persists an immutable signed return to local tables and the outbox in one transaction", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    const accepted = returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "  Too small ", disposition: "restock" }],
    });
    expect(accepted).toMatchObject({
      lifecycle: "accepted_pending_sync",
      orderId: order,
      orderNumber: "POS-1001",
    });

    const outbox = harness.database.connection
      .prepare(
        `SELECT sync_command_id, local_return_id, idempotency_key, canonical_command, payload_hash,
          signature_base64, credential_id, request_json, state FROM return_outbox`,
      )
      .get() as Record<string, string>;
    expect(outbox).toMatchObject({
      sync_command_id: accepted.syncCommandId,
      local_return_id: accepted.localReturnId,
      idempotency_key: accepted.syncCommandId,
      credential_id: ids.credential,
      state: "pending",
    });
    const request = JSON.parse(outbox.request_json) as {
      command: Record<string, unknown>;
      signature: { algorithm: string; credentialId: string };
    };
    // No refund money is ever in the command: the server recomputes it at ingestion.
    expect(request.command).toEqual({
      schemaVersion: 1,
      localReturnId: accepted.localReturnId,
      syncCommandId: accepted.syncCommandId,
      returnGrantId,
      deviceId: ids.device,
      registerId: ids.register,
      orderId: order,
      acceptedAt: accepted.acceptedAt,
      currency: "USD",
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Too small", disposition: "restock" }],
    });

    const { canonicalizeOfflineReturnCommand } = await import("@shifted/clothing-commerce-sdk");
    const canonical = canonicalizeOfflineReturnCommand(request.command as never);
    expect(outbox.canonical_command).toBe(canonical);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(outbox.payload_hash);
    const publicKey = createPublicKey({
      key: Buffer.from(harness.keys.loadPublicKey().value, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(canonical, "utf8"),
        publicKey,
        Buffer.from(outbox.signature_base64, "base64"),
      ),
    ).toBe(true);

    expect(count(harness, "local_return")).toBe(1);
    expect(count(harness, "local_return_line")).toBe(1);
    // Remaining authorization reflects the captured quantity (not yet known to the server).
    expect(returns.getGrants()[0]!.lines[0]!.remainingQuantity).toBe(1);
    const local = returns.getLocalReturns();
    expect(local.pending).toBe(1);
    expect(local.recent[0]).toMatchObject({
      lifecycle: "accepted_pending_sync",
      refund: null,
      lines: [{ orderLineId: lineA, productName: "Foundation Tee", quantity: 1 }],
    });

    // Accepted facts and the queued command are immutable.
    expect(() =>
      harness.database.connection.prepare("UPDATE local_return SET accepted_at = 'x'").run(),
    ).toThrow(/immutable/);
    expect(() => harness.database.connection.prepare("DELETE FROM return_outbox").run()).toThrow(
      /immutable/,
    );
    expect(() =>
      harness.database.connection
        .prepare("UPDATE offline_return_grant_line SET eligible_quantity = 99")
        .run(),
    ).toThrow(/immutable/);
  });

  it("never authorizes more than the grant across repeated offline returns", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 2, reason: "Damaged", disposition: "non_restock" }],
    });
    expect(() =>
      returns.recordReturn({
        returnGrantId,
        lines: [{ orderLineId: lineA, quantity: 1, reason: "Damaged", disposition: "non_restock" }],
      }),
    ).toThrow(expect.objectContaining({ code: "QUANTITY_EXCEEDS_GRANT" }));
    expect(count(harness, "local_return")).toBe(1);
  });

  it.each([
    [
      "a line the grant does not authorize",
      { orderLineId: "30000000-0000-4000-8000-0000000000ff", quantity: 1 },
      "LINE_NOT_GRANTED",
    ],
    [
      "a quantity above the frozen eligibility",
      { orderLineId: lineB, quantity: 2 },
      "QUANTITY_EXCEEDS_GRANT",
    ],
  ])("rejects %s with no partial write", async (_label, line, code) => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    expect(() =>
      returns.recordReturn({
        returnGrantId,
        lines: [{ ...line, reason: "Wrong size", disposition: "non_restock" }],
      }),
    ).toThrow(expect.objectContaining({ code }));
    expect(count(harness, "local_return")).toBe(0);
    expect(count(harness, "local_return_line")).toBe(0);
    expect(count(harness, "return_outbox")).toBe(0);
  });

  it("enforces the policy's allowed reasons", async () => {
    const issuer = new FakeIssuer(() => grantFixture({ allowedReasons: ["Defective"] }));
    const { returns } = setup({ issuer });
    await returns.prepareGrant(session);
    expect(() =>
      returns.recordReturn({
        returnGrantId,
        lines: [
          { orderLineId: lineA, quantity: 1, reason: "Changed mind", disposition: "non_restock" },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "REASON_NOT_ALLOWED" }));
    expect(
      returns.recordReturn({
        returnGrantId,
        lines: [
          { orderLineId: lineA, quantity: 1, reason: "Defective", disposition: "non_restock" },
        ],
      }).lifecycle,
    ).toBe("accepted_pending_sync");
  });

  it("fails closed once the grant window has ended", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const { harness, returns } = setup({ now: () => clock });
    await returns.prepareGrant(session);
    clock = new Date("2026-09-08T20:00:01.000Z");
    expect(() =>
      returns.recordReturn({
        returnGrantId,
        lines: [{ orderLineId: lineA, quantity: 1, reason: "Late", disposition: "non_restock" }],
      }),
    ).toThrow(expect.objectContaining({ code: "RETURN_GRANT_EXPIRED" }));
    expect(count(harness, "return_outbox")).toBe(0);
  });

  it("fails closed for an unknown grant", () => {
    const { returns } = setup();
    expect(() =>
      returns.recordReturn({
        returnGrantId,
        lines: [{ orderLineId: lineA, quantity: 1, reason: "x", disposition: "non_restock" }],
      }),
    ).toThrow(expect.objectContaining({ code: "RETURN_GRANT_MISSING" }));
  });

  it("validates renderer input at the IPC boundary", () => {
    expect(() => parseOfflineReturnInput(null)).toThrow(TypeError);
    expect(() => parseOfflineReturnInput({ returnGrantId, lines: [] })).toThrow(TypeError);
    expect(() =>
      parseOfflineReturnInput({
        returnGrantId,
        lines: [{ orderLineId: lineA, quantity: 1.5, reason: "x", disposition: "restock" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseOfflineReturnInput({
        returnGrantId,
        lines: [{ orderLineId: lineA, quantity: 1, reason: "x", disposition: "settled" }],
      }),
    ).toThrow(TypeError);
    expect(() => parsePrepareReturnGrantInput({ tenantId: ids.tenant, orderId: order })).toThrow(
      TypeError,
    );
  });
});

describe("offline return synchronization lane", () => {
  it("delivers the exact persisted command and records the server's PENDING refund", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    const accepted = returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Too small", disposition: "restock" }],
    });
    const keys: string[] = [];
    const { worker, returnOutbox } = returnWorker(harness, async (item) => {
      keys.push(item.idempotencyKey);
      // The delivered request passes the immutable identity check against the stored canonical form.
      expect(readExactPersistedReturnRequest(item).command.localReturnId).toBe(
        accepted.localReturnId,
      );
      return syncedResponse(item.localReturnId);
    });
    await worker.requestRun();
    expect(keys).toEqual([accepted.syncCommandId]);
    expect(returnOutbox.getStatusCounts()).toMatchObject({
      pending: 0,
      synced: 1,
      needsReconciliation: 0,
    });
    expect(worker.getStatus()).toMatchObject({ pending: 0, synced: 1 });
    const local = returns.getLocalReturns().recent[0]!;
    expect(local).toMatchObject({
      lifecycle: "synced",
      serverReturnId: "40000000-0000-4000-8000-000000000002",
      refund: { amountMinor: 2_499, currency: "USD", status: "pending" },
    });
    // Once the server has received it after issuance, it still counts against this grant's remaining.
    expect(returns.getGrants()[0]!.lines[0]!.remainingQuantity).toBe(1);
  });

  it("records eligibility drift as needs_reconciliation with the refund withheld", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineB, quantity: 1, reason: "Faulty", disposition: "non_restock" }],
    });
    const { worker } = returnWorker(harness, async (item) => withheldResponse(item.localReturnId));
    await worker.requestRun();
    const local = returns.getLocalReturns().recent[0]!;
    expect(local).toMatchObject({
      lifecycle: "needs_reconciliation",
      refund: null,
      reconciliationReason: "eligibility_drift_at_ingestion",
    });
    expect(worker.getStatus().needsReconciliation).toBe(1);
    // A withheld return created no canonical Return, so it no longer consumes the grant locally.
    expect(returns.getGrants()[0]!.lines[1]!.remainingQuantity).toBe(1);
  });

  it("retries a transient failure without duplicating, then syncs exactly once", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const { harness, returns } = setup({ now: () => clock });
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Too big", disposition: "non_restock" }],
    });
    const keys: string[] = [];
    const { worker, returnOutbox } = returnWorker(
      harness,
      async (item) => {
        keys.push(item.idempotencyKey);
        if (keys.length === 1) throw new ApiNetworkError("offline");
        return syncedResponse(item.localReturnId);
      },
      () => clock,
    );
    await worker.requestRun();
    expect(returnOutbox.getStatusCounts()).toMatchObject({ retryWait: 1, synced: 0 });
    clock = new Date("2026-09-08T12:05:00.000Z");
    await worker.requestRun();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(returnOutbox.getStatusCounts()).toMatchObject({ pending: 0, retryWait: 0, synced: 1 });
    expect(count(harness, "local_return")).toBe(1);
  });

  it("recovers a crashed lease and replays the same command identity", async () => {
    let clock = new Date("2026-09-08T12:00:00.000Z");
    const { harness, returns } = setup({ now: () => clock });
    await returns.prepareGrant(session);
    const accepted = returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Crash", disposition: "non_restock" }],
    });
    // Simulate a process that leased the command and died before acknowledging.
    const crashed = new ReturnOutboxStore(harness.database, () => clock);
    const leased = crashed.claimNext(30_000)!;
    expect(leased.idempotencyKey).toBe(accepted.syncCommandId);

    clock = new Date("2026-09-08T12:01:00.000Z");
    const keys: string[] = [];
    const { worker, returnOutbox } = returnWorker(
      harness,
      async (item) => {
        keys.push(item.idempotencyKey);
        expect(item.canonicalCommand).toBe(leased.canonicalCommand);
        return syncedResponse(item.localReturnId);
      },
      () => clock,
    );
    await worker.requestRun();
    expect(keys).toEqual([accepted.syncCommandId]);
    expect(returnOutbox.getStatusCounts()).toMatchObject({ leased: 0, synced: 1 });
  });

  it("blocks a definite server rejection for operator attention", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Bad", disposition: "non_restock" }],
    });
    const rejection = Object.assign(Object.create(ApiHttpError.prototype) as Error, {
      status: 403,
      code: "OFFLINE_GRANT_BINDING_MISMATCH",
      message: "binding mismatch",
    });
    const { worker, returnOutbox } = returnWorker(harness, async () => {
      throw rejection;
    });
    await worker.requestRun();
    expect(returnOutbox.getStatusCounts()).toMatchObject({ blocked: 1, synced: 0 });
    expect(worker.getStatus().blocked).toBe(1);
    // The local return stays provisional; it is never shown as synced or refunded.
    expect(returns.getLocalReturns().recent[0]!.lifecycle).toBe("accepted_pending_sync");
  });

  it("refuses a response for a different local return and leaves the command leased for recovery", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Mismatch", disposition: "non_restock" }],
    });
    const { worker, returnOutbox } = returnWorker(harness, async () =>
      syncedResponse("50000000-0000-4000-8000-000000000000"),
    );
    await expect(worker.requestRun()).rejects.toThrow(/does not match/);
    expect(returnOutbox.getStatusCounts()).toMatchObject({ synced: 0 });
    expect(returns.getLocalReturns().recent[0]!.lifecycle).toBe("accepted_pending_sync");
  });

  it("detects a tampered persisted request before sending it", async () => {
    const { harness, returns } = setup();
    await returns.prepareGrant(session);
    returns.recordReturn({
      returnGrantId,
      lines: [{ orderLineId: lineA, quantity: 1, reason: "Tamper", disposition: "non_restock" }],
    });
    const item = new ReturnOutboxStore(
      harness.database,
      () => new Date("2026-09-08T12:00:00.000Z"),
    ).claimNext(30_000)!;
    const forged = JSON.parse(item.requestJson) as {
      command: { lines: Array<{ quantity: number }> };
    };
    forged.command.lines[0]!.quantity = 2;
    expect(() =>
      readExactPersistedReturnRequest({ ...item, requestJson: JSON.stringify(forged) }),
    ).toThrow(/immutable identity/);
  });
});

describe("ADR-042 §6/§7 offline return approval", () => {
  it("requires a manager's override password when the grant says so and signs a payments.refund assertion", async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const now = () => new Date("2026-09-08T12:00:00.000Z");
    const roster = new OverrideRosterStore(
      path.join(harness.directory, "override-roster.sealed"),
      new TestSecureStorage(),
      now,
    );
    roster.install(ids.grant, ids.device, [
      {
        membershipId: "10000000-0000-4000-8000-0000000000aa",
        username: "boss",
        displayName: "The Boss",
        permissions: ["payments.refund"],
        verifierVersion: 1,
        verifier: deriveOverrideDeviceVerifierForTest({
          password: "Blue-Harbour-71",
          deviceId: ids.device,
          membershipId: "10000000-0000-4000-8000-0000000000aa",
          verifierVersion: 1,
          n: 1024,
        }),
        expiresAt: "2026-09-08T20:00:00.000Z",
      },
    ]);
    const returns = new OfflineReturnService(
      harness.database,
      harness.keys,
      new FakeIssuer(() => grantFixture({ requiresAdminCredentials: true })),
      now,
      roster,
    );
    const view = await returns.prepareGrant(session);
    expect(view.requiresAdminCredentials).toBe(true);
    const line = {
      orderLineId: lineA,
      quantity: 1,
      reason: "Too small",
      disposition: "restock" as const,
    };
    expect(() => returns.recordReturn({ returnGrantId, lines: [line] })).toThrow(
      expect.objectContaining({ code: "ADMIN_CREDENTIALS_REQUIRED" }),
    );
    returns.recordReturn({
      returnGrantId,
      lines: [line],
      approver: { username: "boss", password: "Blue-Harbour-71" },
    });
    const row = harness.database.connection
      .prepare("SELECT request_json FROM return_outbox")
      .get() as { request_json: string };
    const command = JSON.parse(row.request_json).command;
    expect(command.adminAssertion).toMatchObject({
      permission: "payments.refund",
      commandId: command.syncCommandId,
      offlineGrantId: ids.grant,
    });
    expect(row.request_json).not.toContain("Blue-Harbour-71");
  });
});
