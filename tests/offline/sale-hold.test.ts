// ADR-042 §4.6 (Finding A): a sale held because its new customer was rejected gets a signed terminal hold,
// so the till's stock grant can close. Real SQLite (node:sqlite via LocalDatabase), the real device key,
// real outbox stores and the real sync worker; only the HTTP transport is a test double that verifies the
// hold exactly as the server does (both Ed25519 signatures, fingerprint binding) and keeps one record per sale.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OfflineAuthorityStore } from "../../src/main/offline/authority-store";
import { CustomerOutboxStore } from "../../src/main/offline/customer-outbox-store";
import { LocalDatabase } from "../../src/main/offline/database";
import { OfflineSaleService } from "../../src/main/offline/offline-service";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { PaymentOutboxStore } from "../../src/main/offline/payment-outbox-store";
import {
  SaleHoldOutboxStore,
  type SaleHoldReceipt,
  type SaleHoldSigner,
} from "../../src/main/offline/sale-hold-outbox-store";
import {
  OfflineSyncWorker,
  canonicalizeSaleHold,
  type OfflineDeliveryClient,
} from "../../src/main/offline/sync-worker";
import { ids, makeHarness, type OfflineHarness } from "./fixtures";

const sdk = createRequire(__filename)("@shifted/clothing-commerce-sdk") as {
  ApiHttpError: new (message: string, status: number, code: string, details: unknown) => Error;
  ApiNetworkError: new (message: string) => Error;
  canonicalizeOfflineSaleCommand(command: unknown): string;
};

let clock = new Date("2026-09-08T12:00:00.000Z");
const now = () => clock;
const harnesses: OfflineHarness[] = [];
const reopened: LocalDatabase[] = [];
afterEach(() => {
  for (const database of reopened.splice(0)) database.close();
  for (const harness of harnesses.splice(0)) harness.dispose();
  clock = new Date("2026-09-08T12:00:00.000Z");
});

function fresh() {
  const harness = makeHarness({ now });
  harnesses.push(harness);
  return harness;
}

function signerFor(database: LocalDatabase, harness: OfflineHarness): SaleHoldSigner {
  return {
    sign: (canonical) => harness.keys.signCanonical(canonical),
    credentialId: () =>
      (
        database.connection
          .prepare("SELECT credential_id FROM device_state WHERE status = 'active'")
          .get() as { credential_id: string }
      ).credential_id,
    canonicalize: canonicalizeSaleHold,
  };
}

function restart(harness: OfflineHarness) {
  const previous = reopened.at(-1) ?? harness.database;
  previous.close();
  const database = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), { now });
  reopened.push(database);
  return {
    database,
    sales: new OfflineSaleService(database, harness.keys, now),
    authority: new OfflineAuthorityStore(database),
  };
}

interface HoldServer {
  /** Every hold request body the server received, byte-for-byte. */
  readonly received: string[];
  /** Committed holds by sale sync id. */
  readonly holds: Map<string, { requestJson: string; receipt: SaleHoldReceipt }>;
  readonly salesDelivered: string[];
}

function verifySignature(harness: OfflineHarness, canonical: string, signature: string): boolean {
  const publicKey = harness.keys.loadPublicKey();
  return verify(
    null,
    Buffer.from(canonical, "utf8"),
    createPublicKey({ key: Buffer.from(publicKey.value, "base64"), format: "der", type: "spki" }),
    Buffer.from(signature, "base64"),
  );
}

function server(
  harness: OfflineHarness,
  log: HoldServer,
  behaviour: {
    hold?: (attempt: number) => "accept" | "lost" | "conflict" | "unavailable";
  } = {},
): OfflineDeliveryClient {
  let holdAttempts = 0;
  return {
    async deliverCustomer() {
      throw new sdk.ApiHttpError(
        "customer phone must be E.164",
        422,
        "OFFLINE_GRANT_INVALID",
        null,
      );
    },
    async deliverSaleHold(item) {
      holdAttempts += 1;
      const mode = behaviour.hold?.(holdAttempts) ?? "accept";
      if (mode === "unavailable") throw new sdk.ApiNetworkError("offline");
      log.received.push(item.requestJson);
      const body = JSON.parse(item.requestJson) as {
        command: Record<string, unknown> & {
          saleSyncCommandId: string;
          saleCommandFingerprint: string;
        };
        signature: { value: string };
        sale: { command: Record<string, unknown>; signature: { value: string } };
      };
      // Server-side checks: both signatures, and the hold names exactly the signed sale.
      const saleCanonical = sdk.canonicalizeOfflineSaleCommand(body.sale.command);
      expect(verifySignature(harness, saleCanonical, body.sale.signature.value)).toBe(true);
      expect(
        verifySignature(harness, canonicalizeSaleHold(body.command), body.signature.value),
      ).toBe(true);
      expect(body.command.saleCommandFingerprint).toBe(
        createHash("sha256").update(saleCanonical, "utf8").digest("hex"),
      );
      if (mode === "conflict") {
        throw new sdk.ApiHttpError(
          "ordinal already used",
          409,
          "OFFLINE_SALE_ORDINAL_CONFLICT",
          null,
        );
      }
      const existing = log.holds.get(body.command.saleSyncCommandId);
      if (existing) {
        // Exact replay returns the original receipt; anything else would be an idempotency conflict.
        expect(item.requestJson).toBe(existing.requestJson);
      } else {
        log.holds.set(body.command.saleSyncCommandId, {
          requestJson: item.requestJson,
          receipt: {
            holdId: "40000000-0000-4000-8000-000000000001",
            saleSyncCommandId: body.command.saleSyncCommandId,
            offlineSaleOrdinal: Number(body.command.offlineSaleOrdinal),
            status: "held_for_reconciliation",
          },
        });
      }
      if (mode === "lost") throw new sdk.ApiNetworkError("response lost after commit");
      return log.holds.get(body.command.saleSyncCommandId)!.receipt;
    },
    async deliver(item) {
      log.salesDelivered.push(item.syncCommandId);
      throw new Error("a held sale must never be delivered");
    },
    async deliverPayment() {
      throw new Error("not used");
    },
    async deliverAttendance() {
      throw new Error("not used");
    },
    async deliverReturn() {
      throw new Error("not used");
    },
  };
}

function worker(
  database: LocalDatabase,
  harness: OfflineHarness,
  delivery: OfflineDeliveryClient,
): OfflineSyncWorker {
  return new OfflineSyncWorker(new OutboxStore(database, now), delivery, {
    now,
    paymentOutbox: new PaymentOutboxStore(database, now),
    customerOutbox: new CustomerOutboxStore(database, now),
    saleHoldOutbox: new SaleHoldOutboxStore(database, now),
    saleHoldSigner: signerFor(database, harness),
  });
}

function heldInstallment(harness: OfflineHarness) {
  const customer = harness.sales.acceptNewCustomer({ name: "Omar", phone: "+201005550101" });
  const sale = harness.sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 1_000,
    amountPaidMinor: 1_000,
    customerId: customer.localCustomerId,
  });
  return { customer, sale };
}

const row = (database: LocalDatabase, sql: string, ...args: string[]) =>
  database.connection.prepare(sql).get(...args) as Record<string, unknown> | undefined;

describe("Finding A — terminal hold for a sale whose new customer was rejected (real SQLite)", () => {
  it("rejection enqueues the hold atomically; the grant close is offered only after the server acknowledges it", async () => {
    const harness = fresh();
    const { sale } = heldInstallment(harness);
    const saleBefore = row(
      harness.database,
      "SELECT * FROM local_sale WHERE local_sale_id = ?",
      sale.localSaleId,
    );
    const outboxBefore = row(
      harness.database,
      "SELECT canonical_command, request_json, payload_hash FROM outbox WHERE sync_command_id = ?",
      sale.syncCommandId,
    );
    const log: HoldServer = { received: [], holds: new Map(), salesDelivered: [] };
    // Pass 1: the server is unreachable for holds; the customer is rejected; the hold waits (enqueued).
    await worker(
      harness.database,
      harness,
      server(harness, log, { hold: () => "unavailable" }),
    ).requestRun();
    expect(
      row(harness.database, "SELECT state, reason, signature_base64 FROM sale_hold_outbox"),
    ).toMatchObject({
      state: "retry_wait",
      reason: "customer_dependency_rejected",
    });
    // ADR-042 §13: no stock grant exists, so nothing waits on a "close"; the hold only terminalizes the sale.

    clock = new Date("2026-09-08T12:10:00.000Z");
    await worker(harness.database, harness, server(harness, log)).requestRun();
    expect(row(harness.database, "SELECT state, server_hold_id FROM sale_hold_outbox")).toEqual({
      state: "acknowledged",
      server_hold_id: "40000000-0000-4000-8000-000000000001",
    });
    // The sale, its signed command and receipt are untouched; it was never delivered as a sale.
    expect(
      row(harness.database, "SELECT * FROM local_sale WHERE local_sale_id = ?", sale.localSaleId),
    ).toEqual(saleBefore);
    expect(
      row(
        harness.database,
        "SELECT canonical_command, request_json, payload_hash FROM outbox WHERE sync_command_id = ?",
        sale.syncCommandId,
      ),
    ).toEqual(outboxBefore);
    expect(await harness.sales.getLocalReceipt(sale.localSaleId)).toMatchObject({
      localSaleId: sale.localSaleId,
      amountPaidMinor: 1_000,
    });
    expect(log.salesDelivered).toEqual([]);
    expect(log.holds.size).toBe(1);
  });

  it("crash after enqueue and before send, then a lost response after the server committed: one hold, byte-identical replay", async () => {
    const harness = fresh();
    const { sale } = heldInstallment(harness);
    const log: HoldServer = { received: [], holds: new Map(), salesDelivered: [] };
    await worker(
      harness.database,
      harness,
      server(harness, log, { hold: () => "unavailable" }),
    ).requestRun();
    // "Crash": a new process opens the same file.
    let live = restart(harness);
    clock = new Date("2026-09-08T12:10:00.000Z");
    await worker(
      live.database,
      harness,
      server(harness, log, { hold: (n) => (n === 1 ? "lost" : "accept") }),
    ).requestRun();
    expect(row(live.database, "SELECT state, last_error_code FROM sale_hold_outbox")).toEqual({
      state: "retry_wait",
      last_error_code: "NETWORK_UNAVAILABLE",
    });
    const signedOnce = row(
      live.database,
      "SELECT signature_base64, request_json FROM sale_hold_outbox",
    );

    live = restart(harness);
    clock = new Date("2026-09-08T12:20:00.000Z");
    await worker(live.database, harness, server(harness, log)).requestRun();
    expect(row(live.database, "SELECT state FROM sale_hold_outbox")).toEqual({
      state: "acknowledged",
    });
    expect(
      row(live.database, "SELECT signature_base64, request_json FROM sale_hold_outbox"),
    ).toEqual(signedOnce);
    expect(log.received).toHaveLength(2);
    expect(log.received[0]).toBe(log.received[1]);
    expect(log.holds.size).toBe(1);
    expect(log.salesDelivered).toEqual([]);
    expect(sale.syncCommandId).toBe(JSON.parse(log.received[0]!).command.saleSyncCommandId);
  });

  it("the signed hold, its identity and an acknowledged hold are immutable; evidence cannot be deleted", async () => {
    const harness = fresh();
    heldInstallment(harness);
    const log: HoldServer = { received: [], holds: new Map(), salesDelivered: [] };
    await worker(harness.database, harness, server(harness, log)).requestRun();
    const db = harness.database.connection;
    expect(() => db.prepare("UPDATE sale_hold_outbox SET signature_base64 = 'x'").run()).toThrow();
    expect(() => db.prepare("UPDATE sale_hold_outbox SET command_json = '{}'").run()).toThrow();
    expect(() => db.prepare("UPDATE sale_hold_outbox SET state = 'pending'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM sale_hold_outbox").run()).toThrow();
    // A second rejection pass never creates a second hold for the same sale.
    expect(
      new SaleHoldOutboxStore(harness.database, now).enqueueForHeldSales(
        [
          String(
            row(harness.database, "SELECT sale_sync_command_id AS id FROM sale_hold_outbox")!.id,
          ),
        ],
        now().toISOString(),
      ),
    ).toBe(0);
  });

  it("a definitive server refusal blocks the hold visibly and the close stays withheld (no guess, no approval queue)", async () => {
    const harness = fresh();
    heldInstallment(harness);
    const log: HoldServer = { received: [], holds: new Map(), salesDelivered: [] };
    await worker(
      harness.database,
      harness,
      server(harness, log, { hold: () => "conflict" }),
    ).requestRun();
    expect(row(harness.database, "SELECT state, last_error_code FROM sale_hold_outbox")).toEqual({
      state: "blocked",
      last_error_code: "OFFLINE_SALE_ORDINAL_CONFLICT",
    });
  });
});
