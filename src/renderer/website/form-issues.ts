import type { FormIssue } from "@shifted/clothing-commerce-sdk";

// The form RULES live in the SDK (`validatePromotionForm`, `validateSaleForm`, `validateContentForm`,
// shared with Admin Mobile). The SDK returns language-neutral issue codes; this file turns them into the
// POS's i18n keys (`website.err.*`, English + Arabic in strings.ts).

export interface FieldError {
  key: string;
  vars?: Record<string, string | number>;
}

export type WebsiteForm = "promotion" | "sale" | "content";

const REQUIRED: Record<WebsiteForm, Record<string, string>> = {
  promotion: {
    name: "website.err.promoName",
    benefitValue: "website.err.fixedRequired",
    targets: "website.err.promoTargets",
    initialCode: "website.err.codeRequired",
  },
  sale: {
    name: "website.err.saleName",
    value: "website.err.amountRequired",
    collectionId: "website.err.saleCollection",
    productIds: "website.err.saleProducts",
  },
  content: {},
};

export function issueToFieldError(form: WebsiteForm, field: string, issue: FormIssue): FieldError {
  const max = issue.max !== undefined ? { max: issue.max } : undefined;
  switch (issue.code) {
    case "required":
      return { key: REQUIRED[form][field] ?? "website.err.generic" };
    case "too_long":
      return { key: "website.err.tooLong", vars: max };
    case "too_many":
      return {
        key:
          field === "featuredProductIds"
            ? "website.err.tooManyProducts"
            : "website.err.tooManyCollections",
        vars: max,
      };
    case "percent_range":
      return { key: "website.err.percent" };
    case "amount_format":
    case "amount_too_large":
      return { key: "website.err.amount" };
    case "amount_positive":
      return { key: "website.err.amountPositive" };
    case "amount_non_negative":
      return { key: "website.err.amountNonNegative" };
    case "whole_number":
      return { key: "website.err.wholeNumber" };
    case "positive":
      return { key: "website.err.positive" };
    case "quantity_range":
      return { key: "website.err.quantity" };
    case "currency_format":
      return { key: "website.err.currency" };
    case "code_format":
      return { key: "website.err.codeFormat" };
    case "date_invalid":
      return { key: "website.err.date" };
    case "end_before_start":
      return {
        key: form === "promotion" ? "website.err.promoEndAfterStart" : "website.err.endAfterStart",
      };
    case "unsafe_link":
      return { key: "website.err.ctaHref" };
    case "link_required":
      return { key: "website.err.ctaHrefMissing" };
  }
}

export function toFieldErrors<T>(
  form: WebsiteForm,
  issues: Partial<Record<keyof T, FormIssue>>,
): Partial<Record<keyof T, FieldError>> {
  const errors: Partial<Record<keyof T, FieldError>> = {};
  for (const [field, issue] of Object.entries(issues) as [keyof T, FormIssue | undefined][]) {
    if (issue) errors[field] = issueToFieldError(form, String(field), issue);
  }
  return errors;
}

/** Map a parser result (number | issue | null) to number | FieldError | null for one field. */
export function mapParsed<T>(
  form: WebsiteForm,
  field: string,
  value: T | FormIssue,
): T | FieldError {
  return typeof value === "object" && value !== null && "code" in value
    ? issueToFieldError(form, field, value as FormIssue)
    : (value as T);
}
