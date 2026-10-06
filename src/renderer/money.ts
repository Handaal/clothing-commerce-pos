export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      amountMinor / 100,
    );
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
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

/** The currency's symbol (or code) for inline field labels. */
export function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}
