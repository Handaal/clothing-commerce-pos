// The business operates exclusively in Egyptian pounds. Dev fixtures and some backend records still
// echo other currency codes (notably "USD"), but the POS must never surface a "$"/"USD" mark to staff
// or on receipts. This module is the single place amounts are rendered, so coercing the display
// currency here guarantees every amount shows as EGP everywhere. The `currency` argument is kept for
// call-site compatibility (and future multi-currency work) but is intentionally ignored today.
export const BUSINESS_CURRENCY = "EGP";

export function formatMoney(amountMinor: number, _currency?: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: BUSINESS_CURRENCY }).format(
      amountMinor / 100,
    );
  } catch {
    return `${BUSINESS_CURRENCY} ${(amountMinor / 100).toFixed(2)}`;
  }
}

// The storefront/POS treat prices as two-decimal currencies (minor = major × 100), matching
// `formatMoney`. Cashiers enter the natural major amount (e.g. "60" or "60.50"); these helpers
// convert between what the cashier types and the integer minor units the API requires.

/** Parse a cashier-entered major-unit amount into whole minor units. Returns null when invalid. */
export function parseMajorToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const minor = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

/** Render minor units as a plain major-unit string (no currency symbol) for input defaults. */
export function minorToMajorInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/** The currency's symbol (or code) for inline field labels — always EGP (see `formatMoney`). */
export function currencySymbol(_currency?: string, locale?: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: BUSINESS_CURRENCY,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? BUSINESS_CURRENCY;
  } catch {
    return BUSINESS_CURRENCY;
  }
}
