// ADR-042 §13.6 — offline redemption of EXISTING vouchers from the lease's cached policy, on a REAL SQLite file.
// No reservation, no per-till quota: the till enforces only a best-effort local ceiling against the SHARED
// remaining usage the server reported at fetch time; the server decides at sync (API suites).
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { OfflineSaleService } from "../../src/main/offline/offline-service";
import { voucherCodeFingerprint } from "../../src/main/offline/voucher-policy";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const PRICE = 2_599;
const NOW = () => new Date("2026-09-08T12:00:00.000Z");
const ISSUANCE = "10000000-0000-4000-8000-0000000000b1";
const PROMOTION = "10000000-0000-4000-8000-0000000000cc";
const CODE_ID = "10000000-0000-4000-8000-0000000000dd";
const DIGEST = "a".repeat(64);

function policy(
  overrides: Record<string, unknown> = {},
  termOverrides: Record<string, unknown> = {},
) {
  return {
    policyIssuanceId: ISSUANCE,
    promotionId: PROMOTION,
    codeId: CODE_ID,
    codeFingerprint: voucherCodeFingerprint(ids.tenant, "SAVE10"),
    channelPolicyVersion: 1,
    policyDigest: DIGEST,
    calculationVersion: "ov1",
    observedRemaining: 2,
    maxDiscountPerRedemptionMinor: null,
    requiresAdminCredentials: false,
    fetchedAt: "2026-09-08T11:00:00.000Z",
    expiresAt: "2026-09-08T20:00:00.000Z",
    terms: {
      promotionId: PROMOTION,
      name: "Ten off",
      codeId: CODE_ID,
      benefitType: "percentage",
      benefitPercentBp: 1_000,
      benefitAmountMinor: null,
      benefitCurrency: null,
      targetType: "order",
      minSubtotalMinor: null,
      maxDiscountMinor: null,
      endsAt: null,
      targetProductIds: [],
      targetVariantIds: [],
      ...termOverrides,
    },
    ...overrides,
  };
}

function harnessWith(
  policies: unknown[],
  seam?: ConstructorParameters<typeof OfflineSaleService>[3],
) {
  const harness = makeHarness({
    now: NOW,
    bootstrap: { ...bootstrapFixture(), voucherPolicies: policies } as never,
    saleTestSeam: seam,
  });
  harnesses.push(harness);
  return harness;
}

const sellOne = (sales: OfflineSaleService, voucher = true) =>
  sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: PRICE,
    ...(voucher ? { voucher: { code: "save10" } } : {}),
  });

const count = (harness: OfflineHarness, sql: string) =>
  Number((harness.database.connection.prepare(sql).get() as { n: number }).n);

describe("ADR-042 §13.6 cached voucher policy — local redemption on real SQLite", () => {
  it("installs the policy without the raw code and prices a sale from it with provisional freshness", () => {
    const harness = harnessWith([policy()]);
    const stored = harness.database.connection
      .prepare("SELECT * FROM offline_voucher_policy")
      .get() as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain("SAVE10");
    expect(stored.observed_remaining).toBe(2);

    const preview = harness.sales.previewVoucher({
      code: " save10 ",
      lines: [{ variantId: ids.variant, quantity: 2 }],
    });
    expect(preview).toEqual({
      label: "Ten off",
      discountTotalMinor: 519,
      netTotalMinor: 5_198 - 519,
      requiresApproval: false,
      policy: {
        fetchedAt: "2026-09-08T11:00:00.000Z",
        expiresAt: "2026-09-08T20:00:00.000Z",
        remainingAtFetch: 2,
        localUsesSinceFetch: 0,
        provisional: true,
      },
    });

    const accepted = sellOne(harness.sales);
    expect(accepted.totalMinor).toBe(PRICE - 259);
    const outbox = harness.database.connection
      .prepare("SELECT request_json, canonical_command FROM outbox")
      .get() as { request_json: string; canonical_command: string };
    expect(JSON.parse(outbox.request_json).command.voucher).toEqual({
      policyIssuanceId: ISSUANCE,
      promotionId: PROMOTION,
      codeId: CODE_ID,
      policyDigest: DIGEST,
      observedRemaining: 2,
      discountTotalMinor: 259,
    });
    expect(outbox.canonical_command).not.toContain("SAVE10");
    expect(
      harness.database.connection
        .prepare(
          "SELECT discount_total_minor, voucher_label, voucher_policy_issuance_id, voucher_code_id, total_minor FROM local_sale",
        )
        .get(),
    ).toEqual({
      discount_total_minor: 259,
      voucher_label: "Ten off",
      voucher_policy_issuance_id: ISSUANCE,
      voucher_code_id: CODE_ID,
      total_minor: PRICE - 259,
    });
  });

  it("local usage reaches the last-known shared remaining: the next use is refused on this till, nothing written", () => {
    const harness = harnessWith([policy({ observedRemaining: 2 })]);
    sellOne(harness.sales);
    const second = sellOne(harness.sales);
    expect(
      JSON.parse(
        (
          harness.database.connection
            .prepare("SELECT request_json FROM outbox WHERE local_sale_id = ?")
            .get(second.localSaleId) as { request_json: string }
        ).request_json,
      ).command.voucher.observedRemaining,
    ).toBe(1);
    const before = count(harness, "SELECT COUNT(*) AS n FROM local_sale");
    expect(() => sellOne(harness.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_LOCAL_LIMIT_REACHED" }),
    );
    expect(count(harness, "SELECT COUNT(*) AS n FROM local_sale")).toBe(before);
    expect(count(harness, "SELECT COUNT(*) AS n FROM outbox")).toBe(before);
    // A sale without the voucher is unaffected.
    sellOne(harness.sales, false);
  });

  it("no finite shared limit: the till applies no ceiling", () => {
    const harness = harnessWith([policy({ observedRemaining: null })]);
    for (let n = 0; n < 4; n += 1) sellOne(harness.sales);
    expect(
      count(harness, "SELECT COUNT(*) AS n FROM local_sale WHERE voucher_code_id IS NOT NULL"),
    ).toBe(4);
  });

  it("refuses an expired policy, an ended voucher and a policy past the lease", () => {
    const expired = harnessWith([
      policy({ fetchedAt: "2026-09-08T09:00:00.000Z", expiresAt: "2026-09-08T11:30:00.000Z" }),
    ]);
    expect(() => sellOne(expired.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_EXPIRED" }),
    );
    const ended = harnessWith([policy({}, { endsAt: "2026-09-08T12:00:00.000Z" })]);
    expect(() => sellOne(ended.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_EXPIRED" }),
    );
    // A policy claiming to outlive the lease is clamped to the lease on install.
    const clamped = harnessWith([policy({ expiresAt: "2026-09-09T20:00:00.000Z" })]);
    expect(
      clamped.database.connection.prepare("SELECT expires_at FROM offline_voucher_policy").get(),
    ).toEqual({ expires_at: "2026-09-08T20:00:00.000Z" });
  });

  it("detects a tampered cached policy at rest and refuses it (fail closed)", () => {
    const harness = harnessWith([policy()]);
    expect(() =>
      harness.database.connection.exec(
        "UPDATE offline_voucher_policy SET observed_remaining = 999",
      ),
    ).toThrow(/immutable/);
    // An attacker with raw file access bypassing the trigger is still caught by the integrity check.
    harness.database.connection.exec(`
      DROP TRIGGER immutable_offline_voucher_policy;
      UPDATE offline_voucher_policy SET terms_json = replace(terms_json, '1000', '9000');
    `);
    expect(() => sellOne(harness.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_SNAPSHOT_INVALID" }),
    );
    expect(count(harness, "SELECT COUNT(*) AS n FROM local_sale")).toBe(0);
  });

  it("a policy row copied from another till's lease (wrong snapshot/grant binding) is refused before selling", () => {
    const original = harnessWith([policy()]);
    const copiedIntegrity = (
      original.database.connection
        .prepare("SELECT integrity_sha256 AS h FROM offline_voucher_policy")
        .get() as { h: string }
    ).h;
    // Another till/lease: identical server terms, different snapshot + grant. Simulate an attacker who copies
    // the first till's row (with its hash) into this till's database, bypassing the immutability trigger.
    const other = makeHarness({
      now: NOW,
      bootstrap: {
        ...bootstrapFixture(),
        grantId: "10000000-0000-4000-8000-0000000000f1",
        snapshotId: "10000000-0000-4000-8000-0000000000f2",
        voucherPolicies: [policy()],
      } as never,
    });
    harnesses.push(other);
    expect(() => sellOne(other.sales)).not.toThrow(); // its own correctly bound row works
    other.database.connection.exec(`
      DROP TRIGGER immutable_offline_voucher_policy;
      UPDATE offline_voucher_policy SET integrity_sha256 = '${copiedIntegrity}';
    `);
    const before = count(other, "SELECT COUNT(*) AS n FROM local_sale");
    expect(() => sellOne(other.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_SNAPSHOT_INVALID" }),
    );
    expect(count(other, "SELECT COUNT(*) AS n FROM local_sale")).toBe(before);
  });

  it("a policy issued for another business (tenant fingerprint) never matches a code on this till", () => {
    const harness = harnessWith([
      policy({
        codeFingerprint: voucherCodeFingerprint("99999999-0000-4000-8000-000000000001", "SAVE10"),
      }),
    ]);
    expect(() => sellOne(harness.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_NOT_AVAILABLE" }),
    );
    expect(count(harness, "SELECT COUNT(*) AS n FROM local_sale")).toBe(0);
  });

  it("never installs a credential-gated or malformed policy: that voucher stays online-only", () => {
    const harness = harnessWith([
      policy({ requiresAdminCredentials: true }),
      policy({
        policyIssuanceId: "not-a-uuid",
        codeFingerprint: voucherCodeFingerprint(ids.tenant, "X"),
      }),
    ]);
    expect(count(harness, "SELECT COUNT(*) AS n FROM offline_voucher_policy")).toBe(0);
    expect(() => sellOne(harness.sales)).toThrow(
      expect.objectContaining({ code: "VOUCHER_NOT_AVAILABLE" }),
    );
  });

  it("a crash mid-transaction persists neither the sale nor a counted voucher use", () => {
    for (const stage of ["sale", "lines", "tender", "outbox"] as const) {
      let armed = true;
      const harness = harnessWith([policy({ observedRemaining: 1 })], {
        afterStage(name: string) {
          if (armed && name === stage) throw new Error(`crash at ${stage}`);
        },
      });
      expect(() => sellOne(harness.sales)).toThrow(`crash at ${stage}`);
      expect(count(harness, "SELECT COUNT(*) AS n FROM local_sale")).toBe(0);
      expect(count(harness, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
      armed = false;
      // The single remaining use is still available after the crash.
      sellOne(harness.sales);
      expect(() => sellOne(harness.sales)).toThrow(
        expect.objectContaining({ code: "VOUCHER_LOCAL_LIMIT_REACHED" }),
      );
    }
  });

  it("after a restart the local counter and the byte-identical outbox command survive", () => {
    const harness = harnessWith([policy({ observedRemaining: 1 })]);
    const accepted = sellOne(harness.sales);
    const before = harness.database.connection
      .prepare("SELECT canonical_command, payload_hash, signature_base64, request_json FROM outbox")
      .get();
    harness.database.close();
    const reopened = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), {
      now: NOW,
    });
    try {
      const sales = new OfflineSaleService(reopened, harness.keys, NOW);
      expect(() => sellOne(sales)).toThrow(
        expect.objectContaining({ code: "VOUCHER_LOCAL_LIMIT_REACHED" }),
      );
      expect(
        reopened.connection
          .prepare(
            "SELECT canonical_command, payload_hash, signature_base64, request_json FROM outbox WHERE local_sale_id = ?",
          )
          .get(accepted.localSaleId),
      ).toEqual(before);
    } finally {
      reopened.close();
    }
  });
});
