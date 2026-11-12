import { afterEach, describe, expect, it } from "vitest";

import { OfflineAcceptanceError } from "../../src/main/offline/offline-service";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

// The single fixture variant is priced at 2_599; one unit ⇒ a 2_599 total.
const TOTAL = 2_599;

function outboxCommand(harness: OfflineHarness): Record<string, unknown> {
  const row = harness.database.connection.prepare("SELECT request_json FROM outbox").get() as {
    request_json: string;
  };
  return (JSON.parse(row.request_json) as { command: Record<string, unknown> }).command;
}

describe("offline installments", () => {
  it("accepts a deposit now and records the remainder as the customer's debt", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 1_000,
      customerId: ids.customer,
      amountPaidMinor: 1_000,
    });
    expect(accepted).toMatchObject({
      totalMinor: TOTAL,
      amountPaidMinor: 1_000,
      outstandingMinor: TOTAL - 1_000,
    });

    const receipt = harness.sales.getLocalReceipt(accepted.localSaleId)!;
    expect(receipt).toMatchObject({
      customerId: ids.customer,
      customerName: "Layla Hassan",
      amountPaidMinor: 1_000,
      outstandingMinor: TOTAL - 1_000,
      totalMinor: TOTAL,
      cashReceivedMinor: 1_000,
      changeMinor: 0,
    });

    // The signed command carries the installment triple so the server can record the debt on sync.
    const command = outboxCommand(harness);
    expect(command).toMatchObject({
      customerId: ids.customer,
      amountPaidMinor: 1_000,
      outstandingMinor: TOTAL - 1_000,
      totalMinor: TOTAL,
    });

    // The cash tender row describes only the deposit collected now (so its constraints hold).
    const tender = harness.database.connection
      .prepare("SELECT amount_due_minor, cash_received_minor, change_minor FROM local_cash_tender")
      .get() as { amount_due_minor: number; cash_received_minor: number; change_minor: number };
    expect(tender).toEqual({
      amount_due_minor: 1_000,
      cash_received_minor: 1_000,
      change_minor: 0,
    });
  });

  it("projects the customer's running balance from locally accepted debts", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    expect(harness.sales.getOfflineCustomers()).toEqual([
      expect.objectContaining({ customerId: ids.customer, projectedOutstandingMinor: 0 }),
    ]);
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 1_000,
      customerId: ids.customer,
      amountPaidMinor: 1_000,
    });
    expect(harness.sales.getOfflineCustomers()).toEqual([
      expect.objectContaining({
        customerId: ids.customer,
        projectedOutstandingMinor: TOTAL - 1_000,
      }),
    ]);
    const readiness = harness.sales.getReadiness();
    expect(readiness.ready && readiness.offlineCreditRemainingMinor).toBe(
      200_000 - (TOTAL - 1_000),
    );
  });

  it("rejects an installment without a known snapshot customer", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    expect(() =>
      harness.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 1_000,
        amountPaidMinor: 1_000,
      }),
    ).toThrow(OfflineAcceptanceError);
    expect(() =>
      harness.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 1_000,
        customerId: "10000000-0000-4000-8000-0000000000ff",
        amountPaidMinor: 1_000,
      }),
    ).toThrow(/known customer/i);
  });

  it("rejects an installment that would breach the offline credit cap", () => {
    const base = bootstrapFixture();
    const harness = makeHarness({
      bootstrap: { ...base, policy: { ...base.policy, maxOfflineCreditExposureMinor: 1_000 } },
    });
    harnesses.push(harness);
    expect(() =>
      harness.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 1_000,
        customerId: ids.customer,
        amountPaidMinor: 1_000, // outstanding 1_599 > cap 1_000
      }),
    ).toThrow(/credit limit/i);
  });

  it("reports installments unavailable and refuses them when the grant has no credit cap", () => {
    const base = bootstrapFixture();
    const harness = makeHarness({
      bootstrap: { ...base, policy: { ...base.policy, maxOfflineCreditExposureMinor: 0 } },
    });
    harnesses.push(harness);
    const readiness = harness.sales.getReadiness();
    expect(readiness.ready && readiness.offlineInstallmentsAvailable).toBe(false);
    expect(() =>
      harness.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 1_000,
        customerId: ids.customer,
        amountPaidMinor: 1_000,
      }),
    ).toThrow(/not enabled/i);
  });

  it("records an offline paydown that reduces the projected balance and queues a signed command", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    // Open a tab first so there is a balance to pay down.
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 1_000,
      customerId: ids.customer,
      amountPaidMinor: 1_000,
    });
    expect(
      harness.sales.getOfflineCustomers().find((c) => c.customerId === ids.customer)
        ?.projectedOutstandingMinor,
    ).toBe(TOTAL - 1_000);

    const paid = harness.sales.recordCustomerPayment({
      customerId: ids.customer,
      amountMinor: 599,
    });
    expect(paid).toMatchObject({
      customerId: ids.customer,
      amountMinor: 599,
      projectedOutstandingMinor: TOTAL - 1_000 - 599,
    });
    expect(
      harness.sales.getOfflineCustomers().find((c) => c.customerId === ids.customer)
        ?.projectedOutstandingMinor,
    ).toBe(TOTAL - 1_000 - 599);

    const row = harness.database.connection
      .prepare("SELECT request_json, state FROM payment_outbox")
      .get() as { request_json: string; state: string };
    expect(row.state).toBe("pending");
    const command = (JSON.parse(row.request_json) as { command: Record<string, unknown> }).command;
    expect(command).toMatchObject({
      schemaVersion: 1,
      customerId: ids.customer,
      amountMinor: 599,
    });
  });

  it("rejects a paydown above the customer's projected balance and an unknown customer", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    // No tab yet ⇒ projected balance is 0, so any paydown exceeds it.
    expect(() =>
      harness.sales.recordCustomerPayment({ customerId: ids.customer, amountMinor: 100 }),
    ).toThrow(/exceeds/i);
    expect(() =>
      harness.sales.recordCustomerPayment({
        customerId: "10000000-0000-4000-8000-0000000000ff",
        amountMinor: 100,
      }),
    ).toThrow(OfflineAcceptanceError);
  });

  it("leaves a fully-settled sale free of any installment fields or debt", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const accepted = harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    expect(accepted).toMatchObject({ amountPaidMinor: TOTAL, outstandingMinor: 0 });

    const command = outboxCommand(harness);
    expect(command).not.toHaveProperty("customerId");
    expect(command).not.toHaveProperty("amountPaidMinor");
    expect(command).not.toHaveProperty("outstandingMinor");

    const receipt = harness.sales.getLocalReceipt(accepted.localSaleId)!;
    expect(receipt).toMatchObject({
      customerId: null,
      outstandingMinor: 0,
      amountPaidMinor: TOTAL,
    });
    expect(harness.sales.getOfflineCustomers()).toEqual([
      expect.objectContaining({ projectedOutstandingMinor: 0 }),
    ]);
  });
});
