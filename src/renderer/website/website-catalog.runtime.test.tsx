// @vitest-environment jsdom
/// <reference types="node" />
import process from "node:process";
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { WebsiteDesk } from "./WebsiteDesk";

// Website catalog parity (SDK 0.53) through the REAL POS Website desk against a disposable loopback API:
// rename a category and a brand, change a delivery fee, and choose a product's main photo. Skipped unless
// website-site-text-acceptance.mjs supplies the API (it runs after Admin Mobile's catalog edits).
const url = process.env.POS_WEBSITE_TEST_URL;
const tenantId = "2a000001-0000-4000-8000-000000000001";
const brandId = "2a000002-0000-4000-8000-000000000001";
const productId = "2a000006-0000-4000-8000-000000000001";
configure({ asyncUtilTimeout: 15000 });
afterEach(cleanup);

describe.skipIf(!url)("POS Website catalog tabs with the real API", { timeout: 60000 }, () => {
  const sdk = () =>
    createCommerceClient({
      baseUrl: url!,
      getToken: () => process.env.POS_WEBSITE_TEST_TOKEN,
      client: { type: "pos-desktop", version: "0.1.0" },
    }).withTenant(tenantId);

  const mount = () => {
    window.localStorage.setItem("pos.lang", "en");
    render(
      <I18nProvider>
        <ToastProvider>
          <WebsiteDesk client={sdk()} />
        </ToastProvider>
      </I18nProvider>,
    );
  };

  it("renames a category and a brand from the Catalog tab", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("website-open-catalog"));
    fireEvent.click(await screen.findByTestId("website-catalog-categories"));
    const categories = (await sdk().listCategories()).categories;
    const category = categories.find((c) => c.name === "Shirts & Overshirts")!;
    fireEvent.click(await screen.findByTestId(`website-category-edit-${category.slug}`));
    fireEvent.change(screen.getByTestId("website-category-name"), {
      target: { value: "POS Shirts" },
    });
    fireEvent.click(screen.getByTestId("website-category-save"));
    await waitFor(async () => {
      const pub = await createCommerceClient({ baseUrl: url! }).listStorefrontCategories({
        tenantId,
      });
      expect(pub.categories.find((c) => c.id === category.id)?.name).toBe("POS Shirts");
    });

    fireEvent.click(screen.getByTestId("website-catalog-brands"));
    const vendor = (await sdk().listVendors()).vendors.find((v) => v.name === "Zee Label")!;
    fireEvent.change(await screen.findByTestId(`website-brand-name-${vendor.slug}`), {
      target: { value: "Zee Label POS" },
    });
    fireEvent.click(screen.getByTestId(`website-brand-save-${vendor.slug}`));
    await waitFor(async () => {
      const pub = await createCommerceClient({ baseUrl: url! }).listStorefrontVendors({ tenantId });
      expect(JSON.stringify(pub)).toContain("Zee Label POS");
    });
  });

  it("changes a delivery fee and the main product photo", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("website-open-delivery"));
    fireEvent.change(await screen.findByTestId("website-zone-fee-0"), { target: { value: "65" } });
    fireEvent.click(screen.getByTestId("website-delivery-save"));
    await waitFor(async () => {
      const pub = await createCommerceClient({ baseUrl: url! }).getStorefrontDeliveryOptions({
        tenantId,
        brandId,
      });
      expect(pub.zones[0]!.feeMinor).toBe(6500);
    });
    cleanup();

    mount();
    fireEvent.click(await screen.findByTestId("website-open-photos"));
    fireEvent.click(await screen.findByTestId(`website-photos-product-${productId}`));
    const media = (await sdk().listProductMedia(productId)).media;
    const other = media.find((m) => !m.isPrimary)!;
    fireEvent.click(await screen.findByTestId(`website-photo-main-${other.id}`));
    await waitFor(async () => {
      const after = (await sdk().listProductMedia(productId)).media;
      expect(after[0]).toMatchObject({ id: other.id, isPrimary: true });
    });
  });
});
