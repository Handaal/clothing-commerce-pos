// Offline new customer -> installment sale / paydown, with a durable dependency (local schema v19).
// Real SQLite (node:sqlite via LocalDatabase), real outbox stores and the real sync worker; only the HTTP
// transport is a test double that records the order in which commands reach "the server".
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CUSTOMER_DEPENDENCY_MISMATCH,
  CUSTOMER_DEPENDENCY_REJECTED,
  CustomerOutboxStore,
} from "../../src/main/offline/customer-outbox-store";
import { LocalDatabase } from "../../src/main/offline/database";
import { OfflineSaleService } from "../../src/main/offline/offline-service";
import { OutboxStore } from "../../src/main/offline/outbox-store";
import { PaymentOutboxStore } from "../../src/main/offline/payment-outbox-store";
import { OfflineSyncWorker, type OfflineDeliveryClient } from "../../src/main/offline/sync-worker";
import { ids, ingestionResponse, makeHarness, type OfflineHarness } from "./fixtures";

const { ApiHttpError, ApiNetworkError } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as {
  ApiHttpError: new (message: string, status: number, code: string, details: unknown) => Error;
  ApiNetworkError: new (message: string) => Error;
};

let clock = new Date("2026-09-08T12:00:00.000Z");
const now = () => clock;
const harnesses: OfflineHarness[] = [];
// Connections re-opened by restart(); closed before the harness removes its temp directory.
const reopened: LocalDatabase[] = [];
afterEach(() => {
  for (const database of reopened.splice(0)) {
    database.close();
  }
  // LocalDatabase.close() is idempotent, so disposing after restart() closed the original is safe.
  for (const harness of harnesses.splice(0)) harness.dispose();
  clock = new Date("2026-09-08T12:00:00.000Z");
});

function fresh(saleTestSeam?: ConstructorParameters<typeof OfflineSaleService>[3]) {
  const harness = makeHarness({ now, saleTestSeam });
  harnesses.push(harness);
  return harness;
}

/** Re-open the same SQLite file as a restarted process would (no in-memory state survives). */
function restart(harness: OfflineHarness) {
  const previous = reopened.at(-1) ?? harness.database;
  previous.close();
  const database = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), { now });
  reopened.push(database);
  return {
    database,
    sales: new OfflineSaleService(database, harness.keys, now),
    outbox: new OutboxStore(database, now),
    payments: new PaymentOutboxStore(database, now),
    customers: new CustomerOutboxStore(database, now),
  };
}

const count = (database: LocalDatabase, sql: string, ...args: string[]) =>
  Number((database.connection.prepare(sql).get(...args) as { n: number }).n);

interface ServerLog {
  order: string[];
  customerIds: Map<string, string>;
}

function fakeServer(
  log: ServerLog,
  behaviour: {
    customer?: (attempt: number) => "accept" | "lost" | "reject" | "mismatch" | "duplicate";
  } = {},
): OfflineDeliveryClient {
  let customerAttempts = 0;
  return {
    async deliverCustomer(item) {
      customerAttempts += 1;
      const mode = behaviour.customer?.(customerAttempts) ?? "accept";
      const command = JSON.parse(item.requestJson).command;
      if (mode === "reject") {
        throw new ApiHttpError("customer phone must be E.164", 422, "OFFLINE_INPUT_INVALID", null);
      }
      log.order.push(`customer:${command.localCustomerId}`);
      const customerId =
        mode === "mismatch" ? "30000000-0000-4000-8000-0000000000ee" : command.localCustomerId;
      log.customerIds.set(command.localCustomerId, customerId);
      if (mode === "lost") throw new ApiNetworkError("response lost after commit");
      return {
        ingestionId: "30000000-0000-4000-8000-000000000001",
        localCustomerId: command.localCustomerId,
        customerId,
        duplicateOfCustomerId: mode === "duplicate" ? ids.customer : null,
        receivedAt: clock.toISOString(),
      };
    },
    async deliver(item) {
      const command = JSON.parse(item.requestJson).command;
      // The real server answers OG404 for an installment whose customer does not exist yet.
      if (command.customerId && !log.customerIds.has(command.customerId)) {
        throw new ApiHttpError("customer not found", 404, "OFFLINE_GRANT_NOT_FOUND", null);
      }
      log.order.push(`sale:${command.localSaleId}`);
      return ingestionResponse(command.localSaleId);
    },
    async deliverPayment(item) {
      const command = JSON.parse(item.requestJson).command;
      if (!log.customerIds.has(command.customerId)) {
        throw new ApiHttpError("customer not found", 404, "OFFLINE_GRANT_NOT_FOUND", null);
      }
      log.order.push(`payment:${command.localPaymentId}`);
      return {
        ingestionId: "30000000-0000-4000-8000-000000000002",
        localPaymentId: command.localPaymentId,
        syncStatus: "synced",
        receivedAt: clock.toISOString(),
        payment: { id: "30000000-0000-4000-8000-000000000003", outstandingMinor: 1_099 },
      } as never;
    },
    async deliverAttendance() {
      throw new Error("not used");
    },
    async deliverReturn() {
      throw new Error("not used");
    },
  };
}

function worker(harness: { database: LocalDatabase }, delivery: OfflineDeliveryClient) {
  return new OfflineSyncWorker(new OutboxStore(harness.database, now), delivery, {
    now,
    paymentOutbox: new PaymentOutboxStore(harness.database, now),
    customerOutbox: new CustomerOutboxStore(harness.database, now),
  });
}

function installment(sales: OfflineSaleService, customerId: string) {
  // Total 2 599; 1 000 deposit by card (recorded, not settled offline) => 1 599 debt.
  return sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 0,
    amountPaidMinor: 1_000,
    customerId,
    tenders: [{ method: "card", amountMinor: 1_000 }],
  });
}

describe("offline new customer -> installment sale (dependency, real SQLite)", () => {
  it("rings an installment for a just-created customer: one transaction, dependency recorded, sale not claimable yet", () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Omar Adel", phone: "+201005550101" });
    const listed = harness.sales
      .getOfflineCustomers()
      .find((c) => c.customerId === customer.localCustomerId);
    expect(listed).toMatchObject({
      createdOffline: true,
      pendingSync: true,
      projectedOutstandingMinor: 0,
    });

    const sale = installment(harness.sales, customer.localCustomerId);
    expect(sale.outstandingMinor).toBe(1_599);
    const dependency = harness.database.connection
      .prepare("SELECT * FROM local_customer_dependency")
      .get() as Record<string, string>;
    expect(dependency).toMatchObject({
      dependent_lane: "sale",
      dependent_sync_command_id: sale.syncCommandId,
      local_customer_id: customer.localCustomerId,
      state: "waiting",
      customer_display_name: "Omar Adel",
      customer_phone_last4: "0101",
    });
    // The signed sale names the stable local id and preserves the true tender (card, recorded only).
    const request = JSON.parse(
      (
        harness.database.connection.prepare("SELECT request_json FROM outbox").get() as {
          request_json: string;
        }
      ).request_json,
    );
    expect(request.command).toMatchObject({
      customerId: customer.localCustomerId,
      amountPaidMinor: 1_000,
      outstandingMinor: 1_599,
      tenders: [{ method: "card", amountMinor: 1_000 }],
    });
    expect(harness.outbox.claimNext(30_000)).toBeNull();
    expect(
      harness.sales.getOfflineCustomers().find((c) => c.customerId === customer.localCustomerId)
        ?.projectedOutstandingMinor,
    ).toBe(1_599);
  });

  it("a crash inside the sale transaction (after the dependency, before the outbox) leaves nothing behind", () => {
    const harness = fresh({
      afterStage(stage) {
        if (stage === "dependency") throw new Error("power cut");
      },
    });
    const customer = harness.sales.acceptNewCustomer({ name: "Mona", phone: "+201005550102" });
    expect(() => installment(harness.sales, customer.localCustomerId)).toThrow("power cut");
    expect(count(harness.database, "SELECT COUNT(*) AS n FROM local_sale")).toBe(0);
    expect(count(harness.database, "SELECT COUNT(*) AS n FROM local_customer_dependency")).toBe(0);
    expect(count(harness.database, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
    // The customer itself (an earlier, committed transaction) is intact.
    expect(count(harness.database, "SELECT COUNT(*) AS n FROM customer_outbox")).toBe(1);
  });

  it("survives a restart at every boundary and syncs customer FIRST, then the sale and the paydown with the same id", async () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Omar Adel", phone: "+201005550101" });
    // Boundary 1: restart after the customer, before the sale.
    let live = restart(harness);
    const sale = installment(live.sales, customer.localCustomerId);
    // Boundary 2: restart after the sale, before any sync.
    live = restart(harness);
    const payment = live.sales.recordCustomerPayment({
      customerId: customer.localCustomerId,
      amountMinor: 500,
    });
    expect(payment.projectedOutstandingMinor).toBe(1_099);
    // Boundary 3: restart with both dependents waiting.
    live = restart(harness);
    expect(
      count(
        live.database,
        "SELECT COUNT(*) AS n FROM local_customer_dependency WHERE state = 'waiting'",
      ),
    ).toBe(2);

    const log: ServerLog = { order: [], customerIds: new Map() };
    await worker(live, fakeServer(log)).requestRun();
    expect(log.order).toEqual([
      `customer:${customer.localCustomerId}`,
      `sale:${sale.localSaleId}`,
      `payment:${payment.localPaymentId}`,
    ]);
    expect(
      live.database.connection
        .prepare(
          "SELECT state, canonical_customer_id FROM local_customer_dependency ORDER BY dependent_lane",
        )
        .all(),
    ).toEqual([
      { state: "ready", canonical_customer_id: customer.localCustomerId },
      { state: "ready", canonical_customer_id: customer.localCustomerId },
    ]);
    // Profile retained after the accepting pass …
    expect(
      count(live.database, "SELECT COUNT(*) AS n FROM local_customer WHERE lifecycle = 'synced'"),
    ).toBe(1);
    // … and cleared at the NEXT successful sync, with the outbox copy redacted; the audit snapshot stays.
    clock = new Date("2026-09-08T12:05:00.000Z");
    live = restart(harness);
    await worker(live, fakeServer(log)).requestRun();
    expect(count(live.database, "SELECT COUNT(*) AS n FROM local_customer")).toBe(0);
    const outboxRow = live.database.connection
      .prepare("SELECT request_json, canonical_command, redacted_at, state FROM customer_outbox")
      .get() as Record<string, string>;
    expect(outboxRow).toMatchObject({ request_json: '{"redacted":true}', state: "delivered" });
    expect(outboxRow.redacted_at).toBeTruthy();
    expect(JSON.stringify(outboxRow)).not.toContain("+201005550101");
    expect(
      live.database.connection
        .prepare(
          "SELECT customer_display_name, customer_phone_last4 FROM local_customer_dependency LIMIT 1",
        )
        .get(),
    ).toEqual({ customer_display_name: "Omar Adel", customer_phone_last4: "0101" });
  });

  it("a lost response after the server committed the customer: the sale still waits, then the exact replay unblocks it", async () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Omar", phone: "+201005550101" });
    const sale = installment(harness.sales, customer.localCustomerId);
    const log: ServerLog = { order: [], customerIds: new Map() };
    const delivery = fakeServer(log, {
      customer: (attempt) => (attempt === 1 ? "lost" : "accept"),
    });
    await worker(harness, delivery).requestRun();
    // The server has the customer, but the till never learned it: the sale must not be sent yet.
    expect(log.order).toEqual([`customer:${customer.localCustomerId}`]);
    expect(
      count(
        harness.database,
        "SELECT COUNT(*) AS n FROM local_customer_dependency WHERE state='waiting'",
      ),
    ).toBe(1);
    clock = new Date("2026-09-08T12:10:00.000Z");
    const live = restart(harness);
    await worker(live, delivery).requestRun();
    expect(log.order.slice(1)).toEqual([
      `customer:${customer.localCustomerId}`,
      `sale:${sale.localSaleId}`,
    ]);
  });

  it("a customer the server rejects holds the sale and paydown with deterministic evidence; nothing is sent or relinked", async () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Omar", phone: "+201005550101" });
    const sale = installment(harness.sales, customer.localCustomerId);
    const payment = harness.sales.recordCustomerPayment({
      customerId: customer.localCustomerId,
      amountMinor: 100,
    });
    const log: ServerLog = { order: [], customerIds: new Map() };
    await worker(harness, fakeServer(log, { customer: () => "reject" })).requestRun();
    expect(log.order).toEqual([]);
    const live = restart(harness);
    expect(
      live.database.connection
        .prepare("SELECT state, hold_code FROM local_customer_dependency ORDER BY dependent_lane")
        .all(),
    ).toEqual([
      { state: "held_customer_rejected", hold_code: CUSTOMER_DEPENDENCY_REJECTED },
      { state: "held_customer_rejected", hold_code: CUSTOMER_DEPENDENCY_REJECTED },
    ]);
    expect(
      live.database.connection
        .prepare("SELECT state, last_error_code FROM outbox WHERE sync_command_id = ?")
        .get(sale.syncCommandId),
    ).toEqual({ state: "blocked", last_error_code: CUSTOMER_DEPENDENCY_REJECTED });
    expect(
      live.database.connection
        .prepare("SELECT state, last_error_code FROM payment_outbox WHERE sync_command_id = ?")
        .get(payment.syncCommandId),
    ).toEqual({ state: "blocked", last_error_code: CUSTOMER_DEPENDENCY_REJECTED });
    // Evidence retained: the sale, its lines and tender stay on the till; the resolution is write-once.
    expect(count(live.database, "SELECT COUNT(*) AS n FROM local_sale")).toBe(1);
    expect(() =>
      live.database.connection
        .prepare("UPDATE local_customer_dependency SET state = 'ready'")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      live.database.connection.prepare("DELETE FROM local_customer_dependency").run(),
    ).toThrow(/retained/);
    // The rejected customer can no longer be chosen for another installment.
    expect(() => installment(live.sales, customer.localCustomerId)).toThrow(/known customer/);
    // A later pass still sends nothing for them.
    await worker(live, fakeServer(log)).requestRun();
    expect(log.order).toEqual([]);
  });

  it("a server-accepted id that differs from the till's id is held, never relinked", async () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Omar", phone: "+201005550101" });
    const sale = installment(harness.sales, customer.localCustomerId);
    const log: ServerLog = { order: [], customerIds: new Map() };
    await worker(harness, fakeServer(log, { customer: () => "mismatch" })).requestRun();
    expect(log.order).toEqual([`customer:${customer.localCustomerId}`]);
    expect(
      harness.database.connection
        .prepare("SELECT state, hold_code, canonical_customer_id FROM local_customer_dependency")
        .get(),
    ).toEqual({
      state: "held_customer_mismatch",
      hold_code: CUSTOMER_DEPENDENCY_MISMATCH,
      canonical_customer_id: "30000000-0000-4000-8000-0000000000ee",
    });
    expect(
      harness.database.connection
        .prepare("SELECT state FROM outbox WHERE sync_command_id = ?")
        .get(sale.syncCommandId),
    ).toEqual({ state: "blocked" });
  });

  it("a duplicate phone is flagged on the till but never merged: the sale goes to the customer the cashier created", async () => {
    const harness = fresh();
    const customer = harness.sales.acceptNewCustomer({ name: "Layla H", phone: "+201000000000" });
    const sale = installment(harness.sales, customer.localCustomerId);
    const log: ServerLog = { order: [], customerIds: new Map() };
    await worker(harness, fakeServer(log, { customer: () => "duplicate" })).requestRun();
    expect(log.order).toEqual([`customer:${customer.localCustomerId}`, `sale:${sale.localSaleId}`]);
    expect(
      harness.database.connection
        .prepare("SELECT duplicate_of_customer_id FROM local_customer")
        .get(),
    ).toEqual({ duplicate_of_customer_id: ids.customer });
    const sent = JSON.parse(
      (
        harness.database.connection.prepare("SELECT request_json FROM outbox").get() as {
          request_json: string;
        }
      ).request_json,
    );
    expect(sent.command.customerId).toBe(customer.localCustomerId);
    expect(sent.command.customerId).not.toBe(ids.customer);
  });

  it("snapshot-customer installments are unchanged: no dependency, sent normally", async () => {
    const harness = fresh();
    const sale = installment(harness.sales, ids.customer);
    expect(count(harness.database, "SELECT COUNT(*) AS n FROM local_customer_dependency")).toBe(0);
    const log: ServerLog = { order: [], customerIds: new Map([[ids.customer, ids.customer]]) };
    await worker(harness, fakeServer(log)).requestRun();
    expect(log.order).toEqual([`sale:${sale.localSaleId}`]);
  });
});
