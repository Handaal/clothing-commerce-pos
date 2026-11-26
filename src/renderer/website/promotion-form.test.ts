import type { PromotionDetail } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it } from "vitest";

import {
  buildCreatePromotionRequest,
  buildUpdatePromotionRequest,
  codeLimit,
  emptyPromotionForm,
  normalizePromotionCode,
  parsePromotionMoney,
  promotionEffectiveState,
  promotionToForm,
  validatePromotionForm,
  type PromotionFormState,
} from "./promotion-form";

const form = (overrides: Partial<PromotionFormState> = {}): PromotionFormState => ({
  ...emptyPromotionForm(),
  name: "Weekend",
  benefitValue: "10",
  ...overrides,
});

function detail(overrides: Partial<PromotionDetail> = {}): PromotionDetail {
  return {
    id: "p1",
    name: "Weekend",
    status: "active",
    benefitType: "percentage",
    targetType: "order",
    activationType: "automatic",
    channel: null,
    redemptionCount: 0,
    globalRedemptionLimit: null,
    economicsLocked: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    description: null,
    benefitPercentBp: 1000,
    benefitAmountMinor: null,
    benefitCurrency: null,
    buyQuantity: null,
    getQuantity: null,
    minSubtotalMinor: null,
    maxDiscountMinor: null,
    startsAt: null,
    endsAt: null,
    brandId: null,
    branchId: null,
    remainingRedemptions: null,
    targets: [],
    codes: [],
    ...overrides,
  } as PromotionDetail;
}

describe("promotion form rules (ported from Admin Mobile)", () => {
  it("parses money exactly and rejects bad amounts", () => {
    expect(parsePromotionMoney("25.5", false)).toBe(2550);
    expect(parsePromotionMoney("", false)).toBeNull();
    expect(parsePromotionMoney("0", true)).toBe(0);
    expect(parsePromotionMoney("0", false)).toEqual({ key: "website.err.amountPositive" });
    expect(parsePromotionMoney("1.234", false)).toEqual({ key: "website.err.amount" });
  });

  it("normalises codes and per-code limits", () => {
    expect(normalizePromotionCode(" welcome10 ")).toBe("WELCOME10");
    expect(normalizePromotionCode("")).toEqual({ key: "website.err.codeRequired" });
    expect(normalizePromotionCode("BAD CODE")).toEqual({ key: "website.err.codeFormat" });
    expect(codeLimit("unlimited", "")).toBeNull();
    expect(codeLimit("single", "")).toBe(1);
    expect(codeLimit("custom", "5")).toBe(5);
    expect(codeLimit("custom", "")).toEqual({ key: "website.err.wholeNumber" });
  });

  it("validates the create form", () => {
    expect(validatePromotionForm(form(), "create")).toEqual({});
    const errors = validatePromotionForm(
      form({
        name: "",
        benefitValue: "120",
        targetType: "variant_scope",
        activationType: "code",
        initialCode: "",
        globalLimit: "0",
        startsAt: "2026-12-02T10:00",
        endsAt: "2026-12-01T10:00",
      }),
      "create",
    );
    expect(errors.name?.key).toBe("website.err.promoName");
    expect(errors.benefitValue?.key).toBe("website.err.percent");
    expect(errors.targets?.key).toBe("website.err.promoTargets");
    expect(errors.initialCode?.key).toBe("website.err.codeRequired");
    expect(errors.globalLimit?.key).toBe("website.err.positive");
    expect(errors.endsAt?.key).toBe("website.err.promoEndAfterStart");
  });

  it("checks buy-X-get-Y quantities and validates every field on edit", () => {
    const bxgy = validatePromotionForm(
      form({ benefitType: "buy_x_get_y", buyQuantity: "0", getQuantity: "101" }),
      "create",
    );
    expect(bxgy.buyQuantity?.key).toBe("website.err.quantity");
    expect(bxgy.getQuantity?.key).toBe("website.err.quantity");
    expect(validatePromotionForm(form({ benefitValue: "nope" }), "edit").benefitValue?.key).toBe(
      "website.err.percent",
    );
    const switching = form({ activationType: "code" });
    expect(validatePromotionForm(switching, "edit").initialCode).toBeUndefined();
    expect(
      validatePromotionForm(switching, "edit", { requireInitialCode: true }).initialCode?.key,
    ).toBe("website.err.codeRequired");
  });

  it("builds a code promotion with targets, limits and channel", () => {
    const request = buildCreatePromotionRequest(
      form({
        benefitType: "fixed_amount",
        benefitValue: "50",
        targetType: "variant_scope",
        targets: [
          { target: { productId: "prod", variantId: null }, label: "Shirt" },
          { target: { productId: null, variantId: "var" }, label: "Shirt · M" },
        ],
        activationType: "code",
        initialCode: "save50",
        codeLimitKind: "custom",
        codeCustomLimit: "3",
        channel: "pos",
        minimumSubtotal: "200",
        globalLimit: "100",
        status: "active",
      }),
    );
    expect(request).toMatchObject({
      benefitType: "fixed_amount",
      benefitAmountMinor: 5000,
      benefitCurrency: "EGP",
      targetType: "variant_scope",
      targets: [
        { productId: "prod", variantId: null },
        { productId: null, variantId: "var" },
      ],
      activationType: "code",
      codes: [{ code: "SAVE50", maxRedemptions: 3 }],
      channel: "pos",
      minSubtotalMinor: 20000,
      globalRedemptionLimit: 100,
      status: "active",
    });
  });

  it("forces buy-X-get-Y offers online", () => {
    const request = buildCreatePromotionRequest(
      form({ benefitType: "buy_x_get_y", buyQuantity: "2", getQuantity: "1", channel: "pos" }),
    );
    expect(request).toMatchObject({ buyQuantity: 2, getQuantity: 1, channel: "online" });
    expect(request.benefitPercentBp).toBeUndefined();
  });

  it("sends only what changed on edit, even after the promotion was used", () => {
    const current = detail({
      benefitPercentBp: 1000,
      minSubtotalMinor: 5000,
      economicsLocked: true,
      redemptionCount: 4,
    });
    const edited = { ...promotionToForm(current), name: "Renamed", benefitValue: "15" };
    expect(buildUpdatePromotionRequest(edited, current)).toEqual({
      name: "Renamed",
      description: null,
      startsAt: null,
      endsAt: null,
      benefitPercentBp: 1500,
    });
    expect(
      buildUpdatePromotionRequest(
        {
          ...edited,
          targetType: "variant_scope",
          targets: [{ target: { productId: "p", variantId: null }, label: "P" }],
        },
        current,
      ),
    ).toMatchObject({
      targetType: "variant_scope",
      targets: [{ productId: "p", variantId: null }],
    });
  });

  it("round-trips a detail into the form", () => {
    const value = promotionToForm(
      detail({
        benefitType: "fixed_amount",
        benefitPercentBp: null,
        benefitAmountMinor: 2550,
        benefitCurrency: "EGP",
        channel: "online",
        globalRedemptionLimit: 9,
      }),
    );
    expect(value).toMatchObject({
      benefitValue: "25.50",
      channel: "online",
      globalLimit: "9",
      currency: "EGP",
    });
  });

  it("derives the live state like Admin Mobile", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    expect(promotionEffectiveState(detail({ status: "inactive" }), now)).toBe("inactive");
    expect(promotionEffectiveState(detail({ startsAt: "2026-12-01T00:00:00.000Z" }), now)).toBe(
      "scheduled",
    );
    expect(promotionEffectiveState(detail({ endsAt: "2026-11-01T00:00:00.000Z" }), now)).toBe(
      "expired",
    );
    expect(promotionEffectiveState(detail({ remainingRedemptions: 0 }), now)).toBe("exhausted");
    expect(promotionEffectiveState(detail(), now)).toBe("active");
  });
});
