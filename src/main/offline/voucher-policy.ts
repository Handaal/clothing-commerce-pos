import { createHash } from "node:crypto";

/**
 * ADR-042 §13.6 — cached policy of an EXISTING voucher for emergency offline redemption.
 *
 * Not a reservation and not a per-till quota: `observedRemaining` is the SHARED remaining usage the server saw
 * when the lease was fetched, and the Website keeps consuming the same limit while this till is offline. The
 * till only enforces a best-effort local ceiling (its own uses since the fetch must stay below that number);
 * the server decides at sync against live shared usage and records a conflict when it disagrees, leaving the
 * completed sale exactly as the cashier recorded it.
 */
export interface VoucherPolicyPayload {
  readonly policyIssuanceId: string;
  readonly promotionId: string;
  readonly codeId: string;
  readonly codeFingerprint: string;
  readonly channelPolicyVersion: number;
  readonly policyDigest: string;
  readonly calculationVersion: "ov1";
  readonly observedRemaining: number | null;
  readonly maxDiscountPerRedemptionMinor: number | null;
  readonly requiresAdminCredentials: false;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly terms: Record<string, unknown>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sha256hex(`${tenantId}:${NORMALIZED_CODE}`) — identical to the server's issuance fingerprint. */
export function voucherCodeFingerprint(tenantId: string, code: string): string {
  return createHash("sha256")
    .update(`${tenantId}:${code.trim().toUpperCase()}`, "utf8")
    .digest("hex");
}

/** The columns an installed policy row is checked against at every use (fixed order). */
export interface VoucherPolicyIntegrityFields {
  readonly policy_issuance_id: string;
  readonly promotion_id: string;
  readonly code_id: string;
  readonly code_fingerprint: string;
  readonly channel_policy_version: number;
  readonly policy_digest: string;
  readonly calculation_version: string;
  readonly observed_remaining: number | null;
  readonly max_discount_per_redemption_minor: number | null;
  readonly requires_admin_credentials: number;
  readonly fetched_at: string;
  readonly expires_at: string;
  readonly terms_json: string;
}

/**
 * Where an installed row belongs: this till's snapshot + lease (grant), which the server bound to this tenant
 * and device. A row copied from another snapshot, lease, till or business no longer matches its hash and is
 * refused before selling (fail closed). A fully compromised till can recompute the hash; the server's
 * issuance/digest check at sync (VX_SNAPSHOT_INVALID) remains the authority.
 */
export interface VoucherPolicyBinding {
  readonly snapshotId: string;
  readonly grantId: string;
}

export function voucherPolicyIntegrity(
  row: VoucherPolicyIntegrityFields,
  binding: VoucherPolicyBinding,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "ovp2",
        binding.snapshotId,
        binding.grantId,
        row.policy_issuance_id,
        row.promotion_id,
        row.code_id,
        row.code_fingerprint,
        Number(row.channel_policy_version),
        row.policy_digest,
        row.calculation_version,
        row.observed_remaining === null ? null : Number(row.observed_remaining),
        row.max_discount_per_redemption_minor === null
          ? null
          : Number(row.max_discount_per_redemption_minor),
        Number(row.requires_admin_credentials),
        row.fetched_at,
        row.expires_at,
        row.terms_json,
      ]),
      "utf8",
    )
    .digest("hex");
}

const positiveOrNull = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) > 0);

/**
 * Structural check of one delivered policy. Anything malformed — or credential-gated — is NOT installed, so
 * that voucher simply stays online-only (fail closed per voucher, never for the whole lease).
 */
export function isUsableVoucherPolicy(value: unknown): value is VoucherPolicyPayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const terms = p.terms as Record<string, unknown> | undefined;
  return (
    typeof p.policyIssuanceId === "string" &&
    UUID.test(p.policyIssuanceId) &&
    typeof p.promotionId === "string" &&
    UUID.test(p.promotionId) &&
    typeof p.codeId === "string" &&
    UUID.test(p.codeId) &&
    typeof p.codeFingerprint === "string" &&
    HEX64.test(p.codeFingerprint) &&
    Number.isSafeInteger(p.channelPolicyVersion) &&
    (p.channelPolicyVersion as number) > 0 &&
    typeof p.policyDigest === "string" &&
    HEX64.test(p.policyDigest) &&
    p.calculationVersion === "ov1" &&
    positiveOrNull(p.observedRemaining) &&
    positiveOrNull(p.maxDiscountPerRedemptionMinor) &&
    p.requiresAdminCredentials === false &&
    typeof p.fetchedAt === "string" &&
    !Number.isNaN(Date.parse(p.fetchedAt)) &&
    typeof p.expiresAt === "string" &&
    !Number.isNaN(Date.parse(p.expiresAt)) &&
    Date.parse(p.expiresAt) > Date.parse(p.fetchedAt) &&
    typeof terms === "object" &&
    terms !== null &&
    (terms.benefitType === "percentage" || terms.benefitType === "fixed_amount") &&
    (terms.targetType === "order" || terms.targetType === "variant_scope") &&
    Array.isArray(terms.targetProductIds) &&
    Array.isArray(terms.targetVariantIds)
  );
}
