import {
  emptySaleForm as emptySdkSaleForm,
  parseMoneyInput,
  parsePercentInput,
  saleToForm as sdkSaleToForm,
  validateSaleForm as validateSaleIssues,
  type Sale,
  type SaleFormState,
  type SaleLiveState,
} from "@shifted/clothing-commerce-sdk";

import { BUSINESS_CURRENCY } from "../money";
import { mapParsed, toFieldErrors, type FieldError } from "./form-issues";

// Item-sale editor. A sale lowers the ONLINE selling price of every product, one collection, or the
// chosen products. Rules, request builders, the price preview and the live state are the SDK's shared
// management form rules (also used by Admin Mobile); this module adds POS wording and `datetime-local`
// date inputs. The API re-validates and owns every rule.

export {
  buildCreateSaleRequest,
  buildUpdateSaleRequest,
  formatPercentBasisPoints,
  previewSalePrice,
  saleLiveState,
  type SaleFormState,
  type SaleLiveState,
} from "@shifted/clothing-commerce-sdk";

export type SaleFormErrors = Partial<Record<keyof SaleFormState, FieldError>>;

export const emptySaleForm = (): SaleFormState => emptySdkSaleForm(BUSINESS_CURRENCY);

/** Percentage "12.5" → basis points (1250), or an error key. */
export function parsePercent(value: string): number | FieldError {
  return mapParsed("sale", "value", parsePercentInput(value));
}

/** Major-unit amount "100.50" → minor units (> 0), or an error key (blank is "required"). */
export function parseAmountOff(value: string): number | FieldError {
  const parsed = parseMoneyInput(value, false);
  return parsed === null
    ? { key: "website.err.amountRequired" }
    : mapParsed("sale", "value", parsed);
}

/** ISO instant → `datetime-local` value in the device's local time zone ("" for null/invalid). */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function validateSaleForm(state: SaleFormState): SaleFormErrors {
  return toFieldErrors<SaleFormState>("sale", validateSaleIssues(state));
}

export function saleToForm(sale: Sale): SaleFormState {
  return sdkSaleToForm(sale, { toDateInput: isoToLocalInput, currency: BUSINESS_CURRENCY });
}

export function saleStateTone(state: SaleLiveState): "good" | "warn" | "" {
  return state === "live" ? "good" : state === "scheduled" ? "warn" : "";
}
