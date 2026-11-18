import type {
  MeContextResponse,
  ProductDetailResponse,
  PromotionDetail,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";
import { loadAllProducts, type ProductItem } from "./access";
import type { FieldError } from "./content-form";
import { describeWebsiteError } from "./errors";
import {
  buildCreatePromotionRequest,
  buildUpdatePromotionRequest,
  emptyPromotionForm,
  promotionInitialCode,
  promotionToForm,
  targetKey,
  validatePromotionForm,
  type PromotionFormErrors,
  type PromotionFormState,
  type PromotionTargetChoice,
} from "./promotion-form";

export type PromotionEditorClient = Pick<
  TenantCommerceClient,
  "createPromotion" | "updatePromotion" | "createPromotionCode" | "listProducts" | "getProduct"
>;

type Option = { value: string; label: string };

/** Brand / branch restriction choices from `/me/context` (same sources as Admin Mobile). */
export function restrictionOptions(context: Pick<MeContextResponse, "access"> | null): {
  brands: Option[];
  branches: Option[];
} {
  const brands = new Map<string, string>();
  const access = context?.access;
  for (const brand of [...(access?.catalog.brands ?? []), ...(access?.orders?.brands ?? [])]) {
    brands.set(brand.id, brand.name);
  }
  return {
    brands: [...brands].map(([value, label]) => ({ value, label })),
    branches: (access?.orders?.branches ?? []).map((branch) => ({
      value: branch.id,
      label: branch.name,
    })),
  };
}

// Create or edit any promotion — automatic or code, whole order or chosen products/variants, any
// channel — matching Admin Mobile's Promotion form. Every setting stays editable after creation and after
// redemption (owner decision 2026-11-18); past orders keep the discount they were granted. Switching an
// existing promotion to code activation asks for its first code when it has none. Idempotency: an
// identical retry reuses its key.
export function PromotionEditor({
  client,
  context,
  catalogRead,
  promotion,
  onCancel,
  onSaved,
}: {
  client: PromotionEditorClient;
  context: Pick<MeContextResponse, "access"> | null;
  catalogRead: boolean;
  promotion: PromotionDetail | null;
  onCancel: () => void;
  onSaved: (promotion: PromotionDetail) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const ref = useModalA11y<HTMLDivElement>(onCancel);
  const mode = promotion ? "edit" : "create";
  const [form, setForm] = useState<PromotionFormState>(() =>
    promotion ? promotionToForm(promotion) : emptyPromotionForm(),
  );
  const [errors, setErrors] = useState<PromotionFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<{ body: string; key: string } | null>(null);
  const { brands, branches } = useMemo(() => restrictionOptions(context), [context]);
  // A code promotion needs a first code: always on create, and on edit when it has no active code.
  const needsFirstCode =
    form.activationType === "code" &&
    (!promotion || !promotion.codes.some((code) => code.status === "active"));

  function update<K extends keyof PromotionFormState>(key: K, value: PromotionFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  const fieldError = (value: FieldError | undefined) =>
    value ? (
      <span className="website-field-error" role="alert">
        {t(value.key, value.vars)}
      </span>
    ) : null;

  const submit = async () => {
    const next = validatePromotionForm(form, mode, { requireInitialCode: needsFirstCode });
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
      let saved: PromotionDetail;
      if (promotion) {
        saved = await client.updatePromotion({
          promotionId: promotion.id,
          ...buildUpdatePromotionRequest(form, promotion),
          idempotencyKey,
        });
        const firstCode = needsFirstCode ? promotionInitialCode(form) : null;
        if (firstCode) {
          saved = await client.createPromotionCode({
            promotionId: promotion.id,
            ...firstCode,
            idempotencyKey: `${idempotencyKey}:code`,
          });
        }
      } else {
        saved = await client.createPromotion({
          ...buildCreatePromotionRequest(form),
          idempotencyKey,
        });
      }
      toast.success(promotion ? t("website.promo.savedToast") : t("website.promo.createdToast"));
      onSaved(saved);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const readOnlyRow = (label: string, value: string) => (
    <div className="field">
      <span>{label}</span>
      <strong className="website-readonly">{value}</strong>
    </div>
  );

  return (
    <div className="staff-modal__scrim" role="presentation" onClick={saving ? undefined : onCancel}>
      <div
        className="staff-modal settings-modal website-promo-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="website-promo-editor-title"
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="website-promo-editor-title">
          {promotion ? t("website.promo.editTitle") : t("website.promo.createTitle")}
        </h3>
        {promotion && promotion.redemptionCount > 0 ? (
          <p className="notice" role="status" data-testid="website-promo-used">
            {t("website.promo.usedNotice", { count: promotion.redemptionCount })}
          </p>
        ) : null}

        <Section title={t("website.promo.sectionBasics")}>
          <label className="field settings-grid__wide">
            {t("website.promo.name")}
            <input
              value={form.name}
              disabled={saving}
              placeholder={t("website.promo.namePlaceholder")}
              data-testid="website-promo-name"
              onChange={(event) => update("name", event.target.value)}
            />
            {fieldError(errors.name)}
          </label>
          <label className="field settings-grid__wide">
            {t("website.promo.description")}
            <textarea
              rows={2}
              value={form.description}
              disabled={saving}
              onChange={(event) => update("description", event.target.value)}
            />
            {fieldError(errors.description)}
          </label>
          <label className="field">
            {t("website.promo.activation")}
            <Select<PromotionFormState["activationType"]>
              ariaLabel={t("website.promo.activation")}
              value={form.activationType}
              disabled={saving}
              onChange={(value) => update("activationType", value)}
              options={[
                { value: "automatic", label: t("website.promo.activation.automaticLong") },
                { value: "code", label: t("website.promo.activation.codeLong") },
              ]}
            />
          </label>
          {mode === "create" ? (
            <label className="field">
              {t("website.promo.initialStatus")}
              <Select<PromotionFormState["status"]>
                ariaLabel={t("website.promo.initialStatus")}
                value={form.status}
                disabled={saving}
                onChange={(value) => update("status", value)}
                options={[
                  { value: "inactive", label: t("website.promo.startPaused") },
                  { value: "active", label: t("website.promo.startActive") },
                ]}
              />
            </label>
          ) : null}
        </Section>

        <Section title={t("website.promo.sectionBenefit")}>
          <label className="field">
            {t("website.promo.discountType")}
            <Select<PromotionFormState["benefitType"]>
              ariaLabel={t("website.promo.discountType")}
              value={form.benefitType}
              disabled={saving}
              onChange={(value) => {
                setForm((current) => ({
                  ...current,
                  benefitType: value,
                  benefitValue: "",
                  channel: value === "buy_x_get_y" ? "online" : current.channel,
                }));
                setErrors((current) => ({ ...current, benefitValue: undefined }));
              }}
              options={[
                { value: "percentage", label: t("website.promo.benefit.percentage") },
                { value: "fixed_amount", label: t("website.promo.benefit.fixed_amount") },
                { value: "buy_x_get_y", label: t("website.promo.benefit.buy_x_get_y") },
              ]}
            />
          </label>
          {form.benefitType === "buy_x_get_y" ? (
            <>
              <p className="muted settings-grid__wide">{t("website.promo.bxgyHelp")}</p>
              <label className="field">
                {t("website.promo.buyQuantity")}
                <input
                  inputMode="numeric"
                  value={form.buyQuantity}
                  disabled={saving}
                  data-testid="website-promo-buy"
                  onChange={(event) => update("buyQuantity", event.target.value)}
                />
                {fieldError(errors.buyQuantity)}
              </label>
              <label className="field">
                {t("website.promo.getQuantity")}
                <input
                  inputMode="numeric"
                  value={form.getQuantity}
                  disabled={saving}
                  data-testid="website-promo-get"
                  onChange={(event) => update("getQuantity", event.target.value)}
                />
                {fieldError(errors.getQuantity)}
              </label>
            </>
          ) : (
            <label className="field">
              {form.benefitType === "percentage"
                ? t("website.sales.percentField")
                : t("website.promo.fixedField", { currency: form.currency })}
              <input
                inputMode="decimal"
                value={form.benefitValue}
                disabled={saving}
                placeholder={form.benefitType === "percentage" ? "10" : "25.00"}
                data-testid="website-promo-value"
                onChange={(event) => update("benefitValue", event.target.value)}
              />
              {fieldError(errors.benefitValue)}
            </label>
          )}
        </Section>

        <Section title={t("website.promo.sectionEligibility")}>
          <label className="field">
            {t("website.promo.target")}
            <Select<PromotionFormState["targetType"]>
              ariaLabel={t("website.promo.target")}
              value={form.targetType}
              disabled={saving}
              onChange={(value) => update("targetType", value)}
              options={[
                { value: "order", label: t("website.promo.target.order") },
                { value: "variant_scope", label: t("website.promo.target.variant_scope") },
              ]}
            />
          </label>
          {form.targetType === "variant_scope" ? (
            <div className="settings-grid__wide">
              {catalogRead ? (
                <TargetPicker
                  client={client}
                  choices={form.targets}
                  disabled={saving}
                  onChange={(value) => update("targets", value)}
                />
              ) : (
                <p className="notice notice--warning" role="status">
                  {t("website.promo.catalogDenied")}
                </p>
              )}
              {fieldError(errors.targets)}
            </div>
          ) : null}
          <label className="field">
            {t("website.promo.minSubtotal", { currency: form.currency })}
            <input
              inputMode="decimal"
              value={form.minimumSubtotal}
              disabled={saving}
              placeholder="50.00"
              onChange={(event) => update("minimumSubtotal", event.target.value)}
            />
            {fieldError(errors.minimumSubtotal)}
          </label>
          <label className="field">
            {t("website.promo.maxDiscount", { currency: form.currency })}
            <input
              inputMode="decimal"
              value={form.maximumDiscount}
              disabled={saving}
              placeholder="100.00"
              onChange={(event) => update("maximumDiscount", event.target.value)}
            />
            {fieldError(errors.maximumDiscount)}
          </label>
          {form.benefitType === "buy_x_get_y" ? (
            readOnlyRow(t("website.promo.channel"), t("website.promo.channel.online"))
          ) : (
            <label className="field">
              {t("website.promo.channel")}
              <Select<PromotionFormState["channel"]>
                ariaLabel={t("website.promo.channel")}
                value={form.channel}
                disabled={saving}
                onChange={(value) => update("channel", value)}
                options={[
                  { value: "all", label: t("website.promo.channel.all") },
                  { value: "online", label: t("website.promo.channel.online") },
                  { value: "pos", label: t("website.promo.channel.pos") },
                ]}
              />
            </label>
          )}
          <label className="field">
            {t("website.promo.brand")}
            <Select<string>
              ariaLabel={t("website.promo.brand")}
              value={form.brandId}
              disabled={saving}
              onChange={(value) => update("brandId", value)}
              options={[{ value: "", label: t("website.promo.allBrands") }, ...brands]}
            />
          </label>
          <label className="field">
            {t("website.promo.branch")}
            <Select<string>
              ariaLabel={t("website.promo.branch")}
              value={form.branchId}
              disabled={saving}
              onChange={(value) => update("branchId", value)}
              options={[{ value: "", label: t("website.promo.allBranches") }, ...branches]}
            />
          </label>
        </Section>

        <Section title={t("website.promo.sectionUsage")}>
          <label className="field">
            {t("website.promo.globalLimit")}
            <input
              inputMode="numeric"
              value={form.globalLimit}
              disabled={saving}
              placeholder={t("website.promo.unlimited")}
              data-testid="website-promo-global-limit"
              onChange={(event) => update("globalLimit", event.target.value)}
            />
            {fieldError(errors.globalLimit)}
          </label>
          {needsFirstCode ? (
            <>
              <label className="field">
                {mode === "create" ? t("website.promo.initialCode") : t("website.promo.firstCode")}
                <input
                  value={form.initialCode}
                  disabled={saving}
                  placeholder="WELCOME10"
                  data-testid="website-promo-code"
                  onChange={(event) => update("initialCode", event.target.value.toUpperCase())}
                />
                {fieldError(errors.initialCode)}
              </label>
              <CodeLimitFields
                kind={form.codeLimitKind}
                custom={form.codeCustomLimit}
                disabled={saving}
                error={errors.codeCustomLimit}
                onKind={(value) => update("codeLimitKind", value)}
                onCustom={(value) => update("codeCustomLimit", value)}
              />
            </>
          ) : form.activationType === "code" && mode === "edit" ? (
            <p className="muted settings-grid__wide">{t("website.promo.codesInDetails")}</p>
          ) : null}
        </Section>

        <Section title={t("website.promo.sectionSchedule")}>
          <label className="field">
            {t("website.sales.startsAt")}
            <input
              type="datetime-local"
              value={form.startsAt}
              disabled={saving}
              data-testid="website-promo-starts"
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
              data-testid="website-promo-ends"
              onChange={(event) => update("endsAt", event.target.value)}
            />
            {fieldError(errors.endsAt)}
          </label>
        </Section>

        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button
            className="button button--complete"
            disabled={saving}
            data-testid="website-promo-submit"
            onClick={() => void submit()}
          >
            {saving
              ? t("website.saving")
              : promotion
                ? t("website.saveChanges")
                : t("website.promo.createCta")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="website-fieldset">
      <legend>{title}</legend>
      <div className="settings-grid">{children}</div>
    </fieldset>
  );
}

/** "Unlimited / single use / custom" per-code limit (shared by create and "add code"). */
export function CodeLimitFields({
  kind,
  custom,
  disabled,
  error,
  onKind,
  onCustom,
}: {
  kind: PromotionFormState["codeLimitKind"];
  custom: string;
  disabled: boolean;
  error?: FieldError;
  onKind: (value: PromotionFormState["codeLimitKind"]) => void;
  onCustom: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        {t("website.promo.codeUse")}
        <Select<PromotionFormState["codeLimitKind"]>
          ariaLabel={t("website.promo.codeUse")}
          value={kind}
          disabled={disabled}
          onChange={onKind}
          options={[
            { value: "unlimited", label: t("website.promo.codeUnlimited") },
            { value: "single", label: t("website.promo.codeSingle") },
            { value: "custom", label: t("website.promo.codeCustom") },
          ]}
        />
      </label>
      {kind === "custom" ? (
        <label className="field">
          {t("website.promo.codeLimit")}
          <input
            inputMode="numeric"
            value={custom}
            disabled={disabled}
            data-testid="website-promo-code-limit"
            onChange={(event) => onCustom(event.target.value)}
          />
          {error ? (
            <span className="website-field-error" role="alert">
              {t(error.key, error.vars)}
            </span>
          ) : null}
        </label>
      ) : null}
    </>
  );
}

const VISIBLE_RESULTS = 40;
type Variant = ProductDetailResponse["variants"][number];

// Product / variant targets: search the catalog on the left, then add the whole product or one of its
// variants (loaded on demand). The chosen targets are listed on the right.
function TargetPicker({
  client,
  choices,
  disabled,
  onChange,
}: {
  client: Pick<PromotionEditorClient, "listProducts" | "getProduct">;
  choices: PromotionTargetChoice[];
  disabled: boolean;
  onChange: (next: PromotionTargetChoice[]) => void;
}) {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ProductItem | null>(null);
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [variantsError, setVariantsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadAllProducts(client)
      .then((items) => {
        if (active) setProducts(items);
      })
      .catch((err: unknown) => {
        if (active) setError(describeWebsiteError(err, t));
      });
    return () => {
      active = false;
    };
  }, [client, reload, t]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    client
      .getProduct(open.id)
      .then((detail) => {
        if (active) setVariants(detail.variants);
      })
      .catch((err: unknown) => {
        if (active) setVariantsError(describeWebsiteError(err, t));
      });
    return () => {
      active = false;
    };
  }, [client, open, t]);

  const matches = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (products ?? [])
      .filter(
        (item) =>
          !term ||
          item.name.toLocaleLowerCase().includes(term) ||
          (item.styleCode ?? "").toLocaleLowerCase().includes(term),
      )
      .slice(0, VISIBLE_RESULTS);
  }, [products, search]);

  const chosen = new Set(choices.map(targetKey));
  const add = (choice: PromotionTargetChoice) => {
    if (!chosen.has(targetKey(choice))) onChange([...choices, choice]);
  };
  const openProduct = (product: ProductItem) => {
    setVariants(null);
    setVariantsError(null);
    setOpen(product);
  };

  return (
    <div className="website-picker" data-testid="website-promo-targets">
      <div className="website-picker__pane">
        <label className="field">
          {t("website.promo.targetSearch")}
          <input
            type="search"
            value={search}
            disabled={disabled}
            placeholder={t("website.picker.search")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setError(null);
                setProducts(null);
                setReload((n) => n + 1);
              }}
            >
              {t("common.retry")}
            </button>
          </div>
        ) : products === null ? (
          <SkeletonLines lines={3} label={t("website.loadingProducts")} />
        ) : (
          <ul className="website-picker__list" aria-label={t("website.promo.targetSearch")}>
            {matches.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className={`website-picker__option website-picker__option--button${
                    open?.id === product.id ? " website-picker__option--open" : ""
                  }`}
                  disabled={disabled}
                  onClick={() => openProduct(product)}
                >
                  <span>{product.name}</span>
                  {product.styleCode ? <small className="muted">{product.styleCode}</small> : null}
                </button>
                {open?.id === product.id ? (
                  <div className="website-target-variants">
                    <button
                      type="button"
                      className="link"
                      disabled={disabled || chosen.has(`p:${product.id}`)}
                      data-testid="website-promo-add-product"
                      onClick={() =>
                        add({
                          target: { productId: product.id, variantId: null },
                          label: product.name,
                        })
                      }
                    >
                      {t("website.promo.addWholeProduct")}
                    </button>
                    {variantsError ? (
                      <span className="website-field-error" role="alert">
                        {variantsError}
                      </span>
                    ) : variants === null ? (
                      <span className="muted">{t("website.promo.loadingVariants")}</span>
                    ) : variants.length === 0 ? (
                      <span className="muted">{t("website.promo.noVariants")}</span>
                    ) : (
                      variants.map((variant) => (
                        <button
                          key={variant.id}
                          type="button"
                          className="link"
                          disabled={disabled || chosen.has(`v:${variant.id}`)}
                          data-testid={`website-promo-add-variant-${variant.id}`}
                          onClick={() =>
                            add({
                              target: { productId: null, variantId: variant.id },
                              label: `${product.name} · ${variant.displayName ?? variant.sku}`,
                            })
                          }
                        >
                          + {variant.displayName ?? variant.sku}
                          <small className="muted"> {variant.sku}</small>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="staff-empty">{t("website.picker.none")}</li>
            ) : null}
          </ul>
        )}
      </div>
      <div className="website-picker__pane">
        <p className="field__label">{t("website.picker.selected", { count: choices.length })}</p>
        {choices.length === 0 ? (
          <p className="staff-empty">{t("website.promo.noTargets")}</p>
        ) : (
          <ol className="website-picker__selected">
            {choices.map((choice) => (
              <li key={targetKey(choice)}>
                <span>
                  <small className="muted">
                    {choice.target.productId
                      ? t("website.promo.targetProduct")
                      : t("website.promo.targetVariant")}
                  </small>{" "}
                  {choice.label}
                </span>
                <button
                  type="button"
                  className="link link--danger"
                  aria-label={t("website.picker.remove")}
                  disabled={disabled}
                  onClick={() =>
                    onChange(choices.filter((item) => targetKey(item) !== targetKey(choice)))
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
