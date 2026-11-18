import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CustomerOutboxStore } from "../../src/main/offline/customer-outbox-store";
import { OfflineAcceptanceError, OfflineSaleService } from "../../src/main/offline/offline-service";
import {
  OverrideRosterStore,
  deriveOverrideDeviceVerifierForTest,
} from "../../src/main/offline/override-roster";
import { offlineVoucherDiscount } from "../../src/main/offline/voucher-discount";
import {
  bootstrapFixture,
  ids,
  makeHarness,
  TestSecureStorage,
  type OfflineHarness,
} from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const PRICE = 2_599;
const NOW = () => new Date("2026-09-08T12:00:00.000Z");
const ADMIN = "10000000-0000-4000-8000-0000000000aa";
const VOUCHER = "10000000-0000-4000-8000-0000000000bb";
const PROMOTION = "10000000-0000-4000-8000-0000000000cc";
const CODE_ID = "10000000-0000-4000-8000-0000000000dd";

function stockGrant(granted: number, enforced = true) {
  return {
    stockGrantId: "10000000-0000-4000-8000-0000000000ee",
    offlineGrantId: ids.grant,
    status: "active" as const,
    expiresAt: "2026-09-08T20:00:00.000Z",
    enforced,
    lines: [
      {
        variantId: ids.variant,
        grantedQuantity: granted,
        consumedQuantity: 0,
        releasedQuantity: 0,
      },
    ],
  };
}

function voucherGrant(
  overrides: {
    requiresAdminCredentials?: boolean;
    allowedCount?: number;
    perGrantCap?: number;
  } = {},
) {
  return {
    voucherGrantId: VOUCHER,
    promotionId: PROMOTION,
    codeId: CODE_ID,
    status: "active" as const,
    allowedCount: overrides.allowedCount ?? 2,
    consumedCount: 0,
    releasedCount: 0,
    maxDiscountPerRedemptionMinor: 1_000,
    maxDiscountPerGrantMinor: overrides.perGrantCap ?? 1_500,
    discountConsumedMinor: 0,
    requiresAdminCredentials: overrides.requiresAdminCredentials ?? false,
    calculationVersion: "ov1" as const,
    expiresAt: "2026-09-08T20:00:00.000Z",
    terms: {
      promotionId: PROMOTION,
      name: "Ten off",
      codeId: CODE_ID,
      code: "SAVE10",
      benefitType: "percentage" as const,
      benefitPercentBp: 1_000,
      benefitAmountMinor: null,
      benefitCurrency: null,
      targetType: "order" as const,
      minSubtotalMinor: null,
      maxDiscountMinor: null,
      endsAt: null,
      targetProductIds: [],
      targetVariantIds: [],
    },
  };
}

function harnessWith(extra: Record<string, unknown>): {
  harness: OfflineHarness;
  sales: OfflineSaleService;
  roster: OverrideRosterStore;
} {
  const harness = makeHarness({
    now: NOW,
    bootstrap: { ...bootstrapFixture(), ...extra } as never,
  });
  harnesses.push(harness);
  const roster = new OverrideRosterStore(
    path.join(harness.directory, "override-roster.sealed"),
    new TestSecureStorage(),
    NOW,
  );
  const sales = new OfflineSaleService(harness.database, harness.keys, NOW, undefined, roster);
  return { harness, sales, roster };
}

function sell(sales: OfflineSaleService, quantity: number, extra: Record<string, unknown> = {}) {
  return sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity }],
    cashReceivedMinor: PRICE * quantity,
    ...extra,
  });
}

function installAdmin(
  roster: OverrideRosterStore,
  permissions: Array<"promotions.manage" | "payments.refund">,
) {
  roster.install(ids.grant, ids.device, [
    {
      membershipId: ADMIN,
      username: "Boss",
      displayName: "The Boss",
      permissions,
      verifierVersion: 2,
      verifier: deriveOverrideDeviceVerifierForTest({
        password: "Blue-Harbour-71",
        deviceId: ids.device,
        membershipId: ADMIN,
        verifierVersion: 2,
        n: 1024,
      }),
      expiresAt: "2026-09-08T20:00:00.000Z",
    },
  ]);
}

// ADR-042 §13 (owner decision 2026-11-14 night): ONE shared stock pool, no per-till stock grant. Offline the
// till sells against its LOCAL ESTIMATE (advisory snapshot 10 minus its own unsynced lines). A stock-grant
// payload from an older server is ignored entirely.
describe("ADR-042 §13 shared stock — local estimate, no stock grant", () => {
  it("ignores a stale stock-grant payload: an 'enforced' 1-unit grant does not cap selling", () => {
    const { harness, sales } = harnessWith({ stockGrant: stockGrant(1, true) });
    sell(sales, 3);
    expect(
      Number(
        (
          harness.database.connection
            .prepare("SELECT COUNT(*) AS n FROM offline_stock_grant")
            .get() as { n: number }
        ).n,
      ),
    ).toBe(0);
  });

  it("same-till local depletion: the estimate falls with each unsynced sale and refuses an obvious oversell", () => {
    const { sales } = harnessWith({ stockGrant: null });
    sell(sales, 4);
    sell(sales, 4);
    expect(() => sell(sales, 3)).toThrow(
      expect.objectContaining({ code: "PROJECTED_STOCK_INSUFFICIENT" }),
    );
    sell(sales, 2); // exactly the remaining estimate (10 - 8)
    expect(() => sell(sales, 1)).toThrow(
      expect.objectContaining({ code: "PROJECTED_STOCK_INSUFFICIENT" }),
    );
  });
});

describe("ADR-042 §5 offline vouchers", () => {
  it("matches the server ov1 formula", () => {
    const terms = voucherGrant().terms;
    expect(
      offlineVoucherDiscount(terms, [{ variantId: "v", productId: "p", lineTotalMinor: 5_198 }]),
    ).toBe(519);
    expect(
      offlineVoucherDiscount({ ...terms, maxDiscountMinor: 300 }, [
        { variantId: "v", productId: "p", lineTotalMinor: 5_198 },
      ]),
    ).toBe(300);
    expect(
      offlineVoucherDiscount({ ...terms, minSubtotalMinor: 9_000 }, [
        { variantId: "v", productId: "p", lineTotalMinor: 5_198 },
      ]),
    ).toBe(0);
    expect(
      offlineVoucherDiscount(
        {
          ...terms,
          benefitType: "fixed_amount",
          benefitPercentBp: null,
          benefitAmountMinor: 9_999,
          targetType: "variant_scope",
          targetVariantIds: ["v"],
        },
        [
          { variantId: "v", productId: "p", lineTotalMinor: 1_000 },
          { variantId: "w", productId: "q", lineTotalMinor: 5_000 },
        ],
      ),
    ).toBe(1_000);
  });

  it("previews then applies a voucher: the signed command carries it and the total is net", () => {
    const { harness, sales } = harnessWith({ voucherGrants: [voucherGrant()] });
    const preview = sales.previewVoucher({
      code: "save10",
      lines: [{ variantId: ids.variant, quantity: 2 }],
    });
    expect(preview).toEqual({
      label: "SAVE10",
      discountTotalMinor: 519,
      netTotalMinor: 5_198 - 519,
      requiresApproval: false,
    });
    const accepted = sell(sales, 2, {
      cashReceivedMinor: 5_198 - 519,
      voucher: { code: "SAVE10" },
    });
    expect(accepted.totalMinor).toBe(5_198 - 519);
    const row = harness.database.connection.prepare("SELECT request_json FROM outbox").get() as {
      request_json: string;
    };
    expect(JSON.parse(row.request_json).command.voucher).toEqual({
      voucherGrantId: VOUCHER,
      promotionId: PROMOTION,
      codeId: CODE_ID,
      discountTotalMinor: 519,
    });
  });

  it("enforces the till's quota and the per-grant cap (D-7) locally", () => {
    const { sales } = harnessWith({ voucherGrants: [voucherGrant({ allowedCount: 1 })] });
    sell(sales, 1, { cashReceivedMinor: PRICE - 259, voucher: { code: "SAVE10" } });
    expect(() =>
      sell(sales, 1, { cashReceivedMinor: PRICE - 259, voucher: { code: "SAVE10" } }),
    ).toThrow(expect.objectContaining({ code: "VOUCHER_QUOTA_USED" }));
    const capped = harnessWith({ voucherGrants: [voucherGrant({ perGrantCap: 600 })] });
    sell(capped.sales, 2, { cashReceivedMinor: 5_198 - 519, voucher: { code: "SAVE10" } });
    expect(() =>
      sell(capped.sales, 2, { cashReceivedMinor: 5_198 - 519, voucher: { code: "SAVE10" } }),
    ).toThrow(expect.objectContaining({ code: "VOUCHER_CAP_REACHED" }));
  });

  it("refuses an unknown code and never applies an online-only voucher offline", () => {
    const { sales } = harnessWith({ voucherGrants: [] });
    expect(() =>
      sales.previewVoucher({ code: "NOPE", lines: [{ variantId: ids.variant, quantity: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "VOUCHER_NOT_AVAILABLE" }));
  });
});

describe("ADR-042 §6.3 admin credentials at the till (no approval queue)", () => {
  it("requires an approver, issues a one-use assertion bound to the command, and never stores the password", () => {
    const { harness, sales, roster } = harnessWith({
      voucherGrants: [voucherGrant({ requiresAdminCredentials: true })],
    });
    installAdmin(roster, ["promotions.manage"]);
    expect(() =>
      sell(sales, 1, { cashReceivedMinor: PRICE - 259, voucher: { code: "SAVE10" } }),
    ).toThrow(expect.objectContaining({ code: "ADMIN_CREDENTIALS_REQUIRED" }));
    expect(() =>
      sell(sales, 1, {
        cashReceivedMinor: PRICE - 259,
        voucher: { code: "SAVE10", approver: { username: "boss", password: "wrong-password-1" } },
      }),
    ).toThrow(expect.objectContaining({ code: "ADMIN_CREDENTIALS_INVALID" }));
    sell(sales, 1, {
      cashReceivedMinor: PRICE - 259,
      voucher: { code: "SAVE10", approver: { username: "boss", password: "Blue-Harbour-71" } },
    });
    const row = harness.database.connection
      .prepare("SELECT request_json, canonical_command FROM outbox")
      .get() as {
      request_json: string;
      canonical_command: string;
    };
    const command = JSON.parse(row.request_json).command;
    expect(command.voucher.adminAssertion).toMatchObject({
      adminMembershipId: ADMIN,
      permission: "promotions.manage",
      verifierVersion: 2,
      commandId: command.syncCommandId,
      offlineGrantId: ids.grant,
    });
    expect(row.request_json).not.toContain("Blue-Harbour-71");
    expect(row.canonical_command).not.toContain("Blue-Harbour-71");
  });

  it("locks a username after 5 failures, and the lock survives a restart", () => {
    const { harness, roster } = harnessWith({});
    installAdmin(roster, ["promotions.manage"]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        roster.check({
          username: "boss",
          password: "nope-nope-nope",
          permission: "promotions.manage",
          commandId: "c",
        }),
      ).toMatchObject({ ok: false, reason: "INVALID" });
    }
    const restarted = new OverrideRosterStore(
      path.join(harness.directory, "override-roster.sealed"),
      new TestSecureStorage(),
      NOW,
    );
    expect(
      restarted.check({
        username: "boss",
        password: "Blue-Harbour-71",
        permission: "promotions.manage",
        commandId: "c",
      }),
    ).toMatchObject({
      ok: false,
      reason: "THROTTLED",
    });
    const later = new OverrideRosterStore(
      path.join(harness.directory, "override-roster.sealed"),
      new TestSecureStorage(),
      () => new Date("2026-09-08T12:06:00.000Z"),
    );
    expect(
      later.check({
        username: "boss",
        password: "Blue-Harbour-71",
        permission: "promotions.manage",
        commandId: "c",
      }).ok,
    ).toBe(true);
  });

  it("refuses an admin without the needed permission, and fails closed when the key store is unavailable", () => {
    const { harness, roster } = harnessWith({});
    installAdmin(roster, ["payments.refund"]);
    expect(
      roster.check({
        username: "boss",
        password: "Blue-Harbour-71",
        permission: "promotions.manage",
        commandId: "c",
      }),
    ).toMatchObject({
      ok: false,
      reason: "NOT_AUTHORIZED",
    });
    const locked = new OverrideRosterStore(
      path.join(harness.directory, "override-roster.sealed"),
      new TestSecureStorage(false),
      NOW,
    );
    expect(
      locked.check({
        username: "boss",
        password: "Blue-Harbour-71",
        permission: "payments.refund",
        commandId: "c",
      }),
    ).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });
});

describe("ADR-042 §8 offline new customer", () => {
  it("stores the customer and a signed command atomically; the accepted profile is cleared at the next sync", () => {
    const { harness, sales } = harnessWith({});
    expect(() => sales.acceptNewCustomer({ name: "Omar", phone: "0100555" })).toThrow(
      OfflineAcceptanceError,
    );
    const accepted = sales.acceptNewCustomer({ name: " Omar Adel ", phone: "+20 100 555 0101" });
    expect(accepted).toMatchObject({ name: "Omar Adel", phone: "+201005550101" });
    const outbox = new CustomerOutboxStore(harness.database, NOW);
    const item = outbox.claimNext(30_000)!;
    const request = JSON.parse(item.requestJson);
    expect(request.command).toMatchObject({
      localCustomerId: accepted.localCustomerId,
      grantId: ids.grant,
      phone: "+201005550101",
    });
    outbox.completeDelivery(item.syncCommandId, item.leaseId, {
      ingestionId: "10000000-0000-4000-8000-0000000000f1",
      localCustomerId: accepted.localCustomerId,
      customerId: accepted.localCustomerId,
      duplicateOfCustomerId: null,
      receivedAt: "2026-09-08T12:01:00.000Z",
    });
    // Owner rule: the accepted profile is kept until the NEXT successful sync, then cleared.
    expect(
      harness.database.connection
        .prepare("SELECT lifecycle FROM local_customer WHERE local_customer_id = ?")
        .get(accepted.localCustomerId),
    ).toEqual({ lifecycle: "synced" });
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.purgeAcceptedProfiles("2026-09-08T12:00:00.000Z")).toBe(0); // same pass: kept
    expect(outbox.purgeAcceptedProfiles("2026-09-08T13:00:00.000Z")).toBe(1); // next pass: cleared
    expect(
      harness.database.connection.prepare("SELECT COUNT(*) AS n FROM local_customer").get(),
    ).toEqual({ n: 0 });
    expect(
      JSON.stringify(harness.database.connection.prepare("SELECT * FROM customer_outbox").get()),
    ).not.toContain("+201005550101");
  });
});
