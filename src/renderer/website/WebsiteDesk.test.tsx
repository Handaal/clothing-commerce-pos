// @vitest-environment jsdom

import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { CheckoutPanel } from "./CheckoutPanel";
import { HomePagePanel } from "./HomePagePanel";
import { PromotionsPanel } from "./PromotionsPanel";
import { PublicationPanel } from "./PublicationPanel";
import { SalesPanel } from "./SalesPanel";
import { WebsiteDesk } from "./WebsiteDesk";

afterEach(cleanup);

const NOW = "2026-11-18T10:00:00.000Z";
const BRAND = "11111111-1111-4111-8111-111111111111";
const LOCATION = "22222222-2222-4222-8222-222222222222";
const PRODUCT_A = "33333333-3333-4333-8333-333333333333";
const PRODUCT_B = "44444444-4444-4444-8444-444444444444";
const SALE = "55555555-5555-4555-8555-555555555555";

function wrap(node: React.ReactNode) {
  return render(
    <I18nProvider>
      <ToastProvider>{node}</ToastProvider>
    </I18nProvider>,
  );
}

function context(access: {
  catalog?: boolean;
  promotions?: [boolean, boolean];
  settings?: [boolean, boolean];
}) {
  return {
    access: {
      catalog: { canRead: access.catalog ?? false, tenantWide: true, brands: [] },
      ...(access.promotions
        ? { promotions: { canRead: access.promotions[0], canManage: access.promotions[1] } }
        : {}),
      ...(access.settings
        ? { settings: { canRead: access.settings[0], canManage: access.settings[1] } }
        : {}),
    },
  };
}

const products = {
  items: [
    { id: PRODUCT_A, name: "Linen Shirt", styleCode: "LS-1", status: "active", brandId: BRAND },
    { id: PRODUCT_B, name: "Old Tee", styleCode: "OT-9", status: "archived", brandId: BRAND },
  ],
  pageInfo: { hasMore: false, nextCursor: null },
};

function sale(overrides: Record<string, unknown> = {}) {
  return {
    id: SALE,
    name: "Summer",
    status: "active",
    benefitType: "percentage",
    benefitPercentBp: 2000,
    benefitAmountMinor: null,
    benefitCurrency: null,
    scope: "all",
    collectionId: null,
    productIds: [],
    startsAt: null,
    endsAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("WebsiteDesk access", () => {
  it("shows only the areas the server allows", async () => {
    const client = {
      getContext: vi.fn().mockResolvedValue(context({ catalog: true })),
    } as unknown as TenantCommerceClient;
    wrap(<WebsiteDesk client={client} />);
    const tabs = await screen.findByRole("navigation", { name: "Website Management" });
    const labels = within(tabs)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["Overview", "Home page", "Site text", "Catalog publication"]);
    expect(screen.getByText("You don't have access to view checkout settings.")).toBeTruthy();
  });

  it("explains when the operator has no website permissions at all", async () => {
    const client = {
      getContext: vi.fn().mockResolvedValue(context({ promotions: [false, true] })),
    } as unknown as TenantCommerceClient;
    wrap(<WebsiteDesk client={client} />);
    expect(await screen.findByTestId("website-no-access")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Website Management" })).toBeNull();
  });

  it("fails closed when access cannot be loaded, and retries", async () => {
    const getContext = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(context({ settings: [true, true] }));
    const client = {
      getContext,
      listStorefrontSettings: vi.fn().mockResolvedValue({
        items: [
          {
            tenantId: BRAND,
            brandId: BRAND,
            inventoryLocationId: LOCATION,
            currency: "EGP",
            codEnabled: true,
          },
        ],
      }),
      listBrands: vi.fn().mockResolvedValue({
        items: [{ id: BRAND, displayName: "Zee", status: "active" }],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    } as unknown as TenantCommerceClient;
    wrap(<WebsiteDesk client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId(`website-overview-brand-${BRAND}`)).toBeTruthy();
    expect(screen.getByText("Zee")).toBeTruthy();
    expect(getContext).toHaveBeenCalledTimes(2);
  });
});

describe("SalesPanel", () => {
  it("creates a sale with the mobile request shape", async () => {
    const createSale = vi.fn().mockResolvedValue(sale({ name: "Weekend", benefitPercentBp: 1500 }));
    const client = {
      listSales: vi.fn().mockResolvedValue({ items: [] }),
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
      createSale,
    } as never;
    wrap(<SalesPanel client={client} canManage />);
    expect(await screen.findByText("No sales yet.")).toBeTruthy();

    fireEvent.click(screen.getByTestId("website-sale-new"));
    fireEvent.click(screen.getByTestId("website-sale-submit"));
    expect(await screen.findByText("Give the sale a name.")).toBeTruthy();
    expect(createSale).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("website-sale-name"), { target: { value: "Weekend" } });
    fireEvent.change(screen.getByTestId("website-sale-value"), { target: { value: "15" } });
    expect(screen.getByTestId("website-sale-preview").textContent).toContain("-15% OFF");
    fireEvent.click(screen.getByTestId("website-sale-submit"));

    await waitFor(() => expect(createSale).toHaveBeenCalledTimes(1));
    expect(createSale.mock.calls[0][0]).toMatchObject({
      name: "Weekend",
      benefitType: "percentage",
      benefitPercentBp: 1500,
      scope: "all",
      status: "active",
      startsAt: null,
      endsAt: null,
    });
    expect(typeof createSale.mock.calls[0][0].idempotencyKey).toBe("string");
    expect(await screen.findByTestId(`website-sale-${SALE}`)).toBeTruthy();
  });

  it("asks before deleting, and pauses without a prompt", async () => {
    const deleteSale = vi.fn().mockResolvedValue({ deleted: true });
    const setSaleStatus = vi.fn().mockResolvedValue(sale({ status: "inactive" }));
    const client = {
      listSales: vi.fn().mockResolvedValue({ items: [sale()] }),
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
      deleteSale,
      setSaleStatus,
    } as never;
    wrap(<SalesPanel client={client} canManage />);
    const row = await screen.findByTestId(`website-sale-${SALE}`);
    expect(within(row).getByText("Live")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(setSaleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ saleId: SALE, status: "inactive" }),
      ),
    );
    expect(await within(row).findByText("Paused")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(deleteSale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("website-confirm"));
    await waitFor(() => expect(deleteSale).toHaveBeenCalledWith(SALE));
    await waitFor(() => expect(screen.queryByTestId(`website-sale-${SALE}`)).toBeNull());
  });

  it("is read-only without promotions.manage", async () => {
    const client = {
      listSales: vi.fn().mockResolvedValue({ items: [sale()] }),
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
    } as never;
    wrap(<SalesPanel client={client} canManage={false} />);
    await screen.findByTestId(`website-sale-${SALE}`);
    expect(screen.queryByTestId("website-sale-new")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("You can view this area but not change it.")).toBeTruthy();
  });

  it("shows a retryable error when the list fails", async () => {
    const listSales = vi
      .fn()
      .mockRejectedValueOnce(new ApiHttpError("no", 403, "FORBIDDEN", null))
      .mockResolvedValueOnce({ items: [] });
    const client = {
      listSales,
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
    } as never;
    wrap(<SalesPanel client={client} canManage />);
    expect(await screen.findByText("Your account isn't allowed to do this.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No sales yet.")).toBeTruthy();
  });
});

describe("HomePagePanel", () => {
  const content = {
    hero: {
      eyebrow: null,
      title: "Hello",
      subtitle: null,
      ctaLabel: null,
      ctaHref: null,
      image: null,
    },
    featuredHeading: null,
    featuredProductIds: [],
    featuredCollectionIds: [],
  };

  it("edits the hero, uploads an image, picks featured products and saves", async () => {
    const updateStorefrontContent = vi.fn().mockImplementation(async (input) => ({
      hero: { ...input.hero },
      featuredHeading: input.featuredHeading,
      featuredProductIds: input.featuredProductIds,
      featuredCollectionIds: input.featuredCollectionIds,
    }));
    const createStorefrontHeroImageIntent = vi.fn().mockResolvedValue({
      bucket: "media",
      path: "storefront/hero.png",
      contentType: "image/png",
      uploadUrl: "https://storage.example/upload",
      expiresAt: null,
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = {
      getStorefrontContent: vi.fn().mockResolvedValue(content),
      updateStorefrontContent,
      createStorefrontHeroImageIntent,
      listProducts: vi.fn().mockResolvedValue(products),
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
    } as never;
    wrap(<HomePagePanel client={client} fetchImpl={fetchImpl as never} />);

    const title = await screen.findByTestId("website-hero-title");
    expect((screen.getByTestId("website-home-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(title, { target: { value: "Summer drop" } });
    fireEvent.change(screen.getByTestId("website-hero-ctaLabel"), { target: { value: "Shop" } });
    fireEvent.click(screen.getByTestId("website-home-save"));
    expect(await screen.findByText("Add where the button should go.")).toBeTruthy();
    expect(updateStorefrontContent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("website-hero-ctaHref"), { target: { value: "/catalog" } });

    const file = new File(["png"], "hero.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("website-hero-file"), { target: { files: [file] } });
    await waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://storage.example/upload",
        expect.objectContaining({ method: "PUT", body: file }),
      ),
    );
    expect(createStorefrontHeroImageIntent).toHaveBeenCalledWith({
      contentType: "image/png",
      fileName: "hero.png",
    });

    const picker = await screen.findByTestId("website-featured-products");
    fireEvent.click(within(picker).getByRole("checkbox", { name: /Linen Shirt/ }));

    fireEvent.click(screen.getByTestId("website-home-save"));
    await waitFor(() => expect(updateStorefrontContent).toHaveBeenCalledTimes(1));
    expect(updateStorefrontContent.mock.calls[0][0]).toMatchObject({
      hero: {
        title: "Summer drop",
        ctaLabel: "Shop",
        ctaHref: "/catalog",
        image: { bucket: "media", path: "storefront/hero.png", altText: null },
      },
      featuredProductIds: [PRODUCT_A],
    });
  });

  it("rejects a non-image file without calling the API", async () => {
    const createStorefrontHeroImageIntent = vi.fn();
    const client = {
      getStorefrontContent: vi.fn().mockResolvedValue(content),
      createStorefrontHeroImageIntent,
      listProducts: vi.fn().mockResolvedValue(products),
      listCollections: vi.fn().mockResolvedValue({ collections: [] }),
    } as never;
    wrap(<HomePagePanel client={client} />);
    const input = await screen.findByTestId("website-hero-file");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "doc.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText("Use a JPEG, PNG, WebP or AVIF image.")).toBeTruthy();
    expect(createStorefrontHeroImageIntent).not.toHaveBeenCalled();
  });
});

describe("PublicationPanel", () => {
  it("publishes active products and confirms before unpublishing", async () => {
    const publishProduct = vi
      .fn()
      .mockResolvedValue({ productId: PRODUCT_A, storefrontStatus: "published", publishedAt: NOW });
    const unpublishProduct = vi
      .fn()
      .mockResolvedValue({ productId: PRODUCT_A, storefrontStatus: "unpublished" });
    const client = {
      listProducts: vi.fn().mockResolvedValue(products),
      publishProduct,
      unpublishProduct,
    } as never;
    wrap(<PublicationPanel client={client} />);
    const row = await screen.findByTestId(`website-product-${PRODUCT_A}`);
    // The archived product is filtered out by the default "Active" lifecycle filter.
    expect(screen.queryByTestId(`website-product-${PRODUCT_B}`)).toBeNull();
    expect(within(row).getByText("Not checked this session")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Publish" }));
    expect(await within(row).findByText("Published")).toBeTruthy();
    expect(publishProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: PRODUCT_A }));

    fireEvent.click(within(row).getByRole("button", { name: "Unpublish" }));
    expect(unpublishProduct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("website-confirm"));
    expect(await within(row).findByText("Not published")).toBeTruthy();
  });
});

describe("PromotionsPanel", () => {
  it("lists promotions and lets a manager pause one", async () => {
    const setPromotionStatus = vi.fn().mockResolvedValue({ status: "inactive" });
    const client = {
      listPromotions: vi.fn().mockResolvedValue({
        total: 1,
        items: [
          {
            id: "p1",
            name: "Free shipping week",
            status: "active",
            benefitType: "percentage",
            targetType: "order",
            activationType: "automatic",
            channel: "online",
            redemptionCount: 3,
            globalRedemptionLimit: 10,
            economicsLocked: false,
            createdAt: NOW,
          },
        ],
      }),
      setPromotionStatus,
    } as never;
    const onOpenVouchers = vi.fn();
    wrap(<PromotionsPanel client={client} canManage onOpenVouchers={onOpenVouchers} />);
    const row = await screen.findByTestId("website-promo-p1");
    expect(within(row).getByText("Website only")).toBeTruthy();
    expect(within(row).getByText("3 / 10")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByTestId("website-confirm"));
    expect(await within(row).findByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Vouchers" }));
    expect(onOpenVouchers).toHaveBeenCalled();
  });
});

describe("CheckoutPanel", () => {
  const base = () => ({
    listStorefrontSettings: vi.fn().mockResolvedValue({
      items: [
        {
          tenantId: BRAND,
          brandId: BRAND,
          inventoryLocationId: LOCATION,
          currency: "EGP",
          codEnabled: true,
        },
      ],
    }),
    listBrands: vi.fn().mockResolvedValue({
      items: [{ id: BRAND, displayName: "Zee", status: "active" }],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    listInventoryLocations: vi.fn().mockResolvedValue({
      items: [{ id: LOCATION, displayName: "Main warehouse", status: "active" }],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    getReturnSettings: vi.fn().mockResolvedValue({
      tenantId: BRAND,
      enabled: true,
      windowDays: 14,
      allowedReasons: [],
      manualRefundsEnabled: false,
      maxManualRefundMinor: null,
    }),
    updateReturnSettings: vi.fn(),
  });

  it("turns off cash on delivery for a brand with the operating currency", async () => {
    const upsertStorefrontSettings = vi.fn().mockResolvedValue({
      tenantId: BRAND,
      brandId: BRAND,
      inventoryLocationId: LOCATION,
      currency: "EGP",
      codEnabled: false,
    });
    const client = { ...base(), upsertStorefrontSettings } as never;
    wrap(<CheckoutPanel client={client} canManage />);
    const row = await screen.findByTestId(`website-checkout-${BRAND}`);
    expect(within(row).getByText("Main warehouse")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("website-checkout-cod"));
    fireEvent.click(screen.getByTestId("website-checkout-save"));
    await waitFor(() =>
      expect(upsertStorefrontSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: BRAND,
          inventoryLocationId: LOCATION,
          currency: "EGP",
          codEnabled: false,
        }),
      ),
    );
    expect(await within(row).findByText("Off")).toBeTruthy();
    // The reused returns-policy editor renders below with its save controls.
    expect((await screen.findAllByRole("button", { name: "Save changes" })).length).toBe(1);
  });

  it("is read-only without settings.manage, including the returns policy", async () => {
    const client = { ...base(), upsertStorefrontSettings: vi.fn() } as never;
    wrap(<CheckoutPanel client={client} canManage={false} />);
    const row = await screen.findByTestId(`website-checkout-${BRAND}`);
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0));
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
