import type {
  CollectionListResponse,
  CreateStorefrontHeroImageIntentRequest,
  StorefrontContent,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { CommerceSdkError } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { loadAllProducts, type ProductItem } from "./access";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  buildContentRequest,
  CONTENT_LIMITS,
  contentToForm,
  MAX_FEATURED_COLLECTIONS,
  MAX_FEATURED_PRODUCTS,
  validateContentForm,
  type FieldError,
  type StorefrontContentErrors,
  type StorefrontContentForm,
} from "./content-form";
import { describeWebsiteError } from "./errors";
import { ItemPicker } from "./ItemPicker";

export type HomePageClient = Pick<
  TenantCommerceClient,
  | "getStorefrontContent"
  | "updateStorefrontContent"
  | "createStorefrontHeroImageIntent"
  | "listProducts"
  | "listCollections"
>;

type CollectionItem = CollectionListResponse["collections"][number];
type HeroContentType = CreateStorefrontHeroImageIntentRequest["contentType"];
const HERO_TYPES: readonly HeroContentType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

// Home-page editor: hero (eyebrow, headline, subtitle, button, image) and the curated featured products
// and collections, in display order. Structured content only — the website owns the layout. Authorized
// by catalog.author on the server; this panel is shown to catalog readers (same as Admin Mobile) and a
// 403 on save surfaces as a clear error.
export function HomePagePanel({
  client,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: {
  client: HomePageClient;
  fetchImpl?: typeof globalThis.fetch;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<StorefrontContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContent(await client.getStorefrontContent());
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

  if (loading) return <SkeletonLines lines={6} label={t("website.home.loading")} />;
  if (error || !content)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error ?? t("website.err.generic")}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  return <HomePageEditor client={client} initial={content} fetchImpl={fetchImpl} />;
}

function useCatalogLists(client: HomePageClient) {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [collections, setCollections] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [productList, collectionList] = await Promise.all([
        loadAllProducts(client),
        client.listCollections(),
      ]);
      setProducts(productList);
      setCollections(collectionList.collections);
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external read
    void load();
  }, [load]);
  return { products, collections, error, reload: load };
}

function HomePageEditor({
  client,
  initial,
  fetchImpl,
}: {
  client: HomePageClient;
  initial: StorefrontContent;
  fetchImpl: typeof globalThis.fetch;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [saved, setSaved] = useState<StorefrontContentForm>(() => contentToForm(initial));
  const [form, setForm] = useState<StorefrontContentForm>(saved);
  const [errors, setErrors] = useState<StorefrontContentErrors>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lists = useCatalogLists(client);

  // Release a local preview object URL when it is replaced or the editor unmounts.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const fieldError = (value: FieldError | undefined) => (value ? t(value.key, value.vars) : null);

  function update<K extends keyof StorefrontContentForm>(key: K, value: StorefrontContentForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function uploadImage(file: File) {
    setUploadError(null);
    const contentType = file.type as HeroContentType;
    if (!HERO_TYPES.includes(contentType)) {
      setUploadError(t("website.home.imageType"));
      return;
    }
    setUploading(true);
    try {
      const intent = await client.createStorefrontHeroImageIntent({
        contentType,
        ...(file.name ? { fileName: file.name.slice(0, 200) } : {}),
      });
      if (!intent.uploadUrl) throw new Error(t("website.home.storageUnavailable"));
      const response = await fetchImpl(intent.uploadUrl, {
        method: "PUT",
        headers: { "content-type": intent.contentType },
        body: file,
      });
      if (!response.ok)
        throw new Error(t("website.home.uploadFailed", { status: response.status }));
      update("image", { bucket: intent.bucket, path: intent.path });
      setPreview(typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null);
      toast.success(t("website.home.imageUploaded"));
    } catch (err) {
      // SDK failures get the shared wording; local upload failures already carry translated copy.
      setUploadError(
        err instanceof CommerceSdkError || !(err instanceof Error)
          ? describeWebsiteError(err, t)
          : err.message,
      );
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    const next = validateContentForm(form);
    setErrors(next);
    if (Object.values(next).some(Boolean)) {
      toast.error(t("website.err.fixFields"));
      return;
    }
    setSaving(true);
    try {
      const result = await client.updateStorefrontContent({
        ...buildContentRequest(form),
        idempotencyKey: crypto.randomUUID(),
      });
      const nextForm = contentToForm(result);
      setSaved(nextForm);
      setForm(nextForm);
      toast.success(t("website.home.saved"));
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || uploading;
  const textField = (
    key: keyof typeof CONTENT_LIMITS,
    labelKey: string,
    options: { placeholder?: string; hint?: string; multiline?: boolean } = {},
  ) => (
    <label className={`field${options.multiline ? " settings-grid__wide" : ""}`}>
      {t(labelKey)}
      {options.multiline ? (
        <textarea
          rows={3}
          value={form[key]}
          maxLength={CONTENT_LIMITS[key] * 2}
          disabled={busy}
          data-testid={`website-hero-${key}`}
          onChange={(event) => update(key, event.target.value)}
        />
      ) : (
        <input
          value={form[key]}
          placeholder={options.placeholder}
          disabled={busy}
          data-testid={`website-hero-${key}`}
          onChange={(event) => update(key, event.target.value)}
        />
      )}
      <small className="muted">
        {options.hint ? `${options.hint} · ` : ""}
        {form[key].trim().length}/{CONTENT_LIMITS[key]}
      </small>
      {errors[key] ? (
        <span className="website-field-error" role="alert">
          {fieldError(errors[key])}
        </span>
      ) : null}
    </label>
  );

  return (
    <>
      <p className="notice website-desk-intro">{t("website.home.intro")}</p>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.home.hero")}</h2>
        </div>
        <div className="settings-grid">
          <div className="website-hero-image settings-grid__wide" data-testid="website-hero-image">
            {preview ? (
              <img src={preview} alt={form.imageAlt || t("website.home.heroImage")} />
            ) : (
              <span className="muted">
                {form.image
                  ? t("website.home.imageSaved", { path: form.image.path })
                  : t("website.home.noImage")}
              </span>
            )}
          </div>
          <div className="button-row settings-grid__wide">
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={HERO_TYPES.join(",")}
              data-testid="website-hero-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadImage(file);
              }}
            />
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {uploading
                ? t("website.home.uploading")
                : form.image
                  ? t("website.home.replaceImage")
                  : t("website.home.chooseImage")}
            </button>
            {form.image ? (
              <button
                type="button"
                className="link link--danger"
                disabled={busy}
                data-testid="website-hero-remove"
                onClick={() => {
                  update("image", null);
                  setPreview(null);
                }}
              >
                {t("website.home.removeImage")}
              </button>
            ) : null}
          </div>
          {uploadError ? (
            <p className="website-field-error settings-grid__wide" role="alert">
              {uploadError}
            </p>
          ) : null}
          {form.image
            ? textField("imageAlt", "website.home.imageAlt", {
                hint: t("website.home.imageAltHint"),
              })
            : null}
          {textField("eyebrow", "website.home.eyebrow", {
            hint: t("website.home.hideHint"),
            placeholder: t("website.home.eyebrowPlaceholder"),
          })}
          {textField("title", "website.home.headline", {
            placeholder: t("website.home.headlinePlaceholder"),
          })}
          {textField("subtitle", "website.home.subtitle", {
            multiline: true,
            hint: t("website.home.hideHint"),
          })}
          {textField("ctaLabel", "website.home.ctaLabel", {
            placeholder: t("website.home.ctaLabelPlaceholder"),
          })}
          {textField("ctaHref", "website.home.ctaHref", {
            placeholder: "/catalog",
            hint: t("website.home.ctaHrefHint"),
          })}
        </div>
      </section>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.home.featured")}</h2>
        </div>
        <div className="settings-grid">
          <p className="muted settings-grid__wide">{t("website.home.featuredHelp")}</p>
          {textField("featuredHeading", "website.home.featuredHeading", {
            placeholder: t("website.home.featuredHeadingPlaceholder"),
          })}
          <div className="settings-grid__wide">
            {lists.error ? (
              <div className="notice notice--error" role="alert">
                <span>{lists.error}</span>
                <button className="button button--quiet" onClick={() => void lists.reload()}>
                  {t("common.retry")}
                </button>
              </div>
            ) : lists.products === null ? (
              <SkeletonLines lines={3} label={t("website.loadingProducts")} />
            ) : (
              <ItemPicker
                label={t("website.home.featuredProducts")}
                testId="website-featured-products"
                items={lists.products.map((item) => ({
                  id: item.id,
                  name: item.name,
                  meta: item.status === "active" ? item.styleCode : item.status,
                }))}
                selected={form.featuredProductIds}
                onChange={(value) => update("featuredProductIds", value)}
                ordered
                max={MAX_FEATURED_PRODUCTS}
                disabled={busy}
                error={fieldError(errors.featuredProductIds)}
              />
            )}
          </div>
        </div>
      </section>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.home.collections")}</h2>
        </div>
        <div className="settings-grid">
          <p className="muted settings-grid__wide">{t("website.home.collectionsHelp")}</p>
          <div className="settings-grid__wide">
            {lists.error ? null : lists.collections === null ? (
              <SkeletonLines lines={2} label={t("website.loadingCollections")} />
            ) : lists.collections.length === 0 ? (
              <p className="staff-empty">{t("website.noCollections")}</p>
            ) : (
              <ItemPicker
                label={t("website.home.featuredCollections")}
                testId="website-featured-collections"
                items={lists.collections.map((item) => ({
                  id: item.id,
                  name: item.name,
                  meta: item.status === "active" ? null : item.status,
                }))}
                selected={form.featuredCollectionIds}
                onChange={(value) => update("featuredCollectionIds", value)}
                ordered
                max={MAX_FEATURED_COLLECTIONS}
                disabled={busy}
                error={fieldError(errors.featuredCollectionIds)}
              />
            )}
          </div>
        </div>
      </section>

      <div className="website-savebar">
        {dirty ? <span className="pill pill--warn">{t("website.unsaved")}</span> : null}
        <button
          type="button"
          className="button button--quiet"
          disabled={!dirty || busy}
          onClick={() => setConfirmDiscard(true)}
        >
          {t("website.discard")}
        </button>
        <button
          type="button"
          className="button button--complete"
          disabled={busy || !dirty}
          data-testid="website-home-save"
          onClick={() => void save()}
        >
          {saving ? t("website.saving") : t("website.home.save")}
        </button>
      </div>

      {confirmDiscard ? (
        <ConfirmDialog
          title={t("website.discardTitle")}
          message={t("website.discardMessage")}
          confirmLabel={t("website.discard")}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setForm(saved);
            setErrors({});
            setPreview(null);
            setConfirmDiscard(false);
          }}
        />
      ) : null}
    </>
  );
}
