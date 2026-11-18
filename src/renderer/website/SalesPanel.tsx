import type {
  CollectionListResponse,
  Sale,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";
import { loadAllProducts, type ProductItem } from "./access";
import { ConfirmDialog } from "./ConfirmDialog";
import type { FieldError } from "./content-form";
import { describeWebsiteError } from "./errors";
import { ItemPicker } from "./ItemPicker";
import {
  buildCreateSaleRequest,
  buildUpdateSaleRequest,
  emptySaleForm,
  formatPercentBasisPoints,
  previewSalePrice,
  saleLiveState,
  saleStateTone,
  saleToForm,
  validateSaleForm,
  type SaleFormErrors,
  type SaleFormState,
} from "./sale-form";

export type SalesClient = Pick<
  TenantCommerceClient,
  | "listSales"
  | "createSale"
  | "updateSale"
  | "setSaleStatus"
  | "deleteSale"
  | "listCollections"
  | "listProducts"
>;

type CollectionItem = CollectionListResponse["collections"][number];

/** Sample list price for the shopper-price preview (matches Admin Mobile). */
const PREVIEW_PRICE_MINOR = 69_000;

// Item sales: online price reductions on all items, one collection, or chosen products. Listing needs
// promotions.read; creating, editing, pausing and deleting need promotions.manage (the API enforces both).
export function SalesPanel({ client, canManage }: { client: SalesClient; canManage: boolean }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ sale: Sale | null } | null>(null);
  const [deleting, setDeleting] = useState<Sale | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, collectionList] = await Promise.all([
        client.listSales(),
        client.listCollections().catch(() => ({ collections: [] as CollectionItem[] })),
      ]);
      setSales(list.items);
      setCollections(collectionList.collections);
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

  const collectionName = useMemo(
    () => new Map(collections.map((item) => [item.id, item.name])),
    [collections],
  );

  const benefitLabel = (sale: Sale) =>
    sale.benefitType === "percentage"
      ? t("website.sales.percentOff", {
          percent: formatPercentBasisPoints(sale.benefitPercentBp ?? 0),
        })
      : t("website.sales.amountOff", {
          amount: formatMoney(sale.benefitAmountMinor ?? 0, sale.benefitCurrency ?? "", locale),
        });
  const scopeLabel = (sale: Sale) =>
    sale.scope === "all"
      ? t("website.sales.scopeAllShort")
      : sale.scope === "collection"
        ? t("website.sales.scopeCollectionShort", {
            name:
              (sale.collectionId && collectionName.get(sale.collectionId)) ||
              t("website.sales.aCollection"),
          })
        : t("website.sales.scopeProductsShort", { count: sale.productIds.length });
  const windowLabel = (sale: Sale) => {
    if (!sale.startsAt && !sale.endsAt) return t("website.sales.noSchedule");
    const from = sale.startsAt ? formatDateTime(sale.startsAt, locale) : t("website.sales.now");
    const to = sale.endsAt ? formatDateTime(sale.endsAt, locale) : t("website.sales.noEnd");
    return `${from} → ${to}`;
  };

  const toggleStatus = async (sale: Sale) => {
    setBusyId(sale.id);
    try {
      const next = await client.setSaleStatus({
        saleId: sale.id,
        status: sale.status === "active" ? "inactive" : "active",
        idempotencyKey: crypto.randomUUID(),
      });
      setSales((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? null);
      toast.success(
        next.status === "active" ? t("website.sales.resumed") : t("website.sales.paused"),
      );
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const sale = deleting;
    setBusyId(sale.id);
    try {
      await client.deleteSale(sale.id);
      setSales((current) => current?.filter((item) => item.id !== sale.id) ?? null);
      toast.success(t("website.sales.deleted", { name: sale.name }));
      setDeleting(null);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            {t("website.tab.sales")}
            {sales ? <span className="muted"> · {sales.length}</span> : null}
          </h2>
          {canManage ? (
            <button
              className="button"
              data-testid="website-sale-new"
              onClick={() => setEditing({ sale: null })}
            >
              {t("website.sales.new")}
            </button>
          ) : null}
        </div>
        <p className="muted website-card-intro">{t("website.sales.intro")}</p>
        {!canManage ? (
          <p className="notice website-card-intro" role="status">
            {t("website.readOnly")}
          </p>
        ) : null}
        {loading ? <SkeletonLines lines={4} label={t("website.sales.loading")} /> : null}
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button className="button button--quiet" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : null}
        {!loading && !error && sales?.length === 0 ? (
          <p className="staff-empty">{t("website.sales.empty")}</p>
        ) : null}
        {!loading && !error && sales && sales.length > 0 ? (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("website.sales.name")}</th>
                  <th>{t("website.sales.discount")}</th>
                  <th>{t("website.sales.appliesTo")}</th>
                  <th>{t("website.sales.schedule")}</th>
                  <th>{t("website.sales.state")}</th>
                  {canManage ? <th className="end">{t("website.actions")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => {
                  const live = saleLiveState(sale);
                  const tone = saleStateTone(live);
                  return (
                    <tr key={sale.id} data-testid={`website-sale-${sale.id}`}>
                      <td>{sale.name}</td>
                      <td>{benefitLabel(sale)}</td>
                      <td>{scopeLabel(sale)}</td>
                      <td>{windowLabel(sale)}</td>
                      <td>
                        <span className={`pill${tone ? ` pill--${tone}` : ""}`}>
                          {t(`website.sales.state.${live}`)}
                        </span>
                      </td>
                      {canManage ? (
                        <td className="end website-row-actions">
                          <button
                            className="link"
                            disabled={busyId !== null}
                            onClick={() => setEditing({ sale })}
                          >
                            {t("website.edit")}
                          </button>
                          <button
                            className="link"
                            disabled={busyId !== null}
                            onClick={() => void toggleStatus(sale)}
                          >
                            {sale.status === "active"
                              ? t("website.sales.pause")
                              : t("website.sales.resume")}
                          </button>
                          <button
                            className="link link--danger"
                            disabled={busyId !== null}
                            onClick={() => setDeleting(sale)}
                          >
                            {t("website.delete")}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editing ? (
        <SaleEditor
          client={client}
          sale={editing.sale}
          collections={collections}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setSales((current) => {
              const list = current ?? [];
              return list.some((item) => item.id === saved.id)
                ? list.map((item) => (item.id === saved.id ? saved : item))
                : [saved, ...list];
            });
            setEditing(null);
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={t("website.sales.deleteTitle")}
          message={t("website.sales.deleteMessage", { name: deleting.name })}
          confirmLabel={t("website.delete")}
          busy={busyId === deleting.id}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  );
}

function SaleEditor({
  client,
  sale,
  collections,
  onCancel,
  onSaved,
}: {
  client: SalesClient;
  sale: Sale | null;
  collections: readonly CollectionItem[];
  onCancel: () => void;
  onSaved: (sale: Sale) => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const ref = useModalA11y<HTMLDivElement>(onCancel);
  const [form, setForm] = useState<SaleFormState>(() =>
    sale ? saleToForm(sale) : emptySaleForm(),
  );
  const [errors, setErrors] = useState<SaleFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  // A retry of the exact same request (e.g. after a network failure) replays its idempotency key so the
  // server cannot create the sale twice; any edit to the form gets a fresh key.
  const [attempt, setAttempt] = useState<{ body: string; key: string } | null>(null);

  const needsProducts = form.scope === "products";
  useEffect(() => {
    if (!needsProducts || products !== null) return;
    let active = true;
    loadAllProducts(client)
      .then((items) => {
        if (active) setProducts(items);
      })
      .catch((err: unknown) => {
        if (active) setProductsError(describeWebsiteError(err, t));
      });
    return () => {
      active = false;
    };
  }, [client, needsProducts, products, t]);

  const fieldError = (value: FieldError | undefined) =>
    value ? (
      <span className="website-field-error" role="alert">
        {t(value.key, value.vars)}
      </span>
    ) : null;

  function update<K extends keyof SaleFormState>(key: K, value: SaleFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  const submit = async () => {
    const next = validateSaleForm(form);
    setErrors(next);
    if (Object.values(next).some(Boolean)) {
      toast.error(t("website.err.fixFields"));
      return;
    }
    const body = JSON.stringify(form);
    const idempotencyKey = attempt?.body === body ? attempt.key : crypto.randomUUID();
    setAttempt({ body, key: idempotencyKey });
    setSaving(true);
    try {
      const saved = sale
        ? await client.updateSale({
            saleId: sale.id,
            ...buildUpdateSaleRequest(form),
            idempotencyKey,
          })
        : await client.createSale({ ...buildCreateSaleRequest(form), idempotencyKey });
      toast.success(sale ? t("website.sales.savedToast") : t("website.sales.createdToast"));
      onSaved(saved);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const preview = previewSalePrice(form, PREVIEW_PRICE_MINOR);
  const percentBadge =
    preview !== null && preview < PREVIEW_PRICE_MINOR
      ? Math.round(((PREVIEW_PRICE_MINOR - preview) / PREVIEW_PRICE_MINOR) * 100)
      : null;

  return (
    <div className="staff-modal__scrim" role="presentation" onClick={saving ? undefined : onCancel}>
      <div
        className="staff-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="website-sale-title"
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="website-sale-title">
          {sale ? t("website.sales.editTitle") : t("website.sales.createTitle")}
        </h3>
        <div className="settings-grid">
          <label className="field settings-grid__wide">
            {t("website.sales.name")}
            <input
              value={form.name}
              placeholder={t("website.sales.namePlaceholder")}
              disabled={saving}
              data-testid="website-sale-name"
              onChange={(event) => update("name", event.target.value)}
            />
            {fieldError(errors.name)}
          </label>
          <label className="field">
            {t("website.sales.discountType")}
            <Select<SaleFormState["benefitType"]>
              ariaLabel={t("website.sales.discountType")}
              value={form.benefitType}
              disabled={saving}
              onChange={(value) => {
                update("benefitType", value);
                update("value", "");
              }}
              options={[
                { value: "percentage", label: t("website.sales.typePercentage") },
                { value: "fixed_amount", label: t("website.sales.typeFixed") },
              ]}
            />
          </label>
          <label className="field">
            {form.benefitType === "percentage"
              ? t("website.sales.percentField")
              : t("website.sales.amountField", { currency: form.currency })}
            <input
              inputMode="decimal"
              value={form.value}
              placeholder={form.benefitType === "percentage" ? "25" : "100.00"}
              disabled={saving}
              data-testid="website-sale-value"
              onChange={(event) => update("value", event.target.value)}
            />
            {fieldError(errors.value)}
          </label>
          <div
            className="website-sale-preview settings-grid__wide"
            data-testid="website-sale-preview"
          >
            <span className="muted">{t("website.sales.previewLabel")}</span>
            {percentBadge !== null ? (
              <span className="website-sale-badge">
                {t("website.sales.badge", { percent: percentBadge })}
              </span>
            ) : null}
            <s className="muted">{formatMoney(PREVIEW_PRICE_MINOR, form.currency, locale)}</s>
            <strong>{preview !== null ? formatMoney(preview, form.currency, locale) : "—"}</strong>
          </div>

          <label className="field">
            {t("website.sales.appliesTo")}
            <Select<SaleFormState["scope"]>
              ariaLabel={t("website.sales.appliesTo")}
              value={form.scope}
              disabled={saving}
              onChange={(value) => update("scope", value)}
              options={[
                { value: "all", label: t("website.sales.scopeAll") },
                { value: "collection", label: t("website.sales.scopeCollection") },
                { value: "products", label: t("website.sales.scopeProducts") },
              ]}
            />
          </label>
          {form.scope === "all" ? <p className="muted">{t("website.sales.scopeAllHelp")}</p> : null}
          {form.scope === "collection" ? (
            collections.length === 0 ? (
              <p className="staff-empty">{t("website.noCollections")}</p>
            ) : (
              <label className="field">
                {t("website.sales.collection")}
                <Select<string>
                  ariaLabel={t("website.sales.collection")}
                  value={form.collectionId}
                  disabled={saving}
                  onChange={(value) => update("collectionId", value)}
                  options={[
                    { value: "", label: t("website.sales.chooseCollection"), disabled: true },
                    ...collections.map((item) => ({
                      value: item.id,
                      label: item.status === "active" ? item.name : `${item.name} (${item.status})`,
                    })),
                  ]}
                />
                {fieldError(errors.collectionId)}
              </label>
            )
          ) : null}
          {form.scope === "products" ? (
            <div className="settings-grid__wide">
              {productsError ? (
                <div className="notice notice--error" role="alert">
                  <span>{productsError}</span>
                  <button
                    className="button button--quiet"
                    onClick={() => {
                      setProductsError(null);
                      setProducts(null);
                    }}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : products === null ? (
                <SkeletonLines lines={3} label={t("website.loadingProducts")} />
              ) : (
                <ItemPicker
                  label={t("website.sales.products")}
                  testId="website-sale-products"
                  items={products.map((item) => ({
                    id: item.id,
                    name: item.name,
                    meta: item.styleCode,
                  }))}
                  selected={form.productIds}
                  onChange={(value) => update("productIds", value)}
                  disabled={saving}
                  error={errors.productIds ? t(errors.productIds.key) : null}
                />
              )}
            </div>
          ) : null}

          <p className="muted settings-grid__wide">{t("website.sales.scheduleHelp")}</p>
          <label className="field">
            {t("website.sales.startsAt")}
            <input
              type="datetime-local"
              value={form.startsAt}
              disabled={saving}
              data-testid="website-sale-starts"
              onChange={(event) => update("startsAt", event.target.value)}
            />
            {fieldError(errors.startsAt)}
          </label>
          <label className="field">
            {t("website.sales.endsAt")}
            <input
              type="datetime-local"
              value={form.endsAt}
              disabled={saving}
              data-testid="website-sale-ends"
              onChange={(event) => update("endsAt", event.target.value)}
            />
            {fieldError(errors.endsAt)}
          </label>
          {sale ? null : (
            <label className="field settings-check settings-grid__wide">
              <input
                type="checkbox"
                checked={form.active}
                disabled={saving}
                onChange={(event) => update("active", event.target.checked)}
              />
              {t("website.sales.startActive")}
            </label>
          )}
        </div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button
            className="button button--complete"
            disabled={saving}
            data-testid="website-sale-submit"
            onClick={() => void submit()}
          >
            {saving
              ? t("website.saving")
              : sale
                ? t("website.saveChanges")
                : t("website.sales.createCta")}
          </button>
        </div>
      </div>
    </div>
  );
}
