// ADR-042 §6.1 / owner D-5: when the offline authority (grant accepted_until / operator lease) has expired,
// EVERY daily offline operation on the till must fail closed before writing anything — sale, installment,
// new customer, customer paydown, attendance, voucher preview — and the admin-credential roster must stop
// offering approvers. Real SQLite via the shared harness; the clock is moved past the fixture's lease.
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OfflineAcceptanceError } from "../../src/main/offline/offline-service";
import {
  OverrideRosterStore,
  deriveOverrideDeviceVerifierForTest,
} from "../../src/main/offline/override-roster";
import { ids, makeHarness, TestSecureStorage, type OfflineHarness } from "./fixtures";

// bootstrapFixture(): acceptedUntil / operatorExpiresAt / catalogValidUntil = 2026-09-08T20:00:00Z.
let clock = new Date("2026-09-08T12:00:00.000Z");
const now = () => clock;
const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  clock = new Date("2026-09-08T12:00:00.000Z");
});

const tables = [
  "local_sale",
  "outbox",
  "local_customer",
  "customer_outbox",
  "local_customer_payment",
  "payment_outbox",
  "local_attendance_event",
  "local_customer_dependency",
];

function counts(harness: OfflineHarness) {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      Number(
        (
          harness.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ),
    ]),
  );
}

describe("offline authority expiry (lease) fails every operation closed", () => {
  it("before expiry the operations work; one second after expiry every one is refused with nothing written", () => {
    const harness = makeHarness({ now });
    harnesses.push(harness);
    const customer = harness.sales.acceptNewCustomer({ name: "Before", phone: "+201005550001" });
    expect(customer.localCustomerId).toBeTruthy();

    clock = new Date("2026-09-08T20:00:01.000Z");
    expect(harness.sales.getReadiness()).toMatchObject({ ready: false });
    const before = counts(harness);
    const attempts: Array<[string, () => unknown]> = [
      [
        "sale",
        () =>
          harness.sales.acceptCashSale({
            lines: [{ variantId: ids.variant, quantity: 1 }],
            cashReceivedMinor: 5_000,
          }),
      ],
      [
        "installment",
        () =>
          harness.sales.acceptCashSale({
            lines: [{ variantId: ids.variant, quantity: 1 }],
            cashReceivedMinor: 1_000,
            amountPaidMinor: 1_000,
            customerId: ids.customer,
          }),
      ],
      [
        "new customer",
        () => harness.sales.acceptNewCustomer({ name: "After", phone: "+201005550002" }),
      ],
      [
        "paydown",
        () => harness.sales.recordCustomerPayment({ customerId: ids.customer, amountMinor: 100 }),
      ],
      ["attendance", () => harness.sales.recordAttendanceEvent({ eventType: "clock_in" })],
      [
        "voucher preview",
        () =>
          harness.sales.previewVoucher({
            lines: [{ variantId: ids.variant, quantity: 1 }],
            code: "SAVE10",
          } as never),
      ],
    ];
    for (const [name, attempt] of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(OfflineAcceptanceError);
    }
    expect(counts(harness)).toEqual(before);
  });

  it("the admin-credential roster expires with the lease: no approver offered, the right password is refused", () => {
    const harness = makeHarness({ now });
    harnesses.push(harness);
    const file = path.join(harness.directory, "override-roster.sealed");
    const roster = new OverrideRosterStore(file, new TestSecureStorage(), now);
    roster.install(ids.grant, ids.device, [
      {
        membershipId: "10000000-0000-4000-8000-0000000000aa",
        username: "boss",
        displayName: "The Boss",
        permissions: ["promotions.manage", "payments.refund"],
        verifierVersion: 1,
        verifier: deriveOverrideDeviceVerifierForTest({
          password: "Blue-Harbour-71",
          deviceId: ids.device,
          membershipId: "10000000-0000-4000-8000-0000000000aa",
          verifierVersion: 1,
          n: 1024,
        }),
        // Bootstrap sets expiresAt = accepted_until.
        expiresAt: "2026-09-08T20:00:00.000Z",
      },
    ]);
    expect(roster.listApprovers("payments.refund")).toHaveLength(1);
    clock = new Date("2026-09-08T20:00:01.000Z");
    expect(roster.listApprovers("payments.refund")).toEqual([]);
    expect(
      roster.check({
        username: "boss",
        password: "Blue-Harbour-71",
        permission: "payments.refund",
        commandId: "c",
      }),
    ).toMatchObject({ ok: false, reason: "NOT_AUTHORIZED" });
  });
});
