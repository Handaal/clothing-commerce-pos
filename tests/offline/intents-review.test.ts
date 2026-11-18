import { createHash, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { IntentOutboxStore } from "../../src/main/offline/intent-outbox-store";
import { OfflineIntentService } from "../../src/main/offline/intent-service";
import {
  parseOfflineIntentInput,
  parseReviewQuery,
  parseReviewResolutionInput,
} from "../../src/main/offline/ipc";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { OfflineReviewService } from "../../src/main/offline/review-service";
import { OfflineSyncWorker, type OfflineDeliveryClient } from "../../src/main/offline/sync-worker";
import type { OfflineIntentInput } from "../../src/shared/offline";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const { ApiNetworkError, ApiHttpError, canonicalizeOfflineIntentCommand } = createRequire(
  __filename,
)("@shifted/clothing-commerce-sdk") as {
  ApiNetworkError: new (message: string) => Error;
  ApiHttpError: new (...args: never[]) => Error;
  canonicalizeOfflineIntentCommand(command: unknown): string;
};

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const NOW = () => new Date("2026-09-08T12:00:00.000Z");

function setup(options: Parameters<typeof makeHarness>[0] = {}) {
  const harness = makeHarness(options);
  harnesses.push(harness);
  const intents = new OfflineIntentService(
    harness.database,
    harness.keys,
    () => harness.sales.getReadiness(),
    NOW,
  );
  const review = new OfflineReviewService(harness.database, intents, NOW);
  const intentOutbox = new IntentOutboxStore(harness.database, NOW);
  return { harness, intents, review, intentOutbox };
}

function receive(quantity = 4): OfflineIntentInput {
  return {
    operation: "inventory.receive",
    subjectId: ids.variant,
    baseVersion: null,
    dependsOnSyncCommandId: null,
    payload: { variantId: ids.variant, quantity, supplierDocumentRef: "DN-7", note: null },
  };
}

type Disposition = "applied" | "rejected" | "needs_reconciliation" | "blocked_policy";
function received(
  localIntentId: string,
  operation = "inventory.receive",
  disposition: Disposition = "applied",
  code = "OIA_STOCK_POSTED",
) {
  return {
    syncStatus: "received" as const,
    ingestionId: "30000000-0000-4000-8000-0000000000b1",
    localIntentId,
    receivedAt: "2026-09-08T12:00:30.000Z",
    intent: {
      operation,
      disposition,
      code,
      policyVersion: disposition === "blocked_policy" ? null : "E-1",
      decidedAt: "2026-09-08T12:00:30.000Z",
      detail: disposition === "applied" ? { quantityDelta: 4, onHandAfter: 14 } : {},
    },
  } as never;
}

function httpRejection(status: number, code: string) {
  return Object.assign(Object.create(ApiHttpError.prototype) as Error, {
    status,
    code,
    message: code,
  });
}

function worker(
  harness: OfflineHarness,
  intentOutbox: IntentOutboxStore,
  deliverIntent: NonNullable<OfflineDeliveryClient["deliverIntent"]>,
) {
  const unexpected = async () => {
    throw new Error("unexpected lane");
  };
  return new OfflineSyncWorker(
    new OutboxStore(harness.database, NOW),
    {
      deliver: unexpected,
      deliverPayment: unexpected,
      deliverAttendance: unexpected,
      deliverReturn: unexpected,
      deliverIntent,
    },
    { now: NOW, intentOutbox },
  );
}

function count(database: LocalDatabase, sql: string): number {
  return Number((database.connection.prepare(sql).get() as { c: number }).c);
}

describe("provisional offline operation intents (real SQLite)", () => {
  it("records a signed, immutable intent atomically before any network — and changes NO projected stock", () => {
    const { harness, intents } = setup();
    const stockBefore = harness.sales.getProjectedInventory();
    const accepted = intents.recordIntent(receive(4));

    expect(accepted.lifecycle).toBe("accepted_pending_sync");
    const row = harness.database.connection
      .prepare(
        "SELECT canonical_command, payload_hash, signature_base64, request_json, state FROM intent_outbox",
      )
      .get() as Record<string, string>;
    expect(row.state).toBe("pending");
    const request = JSON.parse(row.request_json) as { command: unknown };
    // Canonical bytes are the SDK canonicalizer's, the hash binds them, and the device key verifies.
    expect(row.canonical_command).toBe(canonicalizeOfflineIntentCommand(request.command));
    expect(row.payload_hash).toBe(
      createHash("sha256").update(row.canonical_command, "utf8").digest("hex"),
    );
    const publicKey = createPublicKey({
      key: Buffer.from(harness.keys.ensureKey().value, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(row.canonical_command),
        publicKey,
        Buffer.from(row.signature_base64, "base64"),
      ),
    ).toBe(true);
    // The local stock projection is untouched: an offline receive is never canonical stock.
    expect(harness.sales.getProjectedInventory()).toEqual(stockBefore);
    expect(intents.getLocalIntents()).toMatchObject({ pending: 1 });
  });

  it("refuses operations the grant does not enable, invalid payloads and unknown dependencies with no partial write", () => {
    const { harness, intents } = setup();
    expect(() =>
      intents.recordIntent({
        operation: "settings.change_request",
        subjectId: null,
        baseVersion: null,
        dependsOnSyncCommandId: null,
        payload: { settingKey: "receipt.footer", requestedValue: "x", reason: "y" },
      }),
    ).toThrow(/not enabled/);
    expect(() =>
      intents.recordIntent({ ...receive(), payload: { variantId: ids.variant, quantity: 0 } }),
    ).toThrow(/invalid/);
    expect(() =>
      intents.recordIntent({
        ...receive(),
        dependsOnSyncCommandId: "40000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/unknown local intent/);
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM local_intent")).toBe(0);
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM intent_outbox")).toBe(0);
  });

  it("enables nothing when the server policy carries no intent operations (older server ⇒ online-only)", () => {
    const fixture = bootstrapFixture();
    const { intents } = setup({
      bootstrap: { ...fixture, policy: { ...fixture.policy, intentOperations: [] } },
    });
    expect(intents.getLocalIntents().enabledOperations).toEqual([]);
    expect(() => intents.recordIntent(receive())).toThrow(/not enabled/);
  });

  it("fails closed when the grant has expired (no lease bypass)", () => {
    const { intents } = setup({ now: () => new Date("2026-09-09T12:00:00.000Z") });
    expect(() => intents.recordIntent(receive())).toThrow();
  });

  it("keeps intent facts and the signed command immutable", () => {
    const { harness, intents } = setup();
    intents.recordIntent(receive());
    expect(() =>
      harness.database.connection.exec("UPDATE local_intent SET payload_json = '{}'"),
    ).toThrow(/immutable/);
    expect(() =>
      harness.database.connection.exec("UPDATE intent_outbox SET request_json = '{}'"),
    ).toThrow(/immutable/);
    expect(() => harness.database.connection.exec("DELETE FROM intent_outbox")).toThrow(
      /immutable/,
    );
  });

  it("syncs exactly the persisted command, stores the server's automatic disposition, and replays the same identity after a transient failure", async () => {
    const { harness, intents, intentOutbox } = setup();
    const accepted = intents.recordIntent(receive());
    const keys: string[] = [];
    let fail = true;
    const sync = worker(harness, intentOutbox, async (item) => {
      keys.push(item.idempotencyKey);
      if (fail) {
        fail = false;
        throw new ApiNetworkError("offline");
      }
      return received(item.localIntentId);
    });
    await sync.requestRun();
    expect(intentOutbox.getStatusCounts()).toMatchObject({ retryWait: 1, received: 0 });
    // Make the retry due now and run again.
    harness.database.connection.exec(
      "UPDATE intent_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'",
    );
    await sync.requestRun();
    expect(keys).toEqual([accepted.syncCommandId, accepted.syncCommandId]);
    expect(intentOutbox.getStatusCounts()).toMatchObject({ pending: 0, received: 1 });
    expect(intents.getLocalIntents().recent[0]).toMatchObject({
      lifecycle: "received",
      outboxState: "delivered",
      disposition: "applied",
      dispositionCode: "OIA_STOCK_POSTED",
    });
    // The local record of the server decision is write-once.
    expect(() =>
      harness.database.connection.exec(
        "UPDATE local_intent SET server_disposition = 'rejected', server_disposition_code = 'X'",
      ),
    ).toThrow(/disposition is immutable/);
    // Projected (advisory) stock on the till is never changed by an intent, even an applied one.
  });

  it("maps every automatic server disposition to an honest review status; none waits for a person", async () => {
    const cases: Array<[Disposition, string, string]> = [
      ["applied", "OIA_STOCK_POSTED", "accepted"],
      ["rejected", "OIX_OVER_LIMIT", "rejected"],
      ["needs_reconciliation", "OIX_STALE_BASE", "needs_review"],
      ["blocked_policy", "OIP_POLICY_NOT_CONFIGURED", "policy_blocked"],
    ];
    for (const [disposition, code, status] of cases) {
      const { harness, intents, intentOutbox, review } = setup();
      const accepted = intents.recordIntent(receive());
      const sync = worker(harness, intentOutbox, async (item) =>
        received(item.localIntentId, "inventory.receive", disposition, code),
      );
      await sync.requestRun();
      const item = review.list().find((entry) => entry.syncCommandId === accepted.syncCommandId)!;
      expect(item.status).toBe(status);
      // A server decision can never be retried, edited or escalated from the till.
      expect(item.allowedActions).toEqual([]);
      expect(item.evidence).toEqual(
        expect.arrayContaining([{ key: "serverOutcome", value: code }]),
      );
      const attention = review.list({ status: "attention" }).length;
      expect(attention).toBe(disposition === "applied" ? 0 : 1);
    }
  });

  it("keeps the server disposition across a process restart (durable, restart-safe reconciliation)", async () => {
    const { harness, intents, intentOutbox } = setup();
    const accepted = intents.recordIntent(receive());
    await worker(harness, intentOutbox, async (item) =>
      received(item.localIntentId, "inventory.receive", "needs_reconciliation", "OIX_STALE_BASE"),
    ).requestRun();
    harness.database.close();
    const reopened = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), {
      now: NOW,
    });
    try {
      const reviewAfter = new OfflineReviewService(reopened, undefined, NOW);
      const item = reviewAfter
        .list({ lane: "intent" })
        .find((entry) => entry.syncCommandId === accepted.syncCommandId)!;
      expect(item.status).toBe("needs_review");
      expect(item.allowedActions).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("never sends a child intent before its parent is delivered (dependency ordering)", async () => {
    const { harness, intents, intentOutbox } = setup();
    const parent = intents.recordIntent(receive());
    intents.recordIntent({
      operation: "inventory.count",
      subjectId: ids.variant,
      baseVersion: null,
      dependsOnSyncCommandId: parent.syncCommandId,
      payload: {
        variantId: ids.variant,
        countedQuantity: 3,
        observedAdvisoryQuantity: 2,
        note: null,
      },
    });
    const sent: string[] = [];
    const sync = worker(harness, intentOutbox, async (item) => {
      sent.push(item.syncCommandId);
      if (item.syncCommandId === parent.syncCommandId)
        throw httpRejection(403, "OFFLINE_INTENT_DISABLED");
      return received(item.localIntentId, "inventory.count");
    });
    await sync.requestRun();
    // Parent blocked ⇒ the child is held locally (still queued), never sent ahead of it.
    expect(sent).toEqual([parent.syncCommandId]);
    expect(intentOutbox.getStatusCounts()).toMatchObject({ blocked: 1, pending: 1 });
  });

  it("recovers after a restart: the queued intent is still there and replays its original identity", async () => {
    const { harness, intents } = setup();
    const accepted = intents.recordIntent(receive());
    // Re-open a fresh service + store over the same file (simulated restart).
    const reopened = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), {
      now: NOW,
    });
    try {
      const store = new IntentOutboxStore(reopened, NOW);
      const claimed = store.claimNext(30_000);
      expect(claimed?.syncCommandId).toBe(accepted.syncCommandId);
      expect(claimed?.idempotencyKey).toBe(accepted.syncCommandId);
    } finally {
      reopened.close();
    }
  });

  it("validates intent IPC input structurally in main", () => {
    expect(() => parseOfflineIntentInput({ operation: "inventory.delete", payload: {} })).toThrow();
    expect(() =>
      parseOfflineIntentInput({ operation: "inventory.receive", payload: [] }),
    ).toThrow();
    expect(
      parseOfflineIntentInput({ operation: "inventory.receive", payload: { variantId: "x" } }),
    ).toMatchObject({ subjectId: null, dependsOnSyncCommandId: null });
    expect(() => parseReviewQuery({ lane: "everything" })).toThrow();
    expect(() =>
      parseReviewResolutionInput({
        actionId: "a",
        lane: "sale",
        syncCommandId: "s",
        requestKind: "delete_it",
        note: "n",
      }),
    ).toThrow();
  });
});

describe("review / reconciliation center (real SQLite)", () => {
  async function blockedIntent() {
    const context = setup();
    const accepted = context.intents.recordIntent(receive());
    const sync = worker(context.harness, context.intentOutbox, async () => {
      throw httpRejection(403, "OFFLINE_INTENT_DISABLED");
    });
    await sync.requestRun();
    return { ...context, accepted };
  }

  it("lists every lane's command with an honest status, safe evidence and allowed actions", async () => {
    const { review, accepted } = await blockedIntent();
    const items = review.list({ status: "attention" });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      lane: "intent",
      syncCommandId: accepted.syncCommandId,
      label: "inventory.receive",
      status: "blocked",
      lastErrorCode: "OFFLINE_INTENT_DISABLED",
    });
    expect(item.allowedActions).toEqual(["retry"]);
    // Evidence never contains signatures, keys or canonical bytes.
    expect(JSON.stringify(item)).not.toMatch(/signature|BEGIN|canonical/i);
    expect(review.list({ search: accepted.syncCommandId.slice(0, 8) })).toHaveLength(1);
    expect(review.list({ lane: "sale" })).toHaveLength(0);
  });

  it("retries a blocked command exactly (same signed bytes), idempotently by actionId, and audits it", async () => {
    const { harness, review, accepted } = await blockedIntent();
    const before = harness.database.connection
      .prepare("SELECT request_json, payload_hash FROM intent_outbox")
      .get();
    const first = review.retry({
      actionId: "act-1",
      lane: "intent",
      syncCommandId: accepted.syncCommandId,
    });
    const again = review.retry({
      actionId: "act-1",
      lane: "intent",
      syncCommandId: accepted.syncCommandId,
    });
    expect(first.outcome).toBe("requeued");
    expect(again).toEqual(first);
    expect(
      harness.database.connection
        .prepare("SELECT request_json, payload_hash FROM intent_outbox")
        .get(),
    ).toEqual(before);
    expect(review.list()[0]!.status).toBe("retry_wait");
    // A non-blocked command cannot be retried; the refusal itself is audited.
    const refused = review.retry({
      actionId: "act-2",
      lane: "intent",
      syncCommandId: accepted.syncCommandId,
    });
    expect(refused.outcome).toBe("refused");
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM review_action")).toBe(2);
    expect(() => harness.database.connection.exec("DELETE FROM review_action")).toThrow(
      /append-only/,
    );
    // Reusing an action id for a different action is rejected.
    expect(() =>
      review.requestResolution({
        actionId: "act-1",
        lane: "intent",
        syncCommandId: accepted.syncCommandId,
        requestKind: "investigate",
        note: "x",
      }),
    ).toThrow(/already used/);
  });

  it("never creates a manager/human approval request: the retired action is refused, audited, and queues nothing", async () => {
    const { harness, review, accepted } = await blockedIntent();
    const result = review.requestResolution({
      actionId: "res-1",
      lane: "intent",
      syncCommandId: accepted.syncCommandId,
      requestKind: "confirm_physical_evidence",
      note: "Delivery note DN-7 is in the drawer",
    });
    expect(result.outcome).toBe("refused");
    expect(result.relatedSyncCommandId).toBeNull();
    // Nothing new was signed or queued; the original stays exactly as captured.
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM intent_outbox")).toBe(1);
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM local_intent")).toBe(1);
    const original = review.list().find((item) => item.syncCommandId === accepted.syncCommandId)!;
    expect(original.status).toBe("blocked");
    expect(original.allowedActions).toEqual(["retry"]);
    // Idempotent by action id.
    expect(
      review.requestResolution({
        actionId: "res-1",
        lane: "intent",
        syncCommandId: accepted.syncCommandId,
        requestKind: "confirm_physical_evidence",
        note: "Delivery note DN-7 is in the drawer",
      }),
    ).toEqual(result);
    expect(count(harness.database, "SELECT COUNT(*) AS c FROM review_action")).toBe(1);
  });

  it("covers sale-lane items: a queued offline sale is visible as queued with no actions", () => {
    const { harness, review } = setup();
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 100_000,
    });
    const sale = review.list({ lane: "sale" });
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ status: "queued", allowedActions: [] });
  });
});
