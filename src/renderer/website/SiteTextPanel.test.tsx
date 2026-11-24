// @vitest-environment jsdom

import { SITE_TEXT_GROUPS, type StorefrontSiteText } from "@shifted/clothing-commerce-sdk";
import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ToastProvider } from "../shell/Toast";
import { SiteTextPanel, type SiteTextClient } from "./SiteTextPanel";

beforeEach(() => window.localStorage.setItem("pos.lang", "en"));
afterEach(cleanup);

function wrap(client: SiteTextClient) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <SiteTextPanel client={client} />
      </ToastProvider>
    </I18nProvider>,
  );
}

function fakeClient(initial: StorefrontSiteText = { siteText: {}, updatedAt: null }) {
  const update = vi.fn(
    async ({ siteText }: { siteText: Record<string, unknown>; idempotencyKey: string }) => ({
      siteText: Object.fromEntries(Object.entries(siteText).filter(([, v]) => v !== null)),
      updatedAt: "2026-11-24T10:00:00.000Z",
    }),
  );
  const client = {
    getStorefrontSiteText: vi.fn(async () => initial),
    updateStorefrontSiteText: update,
  } as unknown as SiteTextClient;
  return { client, update };
}

const field = (key: string) => screen.getByTestId(`website-site-text-${key}`) as HTMLInputElement;

describe("SiteTextPanel", () => {
  it("shows every group with the built-in text as placeholders, and nothing to save yet", async () => {
    const { client } = fakeClient();
    wrap(client);
    for (const group of SITE_TEXT_GROUPS) {
      expect(await screen.findByTestId(`website-site-text-${group.id}`)).toBeTruthy();
    }
    expect(field("bestSellersTitle").placeholder).toBe("Best sellers");
    expect(field("termsIntro").placeholder).toContain("Zee Store");
    expect((screen.getByTestId("website-site-text-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves edited text, a custom FAQ and contact details", async () => {
    const { client, update } = fakeClient();
    wrap(client);
    fireEvent.change(await screen.findByTestId("website-site-text-collectionsTitle"), {
      target: { value: "Shop the drops" },
    });
    fireEvent.change(field("contactWhatsapp"), { target: { value: "201001234567" } });
    fireEvent.click(screen.getByTestId("website-site-text-faqItems-customize"));
    fireEvent.change(screen.getByTestId("website-site-text-faqItems-0-a"), {
      target: { value: "Do you deliver to Aswan?" },
    });
    fireEvent.click(screen.getByTestId("website-site-text-faqItems-1-up"));
    fireEvent.click(screen.getByTestId("website-site-text-save"));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const sent = update.mock.calls[0]![0].siteText as Record<string, unknown>;
    expect(sent.collectionsTitle).toBe("Shop the drops");
    expect(sent.contactWhatsapp).toBe("201001234567");
    expect(sent.newArrivalsTitle).toBeNull();
    const faq = sent.faqItems as { question: string }[];
    expect(faq[0]!.question).toBe("How do I pay?");
    expect(faq[1]!.question).toBe("Do you deliver to Aswan?");
    expect(await screen.findByText(/Site text saved/)).toBeTruthy();
  });

  it("an empty promo list hides the bar and is saved as []", async () => {
    const { client, update } = fakeClient({
      siteText: { announcements: ["Only one"] },
      updatedAt: "2026-11-23T10:00:00.000Z",
    });
    wrap(client);
    fireEvent.click(await screen.findByTestId("website-site-text-announcements-0-remove"));
    expect(screen.getByText("No messages — the promo bar is hidden.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("website-site-text-save"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0].siteText).toMatchObject({ announcements: [] });
  });

  it("refuses invalid values before calling the API", async () => {
    const { client, update } = fakeClient();
    wrap(client);
    fireEvent.change(await screen.findByTestId("website-site-text-contactWhatsapp"), {
      target: { value: "+20 100" },
    });
    fireEvent.change(field("newArrivalsLink"), { target: { value: "x".repeat(41) } });
    fireEvent.click(screen.getByTestId("website-site-text-save"));
    expect(
      await screen.findByText("Digits only with the country code (8–15 digits)."),
    ).toBeTruthy();
    expect(screen.getByText("Keep it to 40 characters.")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("explains a refused save and keeps the edits", async () => {
    const { client, update } = fakeClient();
    update.mockRejectedValueOnce(new ApiHttpError("Forbidden", 403, "FORBIDDEN", "req-1"));
    wrap(client);
    fireEvent.change(await screen.findByTestId("website-site-text-footerTagline"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByTestId("website-site-text-save"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(field("footerTagline").value).toBe("Hello");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("uses Arabic labels when the till is in Arabic", async () => {
    window.localStorage.setItem("pos.lang", "ar");
    const { client } = fakeClient();
    wrap(client);
    expect(await screen.findByText("الشريط الترويجي")).toBeTruthy();
    expect(screen.getByText("نصوص الموقع", { exact: false })).toBeTruthy();
  });
});
