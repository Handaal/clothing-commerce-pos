// @vitest-environment jsdom

import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { PromotionsPanel } from "./PromotionsPanel";

afterEach(cleanup);

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const VARIANT = "66666666-6666-4666-8666-666666666666";
const BRAND = "11111111-1111-4111-8111-111111111111";

function wrap(node: React.ReactNode) {
  return render(
    <I18nProvider>
      <ToastProvider>{node}</ToastProvider>
    </I18nProvider>,
  );
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.mouseDown(screen.getByRole("option", { name: option }));
}

const summary = {
  id: "p1",
  name: "Weekend",
  status: "active",
  benefitType: "percentage",
  targetType: "order",
  activationType: "code",
  channel: null,
  redemptionCount: 2,
  globalRedemptionLimit: null,
  economicsLocked: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary,
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
    codes: [
      {
        id: "c1",
        code: "WEEKEND",
        status: "active",
        maxRedemptions: null,
        redemptionCount: 2,
        remainingRedemptions: null,
      },
    ],
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    listPromotions: vi.fn().mockResolvedValue({ total: 1, items: [summary] }),
    getPromotion: vi.fn().mockResolvedValue(detail()),
    createPromotion: vi.fn().mockResolvedValue(detail({ id: "p2" })),
    updatePromotion: vi.fn().mockResolvedValue(detail()),
    setPromotionStatus: vi.fn().mockResolvedValue(detail({ status: "inactive" })),
    createPromotionCode: vi.fn(),
    setPromotionCodeStatus: vi.fn(),
    deletePromotion: vi.fn(),
    listProducts: vi.fn().mockResolvedValue({
      items: [{ id: PRODUCT, name: "Linen Shirt", styleCode: "LS-1", status: "active" }],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    getProduct: vi.fn().mockResolvedValue({
      id: PRODUCT,
      variants: [{ id: VARIANT, sku: "LS-1-M", displayName: "Medium" }],
    }),
    ...overrides,
  };
}

const context = {
  access: {
    catalog: { canRead: true, tenantWide: true, brands: [{ id: BRAND, name: "Zee" }] },
    orders: { brands: [], branches: [] },
  },
} as never;

describe("Promotion create / edit", () => {
  it("creates an automatic whole-order promotion", async () => {
    const api = client();
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    await screen.findByTestId("website-promo-p1");
    fireEvent.click(screen.getByTestId("website-promo-new"));

    fireEvent.change(screen.getByTestId("website-promo-name"), { target: { value: "Eid" } });
    fireEvent.change(screen.getByTestId("website-promo-value"), { target: { value: "15" } });
    choose("Channel", "Website only");
    choose("Brand", "Zee");
    fireEvent.click(screen.getByTestId("website-promo-submit"));

    await waitFor(() => expect(api.createPromotion).toHaveBeenCalled());
    expect(api.createPromotion.mock.calls[0][0]).toMatchObject({
      name: "Eid",
      activationType: "automatic",
      benefitType: "percentage",
      benefitPercentBp: 1500,
      targetType: "order",
      channel: "online",
      brandId: BRAND,
      status: "inactive",
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(api.listPromotions).toHaveBeenCalledTimes(2));
  });

  it("creates a code promotion on chosen products and variants", async () => {
    const api = client();
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    await screen.findByTestId("website-promo-p1");
    fireEvent.click(screen.getByTestId("website-promo-new"));

    fireEvent.change(screen.getByTestId("website-promo-name"), { target: { value: "Shirts" } });
    fireEvent.change(screen.getByTestId("website-promo-value"), { target: { value: "20" } });
    choose("Activation", "Code — shopper enters a code");
    choose("Applies to", "Chosen products or variants");

    // Submitting without targets or a code is blocked client-side.
    fireEvent.click(screen.getByTestId("website-promo-submit"));
    expect(await screen.findByText("Choose at least one product or variant.")).toBeTruthy();
    expect(screen.getByText("Enter a code.")).toBeTruthy();
    expect(api.createPromotion).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /Linen Shirt/ }));
    fireEvent.click(screen.getByTestId("website-promo-add-product"));
    fireEvent.click(await screen.findByTestId(`website-promo-add-variant-${VARIANT}`));
    const targets = screen.getByTestId("website-promo-targets");
    expect(within(targets).getByText("Linen Shirt · Medium")).toBeTruthy();

    fireEvent.change(screen.getByTestId("website-promo-code"), { target: { value: "shirt20" } });
    choose("Code use", "Single use");
    fireEvent.click(screen.getByTestId("website-promo-submit"));

    await waitFor(() => expect(api.createPromotion).toHaveBeenCalled());
    expect(api.createPromotion.mock.calls[0][0]).toMatchObject({
      activationType: "code",
      targetType: "variant_scope",
      targets: [
        { productId: PRODUCT, variantId: null },
        { productId: null, variantId: VARIANT },
      ],
      codes: [{ code: "SHIRT20", maxRedemptions: 1 }],
    });
  });

  it("edits every setting of a used promotion, including its products", async () => {
    const api = client({
      getPromotion: vi.fn().mockResolvedValue(
        detail({
          economicsLocked: true,
          redemptionCount: 2,
          targetType: "variant_scope",
          targets: [{ productId: PRODUCT, variantId: null, productName: "Linen Shirt" }],
        }),
      ),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));

    expect(await screen.findByTestId("website-promo-used")).toBeTruthy();
    const targets = screen.getByTestId("website-promo-targets");
    expect(within(targets).getByText("Linen Shirt")).toBeTruthy();
    fireEvent.change(screen.getByTestId("website-promo-value"), { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("website-promo-global-limit"), {
      target: { value: "50" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Linen Shirt/ }));
    fireEvent.click(await screen.findByTestId(`website-promo-add-variant-${VARIANT}`));
    fireEvent.click(screen.getByTestId("website-promo-submit"));

    await waitFor(() => expect(api.updatePromotion).toHaveBeenCalled());
    expect(api.updatePromotion.mock.calls[0][0]).toMatchObject({
      promotionId: "p1",
      benefitPercentBp: 2500,
      globalRedemptionLimit: 50,
      targets: [
        { productId: PRODUCT, variantId: null },
        { productId: null, variantId: VARIANT },
      ],
    });
  });

  it("asks for a first code when switching an automatic promotion to a code", async () => {
    const api = client({
      getPromotion: vi.fn().mockResolvedValue(detail({ activationType: "automatic", codes: [] })),
      createPromotionCode: vi.fn().mockResolvedValue(detail()),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    await screen.findByTestId("website-promo-name");
    choose("Activation", "Code — shopper enters a code");
    fireEvent.click(screen.getByTestId("website-promo-submit"));
    expect(await screen.findByText("Enter a code.")).toBeTruthy();
    expect(api.updatePromotion).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("website-promo-code"), { target: { value: "new10" } });
    fireEvent.click(screen.getByTestId("website-promo-submit"));
    await waitFor(() =>
      expect(api.createPromotionCode).toHaveBeenCalledWith(
        expect.objectContaining({ promotionId: "p1", code: "NEW10", maxRedemptions: null }),
      ),
    );
    expect(api.updatePromotion.mock.calls[0][0]).toMatchObject({ activationType: "code" });
  });

  it("shows the server error and keeps the editor open", async () => {
    const api = client({
      createPromotion: vi.fn().mockRejectedValue(new ApiHttpError("no", 403, "FORBIDDEN", null)),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    await screen.findByTestId("website-promo-p1");
    fireEvent.click(screen.getByTestId("website-promo-new"));
    fireEvent.change(screen.getByTestId("website-promo-name"), { target: { value: "Eid" } });
    fireEvent.change(screen.getByTestId("website-promo-value"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("website-promo-submit"));
    expect(await screen.findByText("Your account isn't allowed to do this.")).toBeTruthy();
    expect(screen.getByTestId("website-promo-submit")).toBeTruthy();
  });

  it("hides create and edit without promotions.manage", async () => {
    const api = client();
    wrap(<PromotionsPanel client={api as never} canManage={false} context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    expect(screen.queryByTestId("website-promo-new")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const dialog = await screen.findByTestId("website-promo-detail");
    expect(await within(dialog).findByText("WEEKEND")).toBeTruthy();
    expect(within(dialog).queryByTestId("website-promo-add-code")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Disable" })).toBeNull();
  });
});

describe("Promotion detail and codes", () => {
  it("adds a code and disables one after confirmation", async () => {
    const withTwo = detail({
      codes: [
        ...detail().codes,
        {
          id: "c2",
          code: "VIP",
          status: "active",
          maxRedemptions: 5,
          redemptionCount: 0,
          remainingRedemptions: 5,
        },
      ],
    });
    const api = client({
      createPromotionCode: vi.fn().mockResolvedValue(withTwo),
      setPromotionCodeStatus: vi.fn().mockResolvedValue({
        ...withTwo,
        codes: withTwo.codes.map((code) =>
          code.id === "c1" ? { ...code, status: "disabled" } : code,
        ),
      }),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const dialog = await screen.findByTestId("website-promo-detail");
    await within(dialog).findByText("WEEKEND");

    fireEvent.change(within(dialog).getByTestId("website-promo-new-code"), {
      target: { value: "bad code" },
    });
    fireEvent.click(within(dialog).getByTestId("website-promo-add-code"));
    expect(await within(dialog).findByText(/Use only letters/)).toBeTruthy();
    expect(api.createPromotionCode).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByTestId("website-promo-new-code"), {
      target: { value: "vip" },
    });
    choose("Code use", "Custom limit");
    fireEvent.change(within(dialog).getByTestId("website-promo-code-limit"), {
      target: { value: "5" },
    });
    fireEvent.click(within(dialog).getByTestId("website-promo-add-code"));
    await waitFor(() =>
      expect(api.createPromotionCode).toHaveBeenCalledWith(
        expect.objectContaining({ promotionId: "p1", code: "VIP", maxRedemptions: 5 }),
      ),
    );
    expect(await within(dialog).findByTestId("website-promo-code-c2")).toBeTruthy();

    const first = within(dialog).getByTestId("website-promo-code-c1");
    fireEvent.click(within(first).getByRole("button", { name: "Disable" }));
    expect(api.setPromotionCodeStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("website-confirm"));
    await waitFor(() =>
      expect(api.setPromotionCodeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ codeId: "c1", status: "disabled" }),
      ),
    );
    expect(await within(first).findByText("Disabled")).toBeTruthy();
  });

  it("lists a promotion's products and variants by name", async () => {
    const api = client({
      getPromotion: vi.fn().mockResolvedValue(
        detail({
          targetType: "variant_scope",
          targets: [
            { productId: PRODUCT, variantId: null, productName: "Linen Shirt" },
            {
              productId: null,
              variantId: VARIANT,
              productName: "Linen Shirt",
              variantName: "Medium",
              sku: "LS-1-M",
            },
          ],
        }),
      ),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const list = await screen.findByTestId("website-promo-target-list");
    expect(within(list).getByText("Linen Shirt")).toBeTruthy();
    expect(within(list).getByText("Linen Shirt · Medium")).toBeTruthy();
  });

  it("deletes an unused promotion after confirmation", async () => {
    const api = client({
      listPromotions: vi
        .fn()
        .mockResolvedValue({ total: 1, items: [{ ...summary, redemptionCount: 0 }] }),
      deletePromotion: vi.fn().mockResolvedValue({ promotionId: "p1", outcome: "deleted" }),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/has never been used/)).toBeTruthy();
    expect(api.deletePromotion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("website-confirm"));
    await waitFor(() => expect(api.deletePromotion).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByTestId("website-promo-p1")).toBeNull());
    expect(await screen.findByText("“Weekend” deleted.")).toBeTruthy();
  });

  it("explains that a used promotion is archived, from its details", async () => {
    const api = client({
      getPromotion: vi.fn().mockResolvedValue(detail({ redemptionCount: 2 })),
      deletePromotion: vi.fn().mockResolvedValue({ promotionId: "p1", outcome: "archived" }),
    });
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByTestId("website-promo-delete"));
    expect(screen.getByText(/will be archived instead/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("website-confirm"));
    expect(await screen.findByText("“Weekend” archived — past orders keep it.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("website-promo-detail")).toBeNull());
    expect(api.listPromotions).toHaveBeenCalledTimes(2);
  });

  it("asks before pausing a promotion from the list", async () => {
    const api = client();
    wrap(<PromotionsPanel client={api as never} canManage catalogRead context={context} />);
    const row = await screen.findByTestId("website-promo-p1");
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    expect(api.setPromotionStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("website-confirm"));
    expect(await within(row).findByText("Paused")).toBeTruthy();
  });
});
