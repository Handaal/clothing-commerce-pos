// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { CatalogPanel, type CatalogClient } from "./CatalogPanel";
import { DeliveryPanel, type DeliveryClient } from "./DeliveryPanel";
import { PhotosPanel, type PhotosClient } from "./PhotosPanel";
import {
  ReturnRequestsPanel,
  SignupsPanel,
  type ReturnRequestsClient,
  type SignupsClient,
} from "./RequestsPanels";

beforeEach(() => window.localStorage.setItem("pos.lang", "en"));
afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <I18nProvider>
      <ToastProvider>{node}</ToastProvider>
    </I18nProvider>,
  );

const COL = "c0000000-0000-4000-8000-000000000001";
const CAT = "c0000000-0000-4000-8000-000000000002";
const VEN = "c0000000-0000-4000-8000-000000000003";
const PROD = "c0000000-0000-4000-8000-000000000004";
const M1 = "c0000000-0000-4000-8000-0000000000a1";
const M2 = "c0000000-0000-4000-8000-0000000000a2";
const BRAND = "c0000000-0000-4000-8000-000000000005";

function catalogClient() {
  return {
    listCollections: vi.fn(async () => ({
      collections: [
        {
          id: COL,
          name: "Summer",
          slug: "summer",
          description: null,
          status: "active",
          productCount: 2,
          image: null,
        },
      ],
    })),
    updateCollection: vi.fn(async () => ({ collectionId: COL })),
    setCollectionStatus: vi.fn(async () => ({ collectionId: COL, status: "draft" })),
    setCollectionImage: vi.fn(async () => ({ collectionId: COL, hasImage: true })),
    listCategories: vi.fn(async () => ({
      categories: [
        {
          id: CAT,
          parentId: null,
          name: "Shirts",
          slug: "shirts",
          description: null,
          position: 0,
          status: "active",
          productCount: 4,
          sizeGuide: null,
          image: { bucket: "product-media", path: "t/catalog/shirts.webp", altText: null },
        },
      ],
    })),
    updateCategory: vi.fn(async () => ({ categoryId: CAT })),
    setCategoryImage: vi.fn(async () => ({ categoryId: CAT, hasImage: false })),
    setCategorySizeGuide: vi.fn(async () => ({ categoryId: CAT, hasSizeGuide: true })),
    listVendors: vi.fn(async () => ({
      vendors: [
        { id: VEN, name: "Zara", slug: "zara", position: 0, status: "active", productCount: 3 },
      ],
    })),
    createVendor: vi.fn(async () => ({ vendorId: VEN, status: "active" })),
    updateVendor: vi.fn(async () => ({ vendorId: VEN })),
    setVendorStatus: vi.fn(async () => ({ vendorId: VEN, status: "archived" })),
    createCatalogImageIntent: vi.fn(async () => ({
      bucket: "product-media",
      path: "t/catalog/new.webp",
      contentType: "image/webp",
      uploadUrl: "https://storage.example/signed",
      expiresAt: null,
    })),
  };
}

describe("CatalogPanel", () => {
  it("renames a collection, unpublishes it and uploads a cover", async () => {
    const client = catalogClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    wrap(<CatalogPanel client={client as unknown as CatalogClient} />);
    fireEvent.click(await screen.findByTestId(`website-collection-edit-${COL}`));
    fireEvent.change(screen.getByTestId("website-collection-name"), {
      target: { value: "Summer 26" },
    });
    fireEvent.change(screen.getByTestId("website-collection-description"), {
      target: { value: "Linen and light layers." },
    });
    fireEvent.click(screen.getByTestId("website-collection-save"));
    await waitFor(() =>
      expect(client.updateCollection).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: COL,
          name: "Summer 26",
          slug: "summer",
          description: "Linen and light layers.",
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("website-collection-unpublish"));
    await waitFor(() =>
      expect(client.setCollectionStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "draft" }),
      ),
    );
    const file = new File(["x"], "cover.webp", { type: "image/webp" });
    fireEvent.change(await screen.findByTestId("website-collection-cover-file"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(client.setCollectionImage).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: COL,
          image: { bucket: "product-media", path: "t/catalog/new.webp", altText: null },
        }),
      ),
    );
    fetchSpy.mockRestore();
  });

  it("refuses a bad web address before calling the API", async () => {
    const client = catalogClient();
    wrap(<CatalogPanel client={client as unknown as CatalogClient} />);
    fireEvent.click(await screen.findByTestId(`website-collection-edit-${COL}`));
    fireEvent.change(screen.getByTestId("website-collection-slug"), {
      target: { value: "bad slug!" },
    });
    fireEvent.click(screen.getByTestId("website-collection-save"));
    expect(await screen.findByText("Use lowercase letters, numbers and dashes only.")).toBeTruthy();
    expect(client.updateCollection).not.toHaveBeenCalled();
  });

  it("edits a category, removes its image and saves a size guide", async () => {
    const client = catalogClient();
    wrap(<CatalogPanel client={client as unknown as CatalogClient} />);
    fireEvent.click(screen.getByTestId("website-catalog-categories"));
    fireEvent.click(await screen.findByTestId("website-category-edit-shirts"));
    fireEvent.change(screen.getByTestId("website-category-name"), {
      target: { value: "Shirts & Overshirts" },
    });
    fireEvent.click(screen.getByTestId("website-category-save"));
    await waitFor(() =>
      expect(client.updateCategory).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: CAT,
          name: "Shirts & Overshirts",
          position: 0,
          parentId: null,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("website-category-image-remove"));
    await waitFor(() =>
      expect(client.setCategoryImage).toHaveBeenCalledWith(
        expect.objectContaining({ image: null }),
      ),
    );
    fireEvent.change(screen.getByTestId("website-guide-columns"), {
      target: { value: "Chest, Length" },
    });
    fireEvent.change(screen.getByTestId("website-guide-values-0"), {
      target: { value: "100, 72" },
    });
    fireEvent.click(screen.getByTestId("website-guide-save"));
    await waitFor(() =>
      expect(client.setCategorySizeGuide).toHaveBeenCalledWith(
        expect.objectContaining({
          sizeGuide: expect.objectContaining({
            columns: ["Chest", "Length"],
            rows: [{ size: "M", values: ["100", "72"] }],
          }),
        }),
      ),
    );
  });

  it("adds, renames and hides brands", async () => {
    const client = catalogClient();
    wrap(<CatalogPanel client={client as unknown as CatalogClient} />);
    fireEvent.click(screen.getByTestId("website-catalog-brands"));
    fireEvent.change(await screen.findByTestId("website-brand-new"), {
      target: { value: "Nile Label" },
    });
    fireEvent.click(screen.getByTestId("website-brand-add"));
    await waitFor(() =>
      expect(client.createVendor).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Nile Label", slug: "nile-label" }),
      ),
    );
    fireEvent.change(await screen.findByTestId("website-brand-name-zara"), {
      target: { value: "ZARA" },
    });
    fireEvent.click(screen.getByTestId("website-brand-save-zara"));
    await waitFor(() =>
      expect(client.updateVendor).toHaveBeenCalledWith(
        expect.objectContaining({ vendorId: VEN, name: "ZARA", slug: "zara" }),
      ),
    );
    fireEvent.click(screen.getByTestId("website-brand-status-zara"));
    await waitFor(() =>
      expect(client.setVendorStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "archived" }),
      ),
    );
  });
});

describe("PhotosPanel", () => {
  it("lists a product's photos, makes one main, reorders, describes and removes", async () => {
    const photo = (id: string, isPrimary: boolean, position: number) => ({
      id,
      variantId: null,
      bucket: "product-media",
      path: `t/p/${id}.webp`,
      altText: null,
      position,
      isPrimary,
    });
    const client = {
      listProducts: vi.fn(async () => ({
        items: [
          { id: PROD, name: "Linen Shirt", styleCode: "LS-1", status: "active", brandId: BRAND },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      })),
      listProductMedia: vi.fn(async () => ({ media: [photo(M1, true, 0), photo(M2, false, 1)] })),
      createProductMediaUploadIntent: vi.fn(),
      registerProductMedia: vi.fn(),
      updateProductMedia: vi.fn(async () => ({ mediaId: M2, isPrimary: true, altText: null })),
      reorderProductMedia: vi.fn(async () => ({ productId: PROD, mediaCount: 2 })),
      archiveProductMedia: vi.fn(async () => ({ mediaId: M2 })),
    };
    wrap(<PhotosPanel client={client as unknown as PhotosClient} />);
    fireEvent.click(await screen.findByTestId(`website-photos-product-${PROD}`));
    await screen.findByTestId(`website-photo-${M1}`);
    expect(screen.queryByTestId(`website-photo-main-${M1}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`website-photo-main-${M2}`));
    await waitFor(() =>
      expect(client.updateProductMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediaId: M2, isPrimary: true }),
      ),
    );
    fireEvent.click(await screen.findByTestId(`website-photo-down-${M1}`));
    await waitFor(() =>
      expect(client.reorderProductMedia).toHaveBeenCalledWith(
        expect.objectContaining({ productId: PROD, mediaIds: [M2, M1] }),
      ),
    );
    fireEvent.change(await screen.findByTestId(`website-photo-alt-${M2}`), {
      target: { value: "Back" },
    });
    fireEvent.click(screen.getByTestId(`website-photo-alt-save-${M2}`));
    await waitFor(() =>
      expect(client.updateProductMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediaId: M2, altText: "Back" }),
      ),
    );
    fireEvent.click(await screen.findByTestId(`website-photo-remove-${M2}`));
    await waitFor(() =>
      expect(client.archiveProductMedia).toHaveBeenCalledWith(
        expect.objectContaining({ productId: PROD, mediaId: M2 }),
      ),
    );
  });
});

describe("DeliveryPanel", () => {
  it("edits fees and the free-delivery threshold in money units", async () => {
    const client = {
      listStorefrontSettings: vi.fn(async () => ({
        items: [
          {
            tenantId: "t",
            brandId: BRAND,
            inventoryLocationId: "l",
            currency: "EGP",
            codEnabled: true,
          },
        ],
      })),
      listBrands: vi.fn(async () => ({ items: [{ id: BRAND, displayName: "Zee" }] })),
      getStorefrontDeliverySettings: vi.fn(async () => ({
        brandId: BRAND,
        currency: "EGP",
        freeDeliveryThresholdMinor: 150000,
        zones: [{ code: "EG-C", name: "Cairo", feeMinor: 5000, active: true, position: 0 }],
      })),
      updateStorefrontDeliverySettings: vi.fn(async (input: unknown) => input),
    };
    wrap(<DeliveryPanel client={client as unknown as DeliveryClient} canManage />);
    expect(
      ((await screen.findByTestId("website-delivery-threshold")) as HTMLInputElement).value,
    ).toBe("1500");
    fireEvent.change(screen.getByTestId("website-zone-fee-0"), { target: { value: "60.50" } });
    fireEvent.click(screen.getByTestId("website-zone-add"));
    fireEvent.change(screen.getByTestId("website-zone-code-1"), { target: { value: "eg-alx" } });
    fireEvent.change(screen.getByTestId("website-zone-name-1"), {
      target: { value: "Alexandria" },
    });
    fireEvent.change(screen.getByTestId("website-zone-fee-1"), { target: { value: "70" } });
    fireEvent.click(screen.getByTestId("website-delivery-save"));
    await waitFor(() =>
      expect(client.updateStorefrontDeliverySettings).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: BRAND,
          freeDeliveryThresholdMinor: 150000,
          zones: [
            { code: "EG-C", name: "Cairo", feeMinor: 6050, active: true, position: 0 },
            { code: "EG-ALX", name: "Alexandria", feeMinor: 7000, active: true, position: 1 },
          ],
        }),
      ),
    );
  });

  it("is read-only without settings.manage", async () => {
    const client = {
      listStorefrontSettings: vi.fn(async () => ({
        items: [
          {
            tenantId: "t",
            brandId: BRAND,
            inventoryLocationId: "l",
            currency: "EGP",
            codEnabled: true,
          },
        ],
      })),
      listBrands: vi.fn(async () => ({ items: [] })),
      getStorefrontDeliverySettings: vi.fn(async () => ({
        brandId: BRAND,
        currency: "EGP",
        freeDeliveryThresholdMinor: null,
        zones: [],
      })),
      updateStorefrontDeliverySettings: vi.fn(),
    };
    wrap(<DeliveryPanel client={client as unknown as DeliveryClient} canManage={false} />);
    expect(
      ((await screen.findByTestId("website-delivery-save")) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Return requests and sign-ups", () => {
  it("approves a waiting return with a note", async () => {
    const request = {
      id: "r1000000-0000-4000-8000-000000000001".replace("r", "a"),
      reference: "R-1042",
      orderId: PROD,
      orderNumber: "1042",
      brandId: BRAND,
      status: "requested",
      preference: "exchange",
      customerNote: "Too tight",
      staffNote: null,
      customerName: "Mona",
      customerPhone: "+201000000001",
      createdAt: "2026-11-24T10:00:00.000Z",
      decidedAt: null,
      lines: [
        {
          lineNumber: 1,
          productName: "Linen Shirt",
          variantName: null,
          optionSummary: "M",
          sku: "LS-M",
          quantity: 1,
          reason: "too_small",
        },
      ],
    };
    const client = {
      listReturnRequests: vi.fn(async () => ({ requests: [request], awaitingDecision: 1 })),
      updateReturnRequestStatus: vi.fn(async () => ({ ...request, status: "approved" })),
    };
    wrap(<ReturnRequestsPanel client={client as unknown as ReturnRequestsClient} />);
    const card = await screen.findByTestId("website-return-R-1042");
    expect(within(card).getByText(/Too small/)).toBeTruthy();
    fireEvent.change(screen.getByTestId("website-return-note-R-1042"), {
      target: { value: "Pickup Sunday" },
    });
    fireEvent.click(screen.getByTestId("website-return-approve-R-1042"));
    await waitFor(() =>
      expect(client.updateReturnRequestStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: request.id,
          status: "approved",
          note: "Pickup Sunday",
        }),
      ),
    );
  });

  it("lists sign-ups with the total", async () => {
    const client = {
      listSubscribers: vi.fn(async () => ({
        subscribers: [
          {
            id: "s1",
            email: "fan@example.com",
            brandId: null,
            source: "home",
            createdAt: "2026-11-20T10:00:00.000Z",
          },
        ],
        total: 1,
      })),
    };
    wrap(<SignupsPanel client={client as unknown as SignupsClient} />);
    expect(await screen.findByText("fan@example.com")).toBeTruthy();
    expect(screen.getByTestId("website-signups-download")).toBeTruthy();
  });
});
