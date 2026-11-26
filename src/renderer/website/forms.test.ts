import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StorefrontContent } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import { capabilitiesForOperator } from "../auth/posCapabilities";
import { accessibleSections } from "../shell/sections";
import { hasAnyWebsiteAccess, loadAllProducts, loadAllPromotions, websiteAccess } from "./access";
import {
  buildContentRequest,
  contentToForm,
  MAX_FEATURED_PRODUCTS,
  moveSelection,
  validateContentForm,
} from "./content-form";
import {
  buildCreateSaleRequest,
  buildUpdateSaleRequest,
  emptySaleForm,
  isoToLocalInput,
  parseAmountOff,
  parsePercent,
  previewSalePrice,
  saleLiveState,
  saleToForm,
  validateSaleForm,
} from "./sale-form";
import { WEBSITE_AR, WEBSITE_EN } from "./strings";

const CONTENT: StorefrontContent = {
  hero: {
    eyebrow: "New",
    title: "Summer",
    subtitle: null,
    ctaLabel: "Shop",
    ctaHref: "/catalog",
    image: { bucket: "media", path: "hero/a.jpg", altText: "Model" },
  },
  featuredHeading: null,
  featuredProductIds: ["p1", "p2"],
  featuredCollectionIds: [],
} as unknown as StorefrontContent;

describe("home-page content form (ported from Admin Mobile)", () => {
  it("round-trips content into a request, trimming and nulling blanks", () => {
    const form = { ...contentToForm(CONTENT), title: "  Summer  ", subtitle: "   " };
    expect(buildContentRequest(form)).toEqual({
      hero: {
        eyebrow: "New",
        title: "Summer",
        subtitle: null,
        ctaLabel: "Shop",
        ctaHref: "/catalog",
        image: { bucket: "media", path: "hero/a.jpg", altText: "Model" },
      },
      featuredHeading: null,
      featuredProductIds: ["p1", "p2"],
      featuredCollectionIds: [],
    });
  });

  it("rejects unsafe links, a button with no link, over-long text and too many picks", () => {
    const base = contentToForm(CONTENT);
    expect(validateContentForm(base)).toEqual({});
    expect(validateContentForm({ ...base, ctaHref: "javascript:alert(1)" }).ctaHref?.key).toBe(
      "website.err.ctaHref",
    );
    expect(validateContentForm({ ...base, ctaHref: "//evil.example" }).ctaHref?.key).toBe(
      "website.err.ctaHref",
    );
    expect(validateContentForm({ ...base, ctaHref: "http://plain.example" }).ctaHref).toBeTruthy();
    expect(validateContentForm({ ...base, ctaHref: "https://ok.example" }).ctaHref).toBeUndefined();
    expect(validateContentForm({ ...base, ctaHref: "" }).ctaHref?.key).toBe(
      "website.err.ctaHrefMissing",
    );
    expect(validateContentForm({ ...base, eyebrow: "x".repeat(81) }).eyebrow).toEqual({
      key: "website.err.tooLong",
      vars: { max: 80 },
    });
    const many = Array.from({ length: MAX_FEATURED_PRODUCTS + 1 }, (_, i) => `p${i}`);
    expect(validateContentForm({ ...base, featuredProductIds: many }).featuredProductIds?.key).toBe(
      "website.err.tooManyProducts",
    );
  });

  it("reorders the display order and ignores out-of-range moves", () => {
    expect(moveSelection(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveSelection(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveSelection(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveSelection(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("item-sale form (ported from Admin Mobile)", () => {
  it("parses percentages to basis points and amounts to minor units", () => {
    expect(parsePercent("25")).toBe(2500);
    expect(parsePercent("12.5")).toBe(1250);
    expect(parsePercent("0")).toEqual({ key: "website.err.percent" });
    expect(parsePercent("101")).toEqual({ key: "website.err.percent" });
    expect(parseAmountOff("100.5")).toBe(10050);
    expect(parseAmountOff("0")).toEqual({ key: "website.err.amountPositive" });
    expect(parseAmountOff("")).toEqual({ key: "website.err.amountRequired" });
    expect(parseAmountOff("1,00")).toEqual({ key: "website.err.amount" });
  });

  it("validates name, value, scope and schedule", () => {
    const errors = validateSaleForm({
      ...emptySaleForm(),
      scope: "products",
      startsAt: "2026-12-10T10:00",
      endsAt: "2026-12-01T10:00",
    });
    expect(errors.name?.key).toBe("website.err.saleName");
    expect(errors.value?.key).toBe("website.err.percent");
    expect(errors.productIds?.key).toBe("website.err.saleProducts");
    expect(errors.endsAt?.key).toBe("website.err.endAfterStart");
    expect(
      validateSaleForm({ ...emptySaleForm(), name: "S", value: "10", scope: "collection" })
        .collectionId?.key,
    ).toBe("website.err.saleCollection");
  });

  it("builds create/update requests (status only on create)", () => {
    const form = {
      ...emptySaleForm(),
      name: " Summer ",
      benefitType: "fixed_amount" as const,
      value: "50",
      scope: "products" as const,
      productIds: ["p1"],
      active: false,
    };
    expect(buildCreateSaleRequest(form)).toEqual({
      name: "Summer",
      benefitType: "fixed_amount",
      benefitAmountMinor: 5000,
      benefitCurrency: "EGP",
      scope: "products",
      productIds: ["p1"],
      startsAt: null,
      endsAt: null,
      status: "inactive",
    });
    expect(buildUpdateSaleRequest(form)).not.toHaveProperty("status");
  });

  it("round-trips schedule instants through datetime-local values", () => {
    const iso = new Date(2026, 11, 1, 9, 30).toISOString();
    expect(isoToLocalInput(iso)).toBe("2026-12-01T09:30");
    expect(isoToLocalInput(null)).toBe("");
    const form = saleToForm({
      id: "s1",
      name: "X",
      status: "active",
      benefitType: "percentage",
      benefitPercentBp: 1250,
      benefitAmountMinor: null,
      benefitCurrency: null,
      scope: "all",
      collectionId: null,
      productIds: [],
      startsAt: iso,
      endsAt: null,
      createdAt: iso,
      updatedAt: iso,
    });
    expect(form.value).toBe("12.5");
    expect(buildUpdateSaleRequest(form).startsAt).toBe(iso);
  });

  it("previews the shopper price like the server (floor percentage, fixed never below zero)", () => {
    expect(previewSalePrice({ ...emptySaleForm(), value: "33" }, 999)).toBe(999 - 329);
    expect(
      previewSalePrice({ ...emptySaleForm(), benefitType: "fixed_amount", value: "20" }, 1000),
    ).toBe(0);
    expect(previewSalePrice({ ...emptySaleForm(), value: "" }, 1000)).toBeNull();
  });

  it("derives live / scheduled / ended / paused", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const sale = { status: "active" as const, startsAt: null, endsAt: null };
    expect(saleLiveState(sale, now)).toBe("live");
    expect(saleLiveState({ ...sale, startsAt: "2026-11-19T00:00:00Z" }, now)).toBe("scheduled");
    expect(saleLiveState({ ...sale, endsAt: "2026-11-18T00:00:00Z" }, now)).toBe("ended");
    expect(saleLiveState({ ...sale, status: "inactive" }, now)).toBe("paused");
  });
});

describe("website access", () => {
  it("maps /me/context guidance; manage never implies read", () => {
    const access = websiteAccess({
      access: {
        catalog: { canRead: false, tenantWide: true, brands: [] },
        promotions: { canRead: false, canManage: true },
      },
    } as never);
    expect(access).toEqual({
      catalogRead: false,
      promotionsRead: false,
      promotionsManage: true,
      settingsRead: false,
      settingsManage: false,
      ordersRead: false,
      ordersFulfill: false,
      ordersCancel: false,
      ordersCollect: false,
    });
    expect(hasAnyWebsiteAccess(access)).toBe(false);
  });

  it("maps online-order guidance; fulfil/cancel need read too", () => {
    const orders = (extra: Record<string, boolean>) =>
      websiteAccess({
        access: {
          catalog: { canRead: false, tenantWide: true, brands: [] },
          orders: { tenantWide: true, brands: [], branches: [], ...extra },
        },
      } as never);
    const full = orders({ canRead: true, canFulfill: true, canCancel: true });
    expect([full.ordersRead, full.ordersFulfill, full.ordersCancel]).toEqual([true, true, true]);
    expect(hasAnyWebsiteAccess(full)).toBe(true);
    const blind = orders({ canRead: false, canFulfill: true, canCancel: true });
    expect([blind.ordersFulfill, blind.ordersCancel]).toEqual([false, false]);
    // Collect follows canCollect (SDK 0.54), falling back to canFulfill on an older server.
    expect(orders({ canRead: true, canFulfill: true }).ordersCollect).toBe(true);
    expect(orders({ canRead: true, canFulfill: true, canCollect: false }).ordersCollect).toBe(
      false,
    );
    expect(blind.ordersCollect).toBe(false);
    // Older servers omit the flags: read-only.
    const legacy = orders({ canRead: true });
    expect([legacy.ordersRead, legacy.ordersFulfill, legacy.ordersCancel]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("follows product cursors and promotion offsets to completion", async () => {
    const listProducts = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "a" }],
        pageInfo: { hasMore: true, nextCursor: "c1" },
      })
      .mockResolvedValueOnce({
        items: [{ id: "b" }],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    expect((await loadAllProducts({ listProducts })).map((p) => p.id)).toEqual(["a", "b"]);
    expect(listProducts).toHaveBeenLastCalledWith({ limit: 100, cursor: "c1" });

    const listPromotions = vi
      .fn()
      .mockResolvedValueOnce({ total: 2, items: [{ id: "x" }] })
      .mockResolvedValueOnce({ total: 2, items: [{ id: "y" }] });
    expect((await loadAllPromotions({ listPromotions })).length).toBe(2);
    expect(listPromotions).toHaveBeenLastCalledWith({ limit: 100, offset: 1 });
  });

  it("fails closed instead of looping on a misbehaving cursor", async () => {
    const listProducts = vi
      .fn()
      .mockResolvedValue({ items: [], pageInfo: { hasMore: true, nextCursor: "same" } });
    await expect(loadAllProducts({ listProducts }, 3)).rejects.toThrow();
    expect(listProducts).toHaveBeenCalledTimes(3);
  });
});

describe("Website Management navigation", () => {
  const user = (role: "admin" | "cashier", permissions: string[] | null) =>
    ({ id: "u", name: "U", username: "u", role, permissions }) as never;

  it("is visible to admins and to cashiers only when granted", () => {
    const ids = (op: never) => accessibleSections(capabilitiesForOperator(op)).map((s) => s.id);
    expect(ids(user("admin", null))).toContain("website");
    expect(ids(user("cashier", []))).not.toContain("website");
    expect(ids(user("cashier", ["website"]))).toContain("website");
  });
});

describe("website strings", () => {
  it("has the same keys in English and Arabic", () => {
    expect(Object.keys(WEBSITE_AR).sort()).toEqual(Object.keys(WEBSITE_EN).sort());
  });

  it("defines every website key the desk references (static and templated)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const used = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!/\.tsx?$/.test(file) || file.includes(".test.") || file === "strings.ts") continue;
      const source = readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/"(website\.[A-Za-z.]+[A-Za-z])"/g)) used.add(match[1]);
    }
    const templated = [
      ...["live", "scheduled", "ended", "paused"].map((s) => `website.sales.state.${s}`),
      ...["code", "automatic"].map((s) => `website.promo.activation.${s}`),
      ...["percentage", "fixed_amount", "buy_x_get_y"].map((s) => `website.promo.benefit.${s}`),
      ...["all", "online", "pos"].map((s) => `website.promo.channel.${s}`),
      ...["active", "draft", "archived"].map((s) => `website.pub.status.${s}`),
    ];
    const missing = [...used, ...templated].filter((key) => !(key in WEBSITE_EN));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(100);
  });
});
