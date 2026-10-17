// Locale-aware date/time formatting for the renderer. Every desk pulls `locale` from `useI18n()`
// and passes it here, so dates and times follow the app's selected language (Arabic = `ar-EG`,
// which renders Western digits) instead of the host machine's OS locale.
//
// All helpers accept either an ISO string or a Date. Unparseable input falls back to the raw
// string (or an em dash when empty), matching the prior per-desk behaviour.

const EMPTY = "—";

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Medium date + short time, e.g. "17 Oct 2026, 2:30 PM". Used for timestamps in tables/detail. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale: string,
): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** Medium date only, e.g. "17 Oct 2026". */
export function formatDate(
  value: string | number | Date | null | undefined,
  locale: string,
): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(locale, { dateStyle: "medium" });
}

/** Two-digit hour:minute, e.g. "02:30 PM". Used for attendance clock timestamps. */
export function formatTime(
  value: string | number | Date | null | undefined,
  locale: string,
): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
