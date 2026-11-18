import {
  emptyPromotionForm as emptySdkPromotionForm,
  normalizePromotionCode as normalizeSdkCode,
  parseMoneyInput,
  parsePositiveIntegerInput,
  promotionCodeLimit,
  promotionToForm as sdkPromotionToForm,
  validatePromotionForm as validatePromotionIssues,
  type PromotionDetail,
  type PromotionFormState,
  type PromotionLimitKind,
  type PromotionTargetChoice,
  type PromotionTargetInput,
  type ValidatePromotionOptions,
} from "@shifted/clothing-commerce-sdk";

import { BUSINESS_CURRENCY } from "../money";
import { mapParsed, toFieldErrors, type FieldError } from "./form-issues";
import { isoToLocalInput } from "./sale-form";

// Promotion editor. The rules and request builders are the SDK's shared management form rules (also
// used by Admin Mobile); every setting is editable at any time, including after redemption (owner
// decision 2026-11-18). This module adds POS wording and `datetime-local` date inputs.

export {
  buildCreatePromotionRequest,
  buildUpdatePromotionRequest,
  promotionEffectiveState,
  promotionInitialCode,
  promotionTargetLabel,
  type PromotionChannelChoice,
  type PromotionEffectiveState,
  type PromotionFormState,
  type PromotionLimitKind,
  type PromotionTargetChoice,
} from "@shifted/clothing-commerce-sdk";
export type PromotionTarget = PromotionTargetInput;

export type PromotionFormErrors = Partial<Record<keyof PromotionFormState, FieldError>>;

export const emptyPromotionForm = (): PromotionFormState =>
  emptySdkPromotionForm(BUSINESS_CURRENCY);

export function parsePositiveInteger(value: string): number | FieldError | null {
  return mapParsed("promotion", "globalLimit", parsePositiveIntegerInput(value));
}

export function parsePromotionMoney(value: string, allowZero: boolean): number | FieldError | null {
  return mapParsed("promotion", "minimumSubtotal", parseMoneyInput(value, allowZero));
}

export function codeLimit(
  kind: PromotionLimitKind,
  customLimit: string,
): number | FieldError | null {
  return mapParsed("promotion", "codeCustomLimit", promotionCodeLimit(kind, customLimit));
}

export function normalizePromotionCode(value: string): string | FieldError {
  return mapParsed("promotion", "initialCode", normalizeSdkCode(value));
}

export function validatePromotionForm(
  state: PromotionFormState,
  mode: "create" | "edit",
  options?: ValidatePromotionOptions,
): PromotionFormErrors {
  return toFieldErrors<PromotionFormState>(
    "promotion",
    validatePromotionIssues(state, mode, options),
  );
}

export function promotionToForm(detail: PromotionDetail): PromotionFormState {
  return sdkPromotionToForm(detail, { toDateInput: isoToLocalInput, currency: BUSINESS_CURRENCY });
}

export function targetKey(choice: PromotionTargetChoice | PromotionTargetInput): string {
  const target = "target" in choice ? choice.target : choice;
  return target.productId ? `p:${target.productId}` : `v:${target.variantId ?? ""}`;
}
