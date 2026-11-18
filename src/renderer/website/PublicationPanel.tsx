import type { StorefrontStatus, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { loadAllProducts, type ProductItem } from "./access";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeWebsiteError } from "./errors";

export type PublicationClient = Pick<
  TenantCommerceClient,
  "listProducts" | "publishProduct" | "unpublishProduct"
>;

type StatusFilter = "" | ProductItem["status"];

// Storefront publication: put a product on the public website or take it off. Lifecycle (active/draft/
// archived) and publication are separate — an active product is not automatically online. The product
// list does not report publication state, so (as in Admin Mobile) the state is shown as observed this
// session after a publish/unpublish. The API enforces catalog write access and the publish rules (active
// product, an active variant, a current price).
export function PublicationPanel({ client }: { client: PublicationClient }) {
  const { t } = useI18n();
  const toast = useToast();
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [observed, setObserved] = useState<Record<string, StorefrontStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unpublishing, setUnpublishing] = useState<ProductItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProducts(await loadAllProducts(client));
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

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (products ?? []).filter(
      (item) =>
        (status === "" || item.status === status) &&
        (!term ||
          item.name.toLocaleLowerCase().includes(term) ||
          (item.styleCode ?? "").toLocaleLowerCase().includes(term)),
    );
  }, [products, query, status]);

  const publish = async (product: ProductItem) => {
    setBusyId(product.id);
    try {
      const result = await client.publishProduct({
        productId: product.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setObserved((current) => ({ ...current, [product.id]: result.storefrontStatus }));
      toast.success(t("website.pub.published", { name: product.name }));
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const unpublish = async () => {
    if (!unpublishing) return;
    const product = unpublishing;
    setBusyId(product.id);
    try {
      const result = await client.unpublishProduct({
        productId: product.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setObserved((current) => ({ ...current, [product.id]: result.storefrontStatus }));
      toast.success(t("website.pub.unpublished", { name: product.name }));
      setUnpublishing(null);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const websiteState = (id: string) => {
    const value = observed[id];
    if (!value) return <span className="muted">{t("website.pub.notObserved")}</span>;
    return value === "published" ? (
      <span className="pill pill--good">{t("website.pub.statePublished")}</span>
    ) : (
      <span className="pill">{t("website.pub.stateUnpublished")}</span>
    );
  };

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            {t("website.tab.publication")}
            {products ? <span className="muted"> · {visible.length}</span> : null}
          </h2>
          <div className="staff-filters">
            <label>
              {t("website.search")}
              <input
                type="search"
                value={query}
                placeholder={t("website.pub.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              {t("website.pub.lifecycle")}
              <Select<StatusFilter>
                ariaLabel={t("website.pub.lifecycle")}
                value={status}
                onChange={setStatus}
                options={[
                  { value: "", label: t("website.all") },
                  { value: "active", label: t("website.pub.status.active") },
                  { value: "draft", label: t("website.pub.status.draft") },
                  { value: "archived", label: t("website.pub.status.archived") },
                ]}
              />
            </label>
          </div>
        </div>
        <p className="muted website-card-intro">{t("website.pub.intro")}</p>
        {loading ? <SkeletonLines lines={5} label={t("website.loadingProducts")} /> : null}
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button className="button button--quiet" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : null}
        {!loading && !error && visible.length === 0 ? (
          <p className="staff-empty">
            {products?.length ? t("website.pub.noMatches") : t("website.pub.empty")}
          </p>
        ) : null}
        {!loading && !error && visible.length > 0 ? (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("website.pub.product")}</th>
                  <th>{t("website.pub.styleCode")}</th>
                  <th>{t("website.pub.lifecycle")}</th>
                  <th>{t("website.pub.website")}</th>
                  <th className="end">{t("website.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((product) => (
                  <tr key={product.id} data-testid={`website-product-${product.id}`}>
                    <td>{product.name}</td>
                    <td className="muted">{product.styleCode ?? "—"}</td>
                    <td>{t(`website.pub.status.${product.status}`)}</td>
                    <td>{websiteState(product.id)}</td>
                    <td className="end website-row-actions">
                      <button
                        className="link"
                        disabled={busyId !== null || product.status !== "active"}
                        title={
                          product.status !== "active" ? t("website.pub.needsActive") : undefined
                        }
                        onClick={() => void publish(product)}
                      >
                        {observed[product.id] === "published"
                          ? t("website.pub.publishAgain")
                          : t("website.pub.publish")}
                      </button>
                      <button
                        className="link link--danger"
                        disabled={busyId !== null || observed[product.id] === "unpublished"}
                        onClick={() => setUnpublishing(product)}
                      >
                        {t("website.pub.unpublish")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {unpublishing ? (
        <ConfirmDialog
          title={t("website.pub.unpublishTitle")}
          message={t("website.pub.unpublishMessage", { name: unpublishing.name })}
          confirmLabel={t("website.pub.unpublish")}
          busy={busyId === unpublishing.id}
          onCancel={() => setUnpublishing(null)}
          onConfirm={() => void unpublish()}
        />
      ) : null}
    </>
  );
}
