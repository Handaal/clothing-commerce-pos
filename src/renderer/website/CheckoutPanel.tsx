import type {
  Brand,
  InventoryLocation,
  StorefrontSettings,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BUSINESS_CURRENCY } from "../money";
import { ReturnsTab } from "../settings/SettingsDesk";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";
import { MAX_PAGES } from "./access";
import { describeWebsiteError } from "./errors";

export type CheckoutClient = Pick<
  TenantCommerceClient,
  | "listStorefrontSettings"
  | "upsertStorefrontSettings"
  | "listBrands"
  | "listInventoryLocations"
  | "getReturnSettings"
  | "updateReturnSettings"
>;

async function collect<T>(
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < MAX_PAGES; index++) {
    const response = await page(cursor);
    items.push(...response.items);
    if (!response.pageInfo.hasMore || response.pageInfo.nextCursor === null) return items;
    cursor = response.pageInfo.nextCursor;
  }
  throw new Error("The list is larger than this screen can load.");
}

interface Draft {
  brandId: string;
  inventoryLocationId: string;
  codEnabled: boolean;
  isNew: boolean;
}

// Website checkout per brand (fulfillment stock location + cash on delivery; the currency is locked to
// the single operating currency) plus the returns policy that also governs website orders. Mirrors Admin
// Mobile's Settings → Commerce. Reading needs settings.read; saving needs settings.manage — the API
// enforces both. The returns editor is the POS's existing Settings → Returns form, reused as-is.
export function CheckoutPanel({
  client,
  canManage,
}: {
  client: CheckoutClient;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [storefronts, setStorefronts] = useState<StorefrontSettings[] | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, brandList, locationList] = await Promise.all([
        client.listStorefrontSettings(),
        collect((cursor) => client.listBrands({ limit: 100, ...(cursor ? { cursor } : {}) })),
        collect((cursor) =>
          client.listInventoryLocations({ limit: 100, ...(cursor ? { cursor } : {}) }),
        ),
      ]);
      setStorefronts(list.items);
      setBrands(brandList);
      setLocations(locationList);
    } catch (err) {
      setError(describeWebsiteError(err, t));
    } finally {
      setLoading(false);
    }
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.displayName])), [brands]);
  const locationName = useMemo(
    () => new Map(locations.map((l) => [l.id, l.displayName])),
    [locations],
  );
  const unconfigured = brands.filter(
    (brand) => brand.status === "active" && !storefronts?.some((item) => item.brandId === brand.id),
  );

  const save = async () => {
    if (!draft || !draft.brandId || !draft.inventoryLocationId) {
      toast.error(t("website.checkout.err.required"));
      return;
    }
    setSaving(true);
    try {
      const saved = await client.upsertStorefrontSettings({
        brandId: draft.brandId,
        inventoryLocationId: draft.inventoryLocationId,
        currency: BUSINESS_CURRENCY,
        codEnabled: draft.codEnabled,
        idempotencyKey: crypto.randomUUID(),
      });
      setStorefronts((current) => {
        const list = current ?? [];
        return list.some((item) => item.brandId === saved.brandId)
          ? list.map((item) => (item.brandId === saved.brandId ? saved : item))
          : [...list, saved];
      });
      toast.success(
        t("website.checkout.saved", { brand: brandName.get(saved.brandId) ?? saved.brandId }),
      );
      setDraft(null);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.checkout.title")}</h2>
          {canManage && unconfigured.length > 0 ? (
            <button
              className="button"
              data-testid="website-checkout-add"
              onClick={() =>
                setDraft({
                  brandId: unconfigured[0].id,
                  inventoryLocationId: "",
                  codEnabled: true,
                  isNew: true,
                })
              }
            >
              {t("website.checkout.add")}
            </button>
          ) : null}
        </div>
        <p className="muted website-card-intro">{t("website.checkout.intro")}</p>
        {!canManage ? (
          <p className="notice website-card-intro" role="status">
            {t("website.readOnly")}
          </p>
        ) : null}
        {loading ? <SkeletonLines lines={3} label={t("website.checkout.loading")} /> : null}
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button className="button button--quiet" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : null}
        {!loading && !error && storefronts?.length === 0 ? (
          <p className="staff-empty">{t("website.checkout.empty")}</p>
        ) : null}
        {!loading && !error && storefronts && storefronts.length > 0 ? (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("website.checkout.brand")}</th>
                  <th>{t("website.checkout.location")}</th>
                  <th>{t("website.checkout.currency")}</th>
                  <th>{t("website.checkout.cod")}</th>
                  {canManage ? <th className="end">{t("website.actions")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {storefronts.map((item) => (
                  <tr key={item.brandId} data-testid={`website-checkout-${item.brandId}`}>
                    <td>{brandName.get(item.brandId) ?? item.brandId}</td>
                    <td>
                      {locationName.get(item.inventoryLocationId) ?? item.inventoryLocationId}
                    </td>
                    <td>{item.currency}</td>
                    <td>
                      <span className={`pill${item.codEnabled ? " pill--good" : ""}`}>
                        {item.codEnabled ? t("website.enabled") : t("website.disabled")}
                      </span>
                    </td>
                    {canManage ? (
                      <td className="end website-row-actions">
                        <button
                          className="link"
                          onClick={() =>
                            setDraft({
                              brandId: item.brandId,
                              inventoryLocationId: item.inventoryLocationId,
                              codEnabled: item.codEnabled,
                              isNew: false,
                            })
                          }
                        >
                          {t("website.edit")}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <ReturnsTab client={client} currency={BUSINESS_CURRENCY} readOnly={!canManage} />

      {draft ? (
        <CheckoutEditor
          draft={draft}
          brands={draft.isNew ? unconfigured : brands.filter((b) => b.id === draft.brandId)}
          locations={locations.filter(
            (l) => l.status === "active" || l.id === draft.inventoryLocationId,
          )}
          saving={saving}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void save()}
        />
      ) : null}
    </>
  );
}

function CheckoutEditor({
  draft,
  brands,
  locations,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  brands: readonly Brand[];
  locations: readonly InventoryLocation[];
  saving: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const ref = useModalA11y<HTMLDivElement>(onCancel);
  return (
    <div className="staff-modal__scrim" role="presentation" onClick={saving ? undefined : onCancel}>
      <div
        className="staff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="website-checkout-title"
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="website-checkout-title">
          {draft.isNew ? t("website.checkout.add") : t("website.checkout.editTitle")}
        </h3>
        <div className="staff-modal__body">
          <label className="field">
            {t("website.checkout.brand")}
            <Select<string>
              ariaLabel={t("website.checkout.brand")}
              value={draft.brandId}
              disabled={saving || !draft.isNew}
              onChange={(brandId) => onChange({ ...draft, brandId })}
              options={brands.map((brand) => ({ value: brand.id, label: brand.displayName }))}
            />
          </label>
          <label className="field">
            {t("website.checkout.location")}
            <Select<string>
              ariaLabel={t("website.checkout.location")}
              value={draft.inventoryLocationId}
              disabled={saving}
              onChange={(inventoryLocationId) => onChange({ ...draft, inventoryLocationId })}
              options={[
                { value: "", label: t("website.checkout.chooseLocation"), disabled: true },
                ...locations.map((location) => ({
                  value: location.id,
                  label: location.displayName,
                })),
              ]}
            />
          </label>
          <p className="muted">
            {t("website.checkout.currency")}: <strong>{BUSINESS_CURRENCY}</strong> ·{" "}
            {t("website.checkout.currencyLocked")}
          </p>
          <label className="field settings-check">
            <input
              type="checkbox"
              checked={draft.codEnabled}
              disabled={saving}
              data-testid="website-checkout-cod"
              onChange={(event) => onChange({ ...draft, codEnabled: event.target.checked })}
            />
            {t("website.checkout.codLong")}
          </label>
        </div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button
            className="button button--complete"
            disabled={saving || !draft.brandId || !draft.inventoryLocationId}
            data-testid="website-checkout-save"
            onClick={onSave}
          >
            {saving ? t("website.saving") : t("website.saveChanges")}
          </button>
        </div>
      </div>
    </div>
  );
}
