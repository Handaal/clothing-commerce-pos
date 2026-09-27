import type { PosContextResponse } from "@shifted/clothing-commerce-sdk";

import type { PosRegister } from "./context";

/**
 * Server-owned business identity carried by the enriched `GET /pos/context` (SDK 0.14.0). This is
 * configuration rendered at receipt time, not an immutable historical snapshot of the sale.
 */
export type BusinessIdentity = PosContextResponse["business"]["tenant"];

/** Per-register branch identity carried by the enriched `GET /pos/context`. */
export type BranchIdentity = PosRegister["branch"];

/**
 * The flattened, presentation-ready receipt identity. Optional server fields are normalized to
 * `null`/empty arrays so the fixed-layout receipt can render each block only when present. This is a
 * fixed layout — not a template engine — so composition happens here, not in the view.
 */
export interface ReceiptIdentity {
  readonly businessName: string;
  readonly legalName: string | null;
  readonly taxIdentifier: string | null;
  readonly branchName: string;
  readonly branchAddressLines: readonly string[];
  readonly branchContactLines: readonly string[];
  readonly receiptFooter: string | null;
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function composeAddressLines(branch: BranchIdentity): readonly string[] {
  const lines: string[] = [];
  const push = (value: string | null) => {
    const normalized = clean(value);
    if (normalized) lines.push(normalized);
  };
  push(branch.addressLine1);
  push(branch.addressLine2);
  // City / region / postal code collapse onto a single locality line, skipping any absent part.
  const locality = [clean(branch.city), clean(branch.region), clean(branch.postalCode)]
    .filter((part): part is string => part !== null)
    .join(", ");
  if (locality) lines.push(locality);
  push(branch.countryCode);
  return lines;
}

function composeContactLines(branch: BranchIdentity): readonly string[] {
  const lines: string[] = [];
  const phone = clean(branch.contactPhone);
  const email = clean(branch.contactEmail);
  if (phone) lines.push(phone);
  if (email) lines.push(email);
  return lines;
}

/**
 * Maps the server-owned business + branch context identity onto the presentation shape. The register's
 * `branch` block is the canonical per-register identity; the top-level `business.tenant` is the
 * tenant-wide identity. Monetary sale facts are never sourced from here.
 */
export function receiptIdentity(
  business: BusinessIdentity,
  branch: BranchIdentity,
): ReceiptIdentity {
  return {
    businessName: business.displayName,
    legalName: clean(business.legalName),
    taxIdentifier: clean(business.taxIdentifier),
    branchName: branch.displayName,
    branchAddressLines: composeAddressLines(branch),
    branchContactLines: composeContactLines(branch),
    receiptFooter: clean(branch.receiptFooter),
  };
}
