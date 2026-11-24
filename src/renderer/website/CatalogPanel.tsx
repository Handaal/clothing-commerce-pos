import type {
  CategorySummary,
  CollectionListResponse,
  SizeGuide,
  TenantCommerceClient,
  VendorSummary,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { CatalogImagePicker } from "./CatalogImagePicker";
import { describeWebsiteError } from "./errors";
import { PanelHead } from "./PanelHead";

export type CatalogClient = Pick<
  TenantCommerceClient,
  | "listCollections"
  | "updateCollection"
  | "setCollectionStatus"
  | "setCollectionImage"
  | "listCategories"
  | "updateCategory"
  | "setCategoryImage"
  | "setCategorySizeGuide"
  | "listVendors"
  | "createVendor"
  | "updateVendor"
  | "setVendorStatus"
  | "createCatalogImageIntent"
>;

type Section = "collections" | "categories" | "brands";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const newKey = () => crypto.randomUUID();

// Website catalog (SDK 0.53, parity with Admin Mobile): rename collections and give them a cover,
// rename categories and give them a tile image and size guide, and manage the brands shoppers browse.
// Authorized by catalog.author on the server; this panel is shown to catalog readers.
export function CatalogPanel({ client }: { client: CatalogClient }) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("collections");
  return (
    <>
      <p className="notice website-desk-intro">{t("website.catalog.intro")}</p>
      <nav className="report-tabs" aria-label={t("website.tab.catalog")}>
        {(["collections", "categories", "brands"] as const).map((id) => (
          <button
            key={id}
            className={`report-tab${section === id ? " report-tab--active" : ""}`}
            aria-pressed={section === id}
            data-testid={`website-catalog-${id}`}
            onClick={() => setSection(id)}
          >
            {t(`website.catalog.${id}`)}
          </button>
        ))}
      </nav>
      {section === "collections" ? (
        <CollectionsSection client={client} />
      ) : section === "categories" ? (
        <CategoriesSection client={client} />
      ) : (
        <BrandsSection client={client} />
      )}
    </>
  );
}

function useList<T>(load: () => Promise<T[]>) {
  const { t } = useI18n();
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setItems(await load());
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [load, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void reload();
  }, [reload]);
  return { items, error, reload };
}

function ListState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useI18n();
  return error ? (
    <div className="notice notice--error" role="alert">
      <span>{error}</span>
      <button className="button button--quiet" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  ) : (
    <SkeletonLines lines={4} label={t("website.catalog.loading")} />
  );
}

// ─── Collections ─────────────────────────────────────────────────────────────────────────────────
function CollectionsSection({ client }: { client: CatalogClient }) {
  const { t } = useI18n();
  const load = useCallback(async () => (await client.listCollections()).collections, [client]);
  const { items, error, reload } = useList<CollectionListResponse["collections"][number]>(load);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!items) return <ListState error={error} onRetry={() => void reload()} />;
  return (
    <section className="staff-card">
      <PanelHead title={t("website.catalog.collections")} count={items.length} />
      {items.length === 0 ? <p className="staff-empty">{t("website.noCollections")}</p> : null}
      {items.map((item) => (
        <div
          key={item.id}
          className="website-site-item"
          data-testid={`website-collection-${item.id}`}
        >
          <div className="button-row">
            <strong>{item.name}</strong>
            <span className="pill">{t(`website.catalog.status.${item.status}`)}</span>
            <span className="muted">/{item.slug}</span>
            <button
              type="button"
              className="button button--quiet"
              data-testid={`website-collection-edit-${item.id}`}
              onClick={() => setOpenId(openId === item.id ? null : item.id)}
            >
              {openId === item.id ? t("website.catalog.close") : t("website.edit")}
            </button>
          </div>
          {openId === item.id ? (
            <CollectionEditor client={client} collection={item} onSaved={() => void reload()} />
          ) : null}
        </div>
      ))}
    </section>
  );
}

function CollectionEditor({
  client,
  collection,
  onSaved,
}: {
  client: CatalogClient;
  collection: CollectionListResponse["collections"][number];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(collection.name);
  const [slug, setSlug] = useState(collection.slug);
  const [description, setDescription] = useState(collection.description ?? "");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const dirty =
    name.trim() !== collection.name ||
    slug.trim() !== collection.slug ||
    description.trim() !== (collection.description ?? "");

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      toast.success(t("website.catalog.saved"));
      onSaved();
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!name.trim()) return setFieldError(t("website.catalog.nameRequired"));
    if (!SLUG.test(slug.trim())) return setFieldError(t("website.catalog.slugFormat"));
    setFieldError(null);
    void act(() =>
      client.updateCollection({
        collectionId: collection.id,
        name: name.trim(),
        slug: slug.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        idempotencyKey: newKey(),
      }),
    );
  }

  return (
    <div className="settings-grid">
      <label className="field">
        {t("website.catalog.name")}
        <input
          value={name}
          disabled={busy}
          data-testid="website-collection-name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        {t("website.catalog.slug")}
        <input
          value={slug}
          disabled={busy}
          data-testid="website-collection-slug"
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
        />
        <small className="muted">{t("website.catalog.slugHint")}</small>
      </label>
      <label className="field settings-grid__wide">
        {t("website.catalog.description")}
        <textarea
          rows={3}
          value={description}
          disabled={busy}
          data-testid="website-collection-description"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {fieldError ? (
        <span className="website-field-error settings-grid__wide" role="alert">
          {fieldError}
        </span>
      ) : null}
      <div className="button-row settings-grid__wide">
        <button
          type="button"
          className="button button--complete"
          disabled={!dirty || busy}
          data-testid="website-collection-save"
          onClick={save}
        >
          {t("website.saveChanges")}
        </button>
        {collection.status !== "active" ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            data-testid="website-collection-publish"
            onClick={() =>
              void act(() =>
                client.setCollectionStatus({
                  collectionId: collection.id,
                  status: "active",
                  idempotencyKey: newKey(),
                }),
              )
            }
          >
            {t("website.catalog.publish")}
          </button>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            data-testid="website-collection-unpublish"
            onClick={() =>
              void act(() =>
                client.setCollectionStatus({
                  collectionId: collection.id,
                  status: "draft",
                  idempotencyKey: newKey(),
                }),
              )
            }
          >
            {t("website.catalog.unpublish")}
          </button>
        )}
      </div>
      <CatalogImagePicker
        client={client}
        label={t("website.catalog.cover")}
        hint={t("website.catalog.coverHint")}
        image={collection.image}
        testId="website-collection-cover"
        onSave={async (image) => {
          await client.setCollectionImage({
            collectionId: collection.id,
            image,
            idempotencyKey: newKey(),
          });
          toast.success(t("website.catalog.saved"));
          onSaved();
        }}
      />
    </div>
  );
}

// ─── Categories ──────────────────────────────────────────────────────────────────────────────────
function CategoriesSection({ client }: { client: CatalogClient }) {
  const { t } = useI18n();
  const load = useCallback(async () => (await client.listCategories()).categories, [client]);
  const { items, error, reload } = useList<CategorySummary>(load);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!items) return <ListState error={error} onRetry={() => void reload()} />;
  const byId = new Map(items.map((c) => [c.id, c]));
  return (
    <section className="staff-card">
      <PanelHead
        title={t("website.catalog.categories")}
        count={items.length}
        intro={t("website.catalog.categoriesIntro")}
      />
      {items.length === 0 ? (
        <p className="staff-empty">{t("website.catalog.noCategories")}</p>
      ) : null}
      {items.map((item) => (
        <div
          key={item.id}
          className="website-site-item"
          data-testid={`website-category-${item.slug}`}
        >
          <div className="button-row">
            <strong>
              {item.parentId ? `${byId.get(item.parentId)?.name ?? "…"} › ` : ""}
              {item.name}
            </strong>
            <span className="muted">
              {t("website.catalog.productCount", { count: item.productCount })}
            </span>
            {item.sizeGuide ? (
              <span className="pill pill--good">{t("website.catalog.sizeGuide")}</span>
            ) : null}
            {item.image ? <span className="pill">{t("website.catalog.hasImage")}</span> : null}
            <button
              type="button"
              className="button button--quiet"
              data-testid={`website-category-edit-${item.slug}`}
              onClick={() => setOpenId(openId === item.id ? null : item.id)}
            >
              {openId === item.id ? t("website.catalog.close") : t("website.edit")}
            </button>
          </div>
          {openId === item.id ? (
            <CategoryEditor client={client} category={item} onSaved={() => void reload()} />
          ) : null}
        </div>
      ))}
    </section>
  );
}

function CategoryEditor({
  client,
  category,
  onSaved,
}: {
  client: CatalogClient;
  category: CategorySummary;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(category.name);
  const [slug, setSlug] = useState(category.slug);
  const [description, setDescription] = useState(category.description ?? "");
  const [position, setPosition] = useState(String(category.position));
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      toast.success(t("website.catalog.saved"));
      onSaved();
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const pos = Number(position);
    if (!name.trim()) return setFieldError(t("website.catalog.nameRequired"));
    if (!SLUG.test(slug.trim())) return setFieldError(t("website.catalog.slugFormat"));
    if (!Number.isInteger(pos) || pos < 0 || pos > 1000)
      return setFieldError(t("website.catalog.positionFormat"));
    setFieldError(null);
    void act(() =>
      client.updateCategory({
        categoryId: category.id,
        parentId: category.parentId,
        name: name.trim(),
        slug: slug.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        position: pos,
        idempotencyKey: newKey(),
      }),
    );
  }

  return (
    <div className="settings-grid">
      <label className="field">
        {t("website.catalog.name")}
        <input
          value={name}
          disabled={busy}
          data-testid="website-category-name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        {t("website.catalog.slug")}
        <input
          value={slug}
          disabled={busy}
          data-testid="website-category-slug"
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
        />
        <small className="muted">{t("website.catalog.slugHint")}</small>
      </label>
      <label className="field settings-grid__wide">
        {t("website.catalog.description")}
        <textarea
          rows={2}
          value={description}
          disabled={busy}
          data-testid="website-category-description"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        {t("website.catalog.position")}
        <input
          value={position}
          inputMode="numeric"
          disabled={busy}
          data-testid="website-category-position"
          onChange={(e) => setPosition(e.target.value)}
        />
        <small className="muted">{t("website.catalog.positionHint")}</small>
      </label>
      {fieldError ? (
        <span className="website-field-error settings-grid__wide" role="alert">
          {fieldError}
        </span>
      ) : null}
      <div className="button-row settings-grid__wide">
        <button
          type="button"
          className="button button--complete"
          disabled={busy}
          data-testid="website-category-save"
          onClick={save}
        >
          {t("website.saveChanges")}
        </button>
      </div>
      <CatalogImagePicker
        client={client}
        label={t("website.catalog.image")}
        hint={t("website.catalog.imageHint")}
        image={category.image}
        testId="website-category-image"
        onSave={async (image) => {
          await client.setCategoryImage({
            categoryId: category.id,
            image,
            idempotencyKey: newKey(),
          });
          toast.success(t("website.catalog.saved"));
          onSaved();
        }}
      />
      <SizeGuideEditor
        guide={category.sizeGuide ?? null}
        busy={busy}
        onSave={(sizeGuide) =>
          void act(() =>
            client.setCategorySizeGuide({
              categoryId: category.id,
              sizeGuide,
              idempotencyKey: newKey(),
            }),
          )
        }
      />
    </div>
  );
}

interface GuideDraft {
  title: string;
  unit: "cm" | "in";
  columns: string;
  rows: { size: string; values: string }[];
  note: string;
}

const toDraft = (guide: SizeGuide | null): GuideDraft =>
  guide
    ? {
        title: guide.title ?? "",
        unit: guide.unit,
        columns: guide.columns.join(", "),
        rows: guide.rows.map((r) => ({ size: r.size, values: r.values.join(", ") })),
        note: guide.note ?? "",
      }
    : {
        title: "",
        unit: "cm",
        columns: "Chest, Length",
        rows: [{ size: "M", values: "" }],
        note: "",
      };

/** Size chart: columns and each size's values as comma-separated lists (one value per column). */
function SizeGuideEditor({
  guide,
  busy,
  onSave,
}: {
  guide: SizeGuide | null;
  busy: boolean;
  onSave: (guide: SizeGuide | null) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<GuideDraft>(() => toDraft(guide));
  const [error, setError] = useState<string | null>(null);
  const split = (v: string) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  function save() {
    const columns = split(draft.columns);
    const rows = draft.rows
      .filter((r) => r.size.trim())
      .map((r) => ({ size: r.size.trim(), values: split(r.values) }));
    if (columns.length < 1 || columns.length > 8) return setError(t("website.guide.columnsError"));
    if (rows.length < 1 || rows.some((r) => r.values.length !== columns.length))
      return setError(t("website.guide.rowsError", { count: columns.length }));
    setError(null);
    onSave({
      title: draft.title.trim() || null,
      unit: draft.unit,
      columns,
      rows,
      note: draft.note.trim() || null,
    });
  }

  return (
    <div className="field settings-grid__wide website-site-list" data-testid="website-size-guide">
      <strong>{t("website.catalog.sizeGuide")}</strong>
      <small className="muted">{t("website.guide.hint")}</small>
      <div className="settings-grid">
        <label className="field">
          {t("website.guide.title")}
          <input
            value={draft.title}
            data-testid="website-guide-title"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label className="field">
          {t("website.guide.unit")}
          <select
            value={draft.unit}
            data-testid="website-guide-unit"
            onChange={(e) => setDraft({ ...draft, unit: e.target.value as "cm" | "in" })}
          >
            <option value="cm">cm</option>
            <option value="in">in</option>
          </select>
        </label>
        <label className="field settings-grid__wide">
          {t("website.guide.columns")}
          <input
            value={draft.columns}
            data-testid="website-guide-columns"
            onChange={(e) => setDraft({ ...draft, columns: e.target.value })}
          />
        </label>
      </div>
      {draft.rows.map((row, index) => (
        <div className="button-row" key={index}>
          <input
            aria-label={t("website.guide.size")}
            placeholder={t("website.guide.size")}
            value={row.size}
            data-testid={`website-guide-size-${index}`}
            onChange={(e) =>
              setDraft({
                ...draft,
                rows: draft.rows.map((r, i) => (i === index ? { ...r, size: e.target.value } : r)),
              })
            }
          />
          <input
            aria-label={t("website.guide.values")}
            placeholder={t("website.guide.values")}
            value={row.values}
            data-testid={`website-guide-values-${index}`}
            onChange={(e) =>
              setDraft({
                ...draft,
                rows: draft.rows.map((r, i) =>
                  i === index ? { ...r, values: e.target.value } : r,
                ),
              })
            }
          />
          <button
            type="button"
            className="link link--danger"
            onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, i) => i !== index) })}
          >
            {t("website.siteText.remove")}
          </button>
        </div>
      ))}
      <label className="field">
        {t("website.guide.note")}
        <input
          value={draft.note}
          data-testid="website-guide-note"
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
      </label>
      {error ? (
        <span className="website-field-error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="button-row">
        <button
          type="button"
          className="button button--quiet"
          disabled={draft.rows.length >= 30}
          data-testid="website-guide-add-row"
          onClick={() => setDraft({ ...draft, rows: [...draft.rows, { size: "", values: "" }] })}
        >
          {t("website.guide.addSize")}
        </button>
        <button
          type="button"
          className="button button--complete"
          disabled={busy}
          data-testid="website-guide-save"
          onClick={save}
        >
          {t("website.guide.save")}
        </button>
        {guide ? (
          <button
            type="button"
            className="link link--danger"
            disabled={busy}
            data-testid="website-guide-remove"
            onClick={() => onSave(null)}
          >
            {t("website.guide.remove")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Brands ──────────────────────────────────────────────────────────────────────────────────────
function BrandsSection({ client }: { client: CatalogClient }) {
  const { t } = useI18n();
  const toast = useToast();
  const load = useCallback(async () => (await client.listVendors()).vendors, [client]);
  const { items, error, reload } = useList<VendorSummary>(load);
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      toast.success(t("website.catalog.saved"));
      await reload();
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!items) return <ListState error={error} onRetry={() => void reload()} />;
  return (
    <section className="staff-card">
      <PanelHead
        title={t("website.catalog.brands")}
        count={items.length}
        intro={t("website.catalog.brandsIntro")}
      />
      <div className="button-row">
        <input
          aria-label={t("website.catalog.newBrand")}
          placeholder={t("website.catalog.newBrand")}
          value={newName}
          disabled={busy}
          data-testid="website-brand-new"
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className="button button--complete"
          disabled={busy || !slugify(newName)}
          data-testid="website-brand-add"
          onClick={() =>
            void act(async () => {
              await client.createVendor({
                name: newName.trim(),
                slug: slugify(newName),
                idempotencyKey: newKey(),
              });
              setNewName("");
            })
          }
        >
          {t("website.catalog.addBrand")}
        </button>
      </div>
      {items.map((vendor) => {
        const draft = drafts[vendor.id] ?? vendor.name;
        return (
          <div key={vendor.id} className="button-row" data-testid={`website-brand-${vendor.slug}`}>
            <input
              aria-label={t("website.catalog.name")}
              value={draft}
              disabled={busy}
              data-testid={`website-brand-name-${vendor.slug}`}
              onChange={(e) => setDrafts({ ...drafts, [vendor.id]: e.target.value })}
            />
            <span className="muted">
              {t("website.catalog.productCount", { count: vendor.productCount })}
            </span>
            <span className={`pill${vendor.status === "active" ? " pill--good" : ""}`}>
              {t(`website.catalog.status.${vendor.status}`)}
            </span>
            {draft.trim() && draft.trim() !== vendor.name ? (
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                data-testid={`website-brand-save-${vendor.slug}`}
                onClick={() =>
                  void act(() =>
                    client.updateVendor({
                      vendorId: vendor.id,
                      name: draft.trim(),
                      slug: vendor.slug,
                      position: vendor.position,
                      idempotencyKey: newKey(),
                    }),
                  )
                }
              >
                {t("website.saveChanges")}
              </button>
            ) : null}
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              data-testid={`website-brand-status-${vendor.slug}`}
              onClick={() =>
                void act(() =>
                  client.setVendorStatus({
                    vendorId: vendor.id,
                    status: vendor.status === "active" ? "archived" : "active",
                    idempotencyKey: newKey(),
                  }),
                )
              }
            >
              {vendor.status === "active" ? t("website.catalog.hide") : t("website.catalog.show")}
            </button>
          </div>
        );
      })}
    </section>
  );
}
