import { useCallback, useEffect, useState } from "react";

import type {
  PromotionChannelPoliciesResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { useI18n } from "../shell/i18n";

interface Draft {
  usageLimit: string;
  offlineEnabled: boolean;
  quota: string;
  requiresApproval: boolean;
  perRedemption: string;
  perGrant: string;
}

const EMPTY: Draft = {
  usageLimit: "",
  offlineEnabled: false,
  quota: "",
  requiresApproval: false,
  perRedemption: "",
  perGrant: "",
};

/**
 * ADR-042 §5 / D-7: the voucher's POS limit (independent of the website) and its offline terms. Offline
 * use is only offered to tills when the usage limit, the per-till quota and BOTH owner discount caps are
 * set; until then the server grants nothing (fail closed).
 */
export function VoucherChannelPanel({
  client,
  promotionId,
  currency,
}: {
  client: TenantCommerceClient;
  promotionId: string;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const [policies, setPolicies] = useState<PromotionChannelPoliciesResponse | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = useCallback((response: PromotionChannelPoliciesResponse) => {
    setPolicies(response);
    const pos = response.policies.find((policy) => policy.channel === "pos");
    setDraft(
      pos
        ? {
            usageLimit: pos.usageLimit === null ? "" : String(pos.usageLimit),
            offlineEnabled: pos.offlineEnabled,
            quota: pos.offlineQuotaPerGrant === null ? "" : String(pos.offlineQuotaPerGrant),
            requiresApproval: pos.requiresAdminCredentials,
            perRedemption:
              pos.maxDiscountPerRedemptionMinor === null
                ? ""
                : minorToMajorInput(pos.maxDiscountPerRedemptionMinor),
            perGrant:
              pos.maxDiscountPerGrantMinor === null
                ? ""
                : minorToMajorInput(pos.maxDiscountPerGrantMinor),
          }
        : EMPTY,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void client
      .getPromotionChannelPolicies(promotionId)
      .then((response) => {
        if (!cancelled) apply(response);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage({ tone: "error", text: classifyCommerceError(error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [apply, client, promotionId]);

  const pos = policies?.policies.find((policy) => policy.channel === "pos") ?? null;
  const missingCaps =
    draft.offlineEnabled && (draft.perRedemption.trim() === "" || draft.perGrant.trim() === "");

  async function save() {
    const whole = (value: string) => (value.trim() === "" ? null : Number(value));
    const money = (value: string) => (value.trim() === "" ? null : parseMajorToMinor(value));
    const usageLimit = whole(draft.usageLimit);
    const quota = whole(draft.quota);
    const perRedemption = money(draft.perRedemption);
    const perGrant = money(draft.perGrant);
    if (
      (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0)) ||
      (quota !== null && (!Number.isInteger(quota) || quota <= 0)) ||
      (draft.perRedemption.trim() !== "" && !perRedemption) ||
      (draft.perGrant.trim() !== "" && !perGrant)
    ) {
      setMessage({ tone: "error", text: t("voucherChannel.invalid") });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      apply(
        await client.upsertPromotionChannelPolicy({
          idempotencyKey: crypto.randomUUID(),
          promotionId,
          channel: "pos",
          usageLimit,
          offlineEnabled: draft.offlineEnabled,
          offlineQuotaPerGrant: quota,
          requiresAdminCredentials: draft.requiresApproval,
          maxDiscountPerRedemptionMinor: perRedemption,
          maxDiscountPerGrantMinor: perGrant,
        }),
      );
      setMessage({ tone: "ok", text: t("voucherChannel.saved") });
    } catch (error) {
      setMessage({ tone: "error", text: classifyCommerceError(error).message });
    } finally {
      setBusy(false);
    }
  }

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <section className="voucher-channel" data-testid="voucher-channel-panel">
      <h3>{t("voucherChannel.title")}</h3>
      {pos ? (
        <p className="muted">
          {t("voucherChannel.usage", { redeemed: pos.redeemedCount, reserved: pos.reservedCount })}
        </p>
      ) : null}
      <label className="field">
        {t("voucherChannel.usageLimit")}
        <input
          inputMode="numeric"
          value={draft.usageLimit}
          placeholder={t("settings.noLimit")}
          onChange={(event) => update({ usageLimit: event.target.value })}
        />
      </label>
      <label className="field settings-check">
        <input
          type="checkbox"
          checked={draft.offlineEnabled}
          onChange={(event) => update({ offlineEnabled: event.target.checked })}
        />
        {t("voucherChannel.offlineEnabled")}
      </label>
      {draft.offlineEnabled ? (
        <>
          <label className="field">
            {t("voucherChannel.quota")}
            <input
              inputMode="numeric"
              value={draft.quota}
              onChange={(event) => update({ quota: event.target.value })}
            />
          </label>
          <label className="field">
            {t("voucherChannel.perRedemption", { example: formatMoney(1000, currency, locale) })}
            <input
              inputMode="decimal"
              value={draft.perRedemption}
              data-testid="voucher-cap-per-redemption"
              onChange={(event) => update({ perRedemption: event.target.value })}
            />
          </label>
          <label className="field">
            {t("voucherChannel.perGrant")}
            <input
              inputMode="decimal"
              value={draft.perGrant}
              data-testid="voucher-cap-per-grant"
              onChange={(event) => update({ perGrant: event.target.value })}
            />
          </label>
          <label className="field settings-check">
            <input
              type="checkbox"
              checked={draft.requiresApproval}
              onChange={(event) => update({ requiresApproval: event.target.checked })}
            />
            {t("voucherChannel.requiresApproval")}
          </label>
          {missingCaps ? (
            <p className="notice" role="status" data-testid="voucher-caps-missing">
              {t("voucherChannel.capsMissing")}
            </p>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p
          className={`notice ${message.tone === "ok" ? "notice--success" : "notice--error"}`}
          role="status"
        >
          {message.text}
        </p>
      ) : null}
      <button className="button" disabled={busy} onClick={() => void save()}>
        {t("voucherChannel.save")}
      </button>
    </section>
  );
}
