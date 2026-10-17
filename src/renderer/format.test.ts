import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, formatTime } from "./format";
import { formatMoney, currencySymbol } from "./money";

// The Arabic locale for this market is ar-EG, which renders Western (Latin) digits — the retail
// convention for prices and receipts. These tests pin that behaviour so a future locale change is
// a deliberate, visible decision.
describe("locale-aware formatting", () => {
  it("formats currency with Western digits under ar-EG", () => {
    const egp = formatMoney(125_000, "EGP", "ar-EG-u-nu-latn");
    // Western digits, not Arabic-Indic (٠-٩).
    expect(egp).toMatch(/1[,.]?250/);
    expect(egp).not.toMatch(/[٠-٩]/);
  });

  it("coerces every amount to EGP regardless of the currency code passed", () => {
    // The business is EGP-only: a "USD" code (dev fixtures still carry it) must never render as "$".
    const formatted = formatMoney(2_599, "USD", "en-US");
    expect(formatted).not.toMatch(/\$/);
    expect(formatted).toMatch(/EGP|E£|ج\.?م/);
    expect(formatted).toMatch(/25\.99/);
  });

  it("exposes an EGP currency symbol, never a '$'", () => {
    const symbol = currencySymbol("USD", "en-US");
    expect(symbol).not.toMatch(/\$/);
    expect(symbol).toMatch(/EGP|E£|ج\.?م/);
  });

  it("formats dates and times, with em-dash fallbacks for empty input", () => {
    const iso = "2026-10-17T14:30:00.000Z";
    expect(formatDate(iso, "en-US")).not.toBe("—");
    expect(formatDateTime(iso, "en-US")).not.toBe("—");
    expect(formatTime(iso, "en-US")).not.toBe("—");
    expect(formatDate(null, "en-US")).toBe("—");
    expect(formatDateTime("", "ar-EG-u-nu-latn")).toBe("—");
    // Unparseable input falls back to the raw string.
    expect(formatDate("not-a-date", "en-US")).toBe("not-a-date");
  });

  it("keeps ar-EG dates in Western digits", () => {
    const formatted = formatDate("2026-10-17T00:00:00.000Z", "ar-EG-u-nu-latn");
    expect(formatted).not.toMatch(/[٠-٩]/);
  });
});
