import type { ProductMediaItem, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { loadAllProducts, type ProductItem } from "./access";
import { describeWebsiteError } from "./errors";
import { uploadErrorKey, uploadImage } from "./image-upload";
import { PanelHead } from "./PanelHead";

export type PhotosClient = Pick<
  TenantCommerceClient,
  | "listProducts"
  | "listProductMedia"
  | "createProductMediaUploadIntent"
  | "registerProductMedia"
  | "updateProductMedia"
  | "reorderProductMedia"
  | "archiveProductMedia"
>;

const newKey = () => crypto.randomUUID();

// Product photos (SDK 0.53, parity with Admin Mobile): pick a product, then add photos, describe them,
// choose the main photo, change the order and remove photos. The first photo is the main one on the
// website. Authorized by catalog.author for the product's brand on the server.
export function PhotosPanel({
  client,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: {
  client: PhotosClient;
  fetchImpl?: typeof globalThis.fetch;
}) {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProducts(await loadAllProducts(client));
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => p.status !== "archived")
      .filter(
        (p) =>
          !q || p.name.toLowerCase().includes(q) || (p.styleCode ?? "").toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [products, query]);

  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!products) return <SkeletonLines lines={4} label={t("website.loadingProducts")} />;
  const selected = products.find((p) => p.id === productId) ?? null;

  return (
    <>
      <p className="notice website-desk-intro">{t("website.photos.intro")}</p>
      <section className="staff-card">
        <PanelHead title={t("website.photos.pickProduct")} />
        <input
          aria-label={t("website.search")}
          placeholder={t("website.search")}
          value={query}
          data-testid="website-photos-search"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="website-cards">
          {visible.map((p) => (
            <button
              key={p.id}
              className={`website-card${p.id === productId ? " report-tab--active" : ""}`}
              data-testid={`website-photos-product-${p.id}`}
              onClick={() => setProductId(p.id)}
            >
              <strong>{p.name}</strong>
              <span className="muted">{p.styleCode ?? ""}</span>
            </button>
          ))}
        </div>
      </section>
      {selected ? (
        <ProductPhotos key={selected.id} client={client} product={selected} fetchImpl={fetchImpl} />
      ) : null}
    </>
  );
}

function ProductPhotos({
  client,
  product,
  fetchImpl,
}: {
  client: PhotosClient;
  product: ProductItem;
  fetchImpl: typeof globalThis.fetch;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [photos, setPhotos] = useState<ProductMediaItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPhotos((await client.listProductMedia(product.id)).media);
      setDrafts({});
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, product.id, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  async function act(work: () => Promise<unknown>, success = t("website.photos.saved")) {
    setBusy(true);
    setError(null);
    try {
      await work();
      toast.success(success);
      await load();
    } catch (err) {
      const key = uploadErrorKey(err);
      setError(key ? t(key) : describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, delta: number) {
    if (!photos) return;
    const order = photos.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    void act(() =>
      client.reorderProductMedia({
        productId: product.id,
        mediaIds: order,
        idempotencyKey: newKey(),
      }),
    );
  }

  return (
    <section className="staff-card" data-testid="website-photos-list">
      <PanelHead
        title={product.name}
        count={photos?.length ?? null}
        intro={t("website.photos.orderHint")}
      >
        <label className="button button--complete">
          {busy ? t("website.saving") : t("website.photos.add")}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            hidden
            disabled={busy}
            data-testid="website-photos-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void act(async () => {
                const saved = await uploadImage(
                  file,
                  (body) =>
                    client.createProductMediaUploadIntent({ productId: product.id, ...body }),
                  fetchImpl,
                );
                await client.registerProductMedia({
                  productId: product.id,
                  ...saved,
                  isPrimary: (photos?.length ?? 0) === 0,
                  idempotencyKey: newKey(),
                });
              }, t("website.photos.added"));
            }}
          />
        </label>
      </PanelHead>
      {error ? (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      ) : null}
      {photos === null ? (
        <SkeletonLines lines={3} label={t("website.photos.loading")} />
      ) : photos.length === 0 ? (
        <p className="staff-empty">{t("website.photos.none")}</p>
      ) : (
        photos.map((photo, index) => {
          const draft = drafts[photo.id] ?? photo.altText ?? "";
          return (
            <div
              className="website-site-item"
              key={photo.id}
              data-testid={`website-photo-${photo.id}`}
            >
              <div className="button-row">
                <strong>{t("website.photos.number", { n: index + 1 })}</strong>
                {photo.isPrimary ? (
                  <span className="pill pill--good">{t("website.photos.main")}</span>
                ) : null}
                <span className="muted">{photo.path}</span>
              </div>
              <label className="field">
                {t("website.home.imageAlt")}
                <input
                  value={draft}
                  disabled={busy}
                  data-testid={`website-photo-alt-${photo.id}`}
                  onChange={(e) => setDrafts({ ...drafts, [photo.id]: e.target.value })}
                />
              </label>
              <div className="button-row">
                {draft.trim() !== (photo.altText ?? "") ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={busy}
                    data-testid={`website-photo-alt-save-${photo.id}`}
                    onClick={() =>
                      void act(() =>
                        client.updateProductMedia({
                          productId: product.id,
                          mediaId: photo.id,
                          altText: draft.trim() || null,
                          idempotencyKey: newKey(),
                        }),
                      )
                    }
                  >
                    {t("website.img.saveAlt")}
                  </button>
                ) : null}
                {!photo.isPrimary ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={busy}
                    data-testid={`website-photo-main-${photo.id}`}
                    onClick={() =>
                      void act(() =>
                        client.updateProductMedia({
                          productId: product.id,
                          mediaId: photo.id,
                          isPrimary: true,
                          idempotencyKey: newKey(),
                        }),
                      )
                    }
                  >
                    {t("website.photos.makeMain")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy || index === 0}
                  data-testid={`website-photo-up-${photo.id}`}
                  onClick={() => move(index, -1)}
                >
                  {t("website.siteText.moveUp")}
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy || index === photos.length - 1}
                  data-testid={`website-photo-down-${photo.id}`}
                  onClick={() => move(index, 1)}
                >
                  {t("website.siteText.moveDown")}
                </button>
                <button
                  type="button"
                  className="link link--danger"
                  disabled={busy}
                  data-testid={`website-photo-remove-${photo.id}`}
                  onClick={() =>
                    void act(
                      () =>
                        client.archiveProductMedia({
                          productId: product.id,
                          mediaId: photo.id,
                          idempotencyKey: newKey(),
                        }),
                      t("website.photos.removed"),
                    )
                  }
                >
                  {t("website.siteText.remove")}
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
