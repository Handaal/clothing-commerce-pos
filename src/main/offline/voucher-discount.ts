/**
 * ADR-042 §5 offline voucher discount, calculation version 'ov1'. It mirrors the server's
 * promotions_private.offline_voucher_discount (and the canonical evaluator for percentage and fixed-amount
 * vouchers) exactly, so a till discount the server recomputes differently becomes a VX_DISCOUNT_MISMATCH
 * exception instead of a silent price change.
 */
export interface OfflineVoucherTerms {
  readonly benefitType: "percentage" | "fixed_amount";
  readonly benefitPercentBp: number | null;
  readonly benefitAmountMinor: number | null;
  readonly targetType: "order" | "variant_scope";
  readonly minSubtotalMinor: number | null;
  readonly maxDiscountMinor: number | null;
  readonly targetProductIds: ReadonlyArray<string>;
  readonly targetVariantIds: ReadonlyArray<string>;
}

export interface VoucherLine {
  readonly variantId: string;
  readonly productId: string;
  readonly lineTotalMinor: number;
}

export function offlineVoucherDiscount(
  terms: OfflineVoucherTerms,
  lines: ReadonlyArray<VoucherLine>,
): number {
  let gross = 0;
  let basis = 0;
  for (const line of lines) {
    gross += line.lineTotalMinor;
    if (
      terms.targetType === "order" ||
      terms.targetVariantIds.includes(line.variantId) ||
      terms.targetProductIds.includes(line.productId)
    ) {
      basis += line.lineTotalMinor;
    }
  }
  if (terms.minSubtotalMinor !== null && gross < terms.minSubtotalMinor) return 0;
  if (basis <= 0) return 0;
  let discount: number;
  if (terms.benefitType === "percentage") {
    // floor(basis * bp / 10000) with integer arithmetic (BigInt keeps it exact for any safe basis).
    discount = Number((BigInt(basis) * BigInt(terms.benefitPercentBp ?? 0)) / 10000n);
  } else if (terms.benefitType === "fixed_amount") {
    discount = Math.min(terms.benefitAmountMinor ?? 0, basis);
  } else {
    return 0;
  }
  if (terms.maxDiscountMinor !== null) discount = Math.min(discount, terms.maxDiscountMinor);
  return Math.max(0, Math.min(discount, gross, basis));
}
