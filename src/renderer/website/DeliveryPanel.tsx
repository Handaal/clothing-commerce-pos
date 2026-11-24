import type {
  StorefrontDeliverySettings,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { describeWebsiteError } from "./errors";
import { PanelHead } from "./PanelHead";

export type DeliveryClient = Pick<
  TenantCommerceClient,
  | "listStorefrontSettings"
  | "listBrands"
  | "getStorefrontDeliverySettings"
  | "updateStorefrontDeliverySettings"
>;

interface ZoneDraft {
  code: string;
  name: string;
  fee: string;
  active: boolean;
}

const toMajor = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, "");
const toMinor = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
};

// Delivery fees (SDK 0.45, parity with Admin Mobile): the fee per delivery area and the free-delivery
// threshold for each website brand. settings.read to view, settings.manage to save.
export function DeliveryPanel({
  client,
  canManage,
}: {
  client: DeliveryClient;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const [brands, setBrands] = useState<{ id: string; name: string }[] | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [settings, list] = await Promise.all([
        client.listStorefrontSettings(),
        client.listBrands({ limit: 100 }),
      ]);
      const names = new Map(list.items.map((b) => [b.id, b.displayName]));
      const rows = settings.items.map((s) => ({
        id: s.brandId,
        name: names.get(s.brandId) ?? s.brandId,
      }));
      setBrands(rows);
      setBrandId((current) => current ?? rows[0]?.id ?? null);
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!brands) return <SkeletonLines lines={4} label={t("website.delivery.loading")} />;
  if (brands.length === 0) return <p className="staff-empty">{t("website.checkout.empty")}</p>;

  return (
    <>
      <p className="notice website-desk-intro">{t("website.delivery.intro")}</p>
      {brands.length > 1 ? (
        <nav className="report-tabs" aria-label={t("website.delivery.brand")}>
          {brands.map((b) => (
            <button
              key={b.id}
              className={`report-tab${b.id === brandId ? " report-tab--active" : ""}`}
              aria-pressed={b.id === brandId}
              onClick={() => setBrandId(b.id)}
            >
              {b.name}
            </button>
          ))}
        </nav>
      ) : null}
      {brandId ? (
        <BrandDelivery key={brandId} client={client} brandId={brandId} canManage={canManage} />
      ) : null}
    </>
  );
}

function BrandDelivery({
  client,
  brandId,
  canManage,
}: {
  client: DeliveryClient;
  brandId: string;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<StorefrontDeliverySettings | null>(null);
  const [threshold, setThreshold] = useState("");
  const [zones, setZones] = useState<ZoneDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await client.getStorefrontDeliverySettings(brandId);
      setSettings(next);
      setThreshold(
        next.freeDeliveryThresholdMinor === null ? "" : toMajor(next.freeDeliveryThresholdMinor),
      );
      setZones(
        next.zones.map((z) => ({
          code: z.code,
          name: z.name,
          fee: toMajor(z.feeMinor),
          active: z.active,
        })),
      );
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, brandId, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  async function save() {
    const thresholdMinor = threshold.trim() === "" ? null : toMinor(threshold);
    if (threshold.trim() !== "" && thresholdMinor === null)
      return setError(t("website.delivery.amountError"));
    const parsed = zones.map((z, i) => ({
      code: z.code.trim().toUpperCase(),
      name: z.name.trim(),
      feeMinor: toMinor(z.fee),
      active: z.active,
      position: i,
    }));
    if (parsed.some((z) => !/^[A-Z0-9][A-Z0-9-]*$/.test(z.code) || !z.name || z.feeMinor === null))
      return setError(t("website.delivery.zoneError"));
    if (new Set(parsed.map((z) => z.code)).size !== parsed.length)
      return setError(t("website.delivery.duplicateError"));
    setError(null);
    setSaving(true);
    try {
      await client.updateStorefrontDeliverySettings({
        brandId,
        freeDeliveryThresholdMinor: thresholdMinor,
        zones: parsed.map((z) => ({ ...z, feeMinor: z.feeMinor! })),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(t("website.delivery.saved"));
      await load();
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  }

  if (!settings)
    return error ? (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    ) : (
      <SkeletonLines lines={3} label={t("website.delivery.loading")} />
    );
  const disabled = !canManage || saving;
  const update = (index: number, patch: Partial<ZoneDraft>) =>
    setZones(zones.map((z, i) => (i === index ? { ...z, ...patch } : z)));

  return (
    <section className="staff-card" data-testid="website-delivery">
      <PanelHead title={t("website.delivery.title")} count={zones.length} />
      {!canManage ? <p className="notice">{t("website.readOnly")}</p> : null}
      <label className="field">
        {t("website.delivery.threshold", { currency: settings.currency })}
        <input
          value={threshold}
          inputMode="decimal"
          disabled={disabled}
          data-testid="website-delivery-threshold"
          onChange={(e) => setThreshold(e.target.value)}
        />
        <small className="muted">{t("website.delivery.thresholdHint")}</small>
      </label>
      {zones.map((zone, index) => (
        <div className="button-row" key={index} data-testid={`website-zone-${index}`}>
          <input
            aria-label={t("website.delivery.code")}
            placeholder="EG-C"
            value={zone.code}
            disabled={disabled}
            data-testid={`website-zone-code-${index}`}
            onChange={(e) => update(index, { code: e.target.value })}
          />
          <input
            aria-label={t("website.delivery.area")}
            placeholder={t("website.delivery.area")}
            value={zone.name}
            disabled={disabled}
            data-testid={`website-zone-name-${index}`}
            onChange={(e) => update(index, { name: e.target.value })}
          />
          <input
            aria-label={t("website.delivery.fee", { currency: settings.currency })}
            placeholder={t("website.delivery.fee", { currency: settings.currency })}
            value={zone.fee}
            inputMode="decimal"
            disabled={disabled}
            data-testid={`website-zone-fee-${index}`}
            onChange={(e) => update(index, { fee: e.target.value })}
          />
          <label>
            <input
              type="checkbox"
              checked={zone.active}
              disabled={disabled}
              data-testid={`website-zone-active-${index}`}
              onChange={(e) => update(index, { active: e.target.checked })}
            />{" "}
            {t("website.delivery.active")}
          </label>
          <button
            type="button"
            className="link link--danger"
            disabled={disabled}
            onClick={() => setZones(zones.filter((_, i) => i !== index))}
          >
            {t("website.siteText.remove")}
          </button>
        </div>
      ))}
      {error ? (
        <span className="website-field-error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="website-savebar">
        <button
          type="button"
          className="button button--quiet"
          disabled={disabled || zones.length >= 60}
          data-testid="website-zone-add"
          onClick={() => setZones([...zones, { code: "", name: "", fee: "", active: true }])}
        >
          {t("website.delivery.addArea")}
        </button>
        <button
          type="button"
          className="button button--complete"
          disabled={disabled}
          data-testid="website-delivery-save"
          onClick={() => void save()}
        >
          {saving ? t("website.saving") : t("website.saveChanges")}
        </button>
      </div>
    </section>
  );
}
