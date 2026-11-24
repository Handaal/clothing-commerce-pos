// @vitest-environment jsdom
/// <reference types="node" />
import process from "node:process";
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { WebsiteDesk } from "./WebsiteDesk";

// Site text (SDK 0.52) through the REAL POS Website desk against a disposable loopback API: /me/context,
// the tab, the panel, the SDK and every request are real. Skipped unless the cross-repo website
// acceptance (website-site-text-acceptance.mjs) supplies the API; it runs after Admin Mobile's edits.
const url = process.env.POS_WEBSITE_TEST_URL;
const tenantId = "2a000001-0000-4000-8000-000000000001";
configure({ asyncUtilTimeout: 15000 });
afterEach(cleanup);

describe.skipIf(!url)("POS Website → Site text with the real API", () => {
  it("opens the desk, sees Admin Mobile's text, edits more and saves", async () => {
    window.localStorage.setItem("pos.lang", "en");
    const sdk = createCommerceClient({
      baseUrl: url!,
      getToken: () => process.env.POS_WEBSITE_TEST_TOKEN,
      client: { type: "pos-desktop", version: "0.1.0" },
    });
    render(
      <I18nProvider>
        <ToastProvider>
          <WebsiteDesk client={sdk.withTenant(tenantId)} />
        </ToastProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByTestId("website-open-siteText"));

    // Admin Mobile saved these moments ago; the POS loads the same document.
    const storeName = (await screen.findByTestId("website-site-text-storeName")) as HTMLInputElement;
    expect(storeName.value).toBe("Nile Wear");
    expect(screen.getByTestId("website-site-text-announcements-0")).toHaveProperty(
      "value",
      "Mobile promo: free returns",
    );

    const set = (key: string, value: string) =>
      fireEvent.change(screen.getByTestId(`website-site-text-${key}`), { target: { value } });
    set("collectionsTitle", "POS picks: the linen edit");
    set("contactHours", "Daily, 11:00–22:00");
    set("contactWhatsapp", "201001234567");
    set("announcements-1", "POS promo: cash on delivery");
    fireEvent.click(screen.getByTestId("website-site-text-termsSections-customize"));
    set("termsSections-0-a", "Prices");
    set("termsSections-0-b", "Prices include VAT.\n\n- Shown in EGP\n- Confirmed at checkout");
    fireEvent.click(screen.getByTestId("website-site-text-save"));
    expect(await screen.findByText(/Site text saved/)).toBeTruthy();

    const { siteText } = await createCommerceClient({ baseUrl: url! }).getPublicStorefrontSiteText({
      tenantId,
    });
    expect(siteText).toMatchObject({
      storeName: "Nile Wear", // Admin Mobile's edit survives the POS save
      collectionsTitle: "POS picks: the linen edit",
      contactHours: "Daily, 11:00–22:00",
      contactWhatsapp: "201001234567",
      announcements: ["Mobile promo: free returns", "POS promo: cash on delivery"],
    });
    expect(siteText.termsSections?.[0]).toEqual({
      heading: "Prices",
      body: "Prices include VAT.\n\n- Shown in EGP\n- Confirmed at checkout",
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("website-site-text-save") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });
});
