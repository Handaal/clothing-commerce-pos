import type {
  MeContextResponse,
  PromotionDetail,
  PromotionSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { loadAllPromotions } from "./access";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeWebsiteError } from "./errors";
import { PromotionDetailDialog } from "./PromotionDetailDialog";
import { PromotionEditor } from "./PromotionEditor";

export type PromotionsClient = Pick<
  TenantCommerceClient,
  | "listPromotions"
  | "getPromotion"
  | "createPromotion"
  | "updatePromotion"
  | "setPromotionStatus"
  | "createPromotionCode"
  | "setPromotionCodeStatus"
  | "deletePromotion"
  | "listProducts"
  | "getProduct"
>;

// Promotions — the POS counterpart of Admin Mobile's Promotions section: list every promotion (automatic
// and code, any channel), open its detail (settings, usage, codes), create and edit promotions of every
// kind (percentage, fixed amount, buy-X-get-Y; whole order or chosen products/variants), add or disable
// codes, pause/resume, and delete (a used promotion is archived instead so past orders keep it). Reading
// needs promotions.read; every change needs promotions.manage (the API enforces both). Vouchers stays as
// the quick single-code shortcut for the till.
export function PromotionsPanel({
  client,
  canManage,
  catalogRead = false,
  context = null,
  onOpenVouchers,
}: {
  client: PromotionsClient;
  canManage: boolean;
  /** Needed to pick product/variant targets. */
  catalogRead?: boolean;
  /** `/me/context`, for the brand/branch restriction choices. */
  context?: Pick<MeContextResponse, "access"> | null;
  onOpenVouchers?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<PromotionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ promotion: PromotionDetail | null } | null>(null);
  const [pausing, setPausing] = useState<PromotionSummary | null>(null);
  const [deleting, setDeleting] = useState<PromotionSummary | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await loadAllPromotions(client));
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

  const toggle = async (promotion: PromotionSummary) => {
    setBusyId(promotion.id);
    try {
      const next = await client.setPromotionStatus({
        promotionId: promotion.id,
        status: promotion.status === "active" ? "inactive" : "active",
        idempotencyKey: crypto.randomUUID(),
      });
      setItems(
        (current) =>
          current?.map((item) =>
            item.id === promotion.id ? { ...item, status: next.status } : item,
          ) ?? null,
      );
      toast.success(
        next.status === "active"
          ? t("website.promo.activated", { name: promotion.name })
          : t("website.promo.deactivated", { name: promotion.name }),
      );
      setPausing(null);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (promotion: PromotionSummary) => {
    setBusyId(promotion.id);
    try {
      const result = await client.deletePromotion(promotion.id);
      setItems((current) => current?.filter((item) => item.id !== promotion.id) ?? null);
      toast.success(
        result.outcome === "archived"
          ? t("website.promo.archivedToast", { name: promotion.name })
          : t("website.promo.deletedToast", { name: promotion.name }),
      );
      setDeleting(null);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = async (id: string) => {
    setBusyId(id);
    try {
      setEditing({ promotion: await client.getPromotion(id) });
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const closeDetail = () => {
    setViewing(null);
    if (changed) {
      setChanged(false);
      void load();
    }
  };

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            {t("website.tab.promotions")}
            {items ? <span className="muted"> · {items.length}</span> : null}
          </h2>
          <div className="staff-filters">
            {onOpenVouchers ? (
              <button className="button button--quiet" onClick={onOpenVouchers}>
                {t("website.promo.openVouchers")}
              </button>
            ) : null}
            {canManage ? (
              <button
                className="button"
                data-testid="website-promo-new"
                onClick={() => setEditing({ promotion: null })}
              >
                {t("website.promo.new")}
              </button>
            ) : null}
          </div>
        </div>
        <p className="muted website-card-intro">{t("website.promo.intro")}</p>
        {!canManage ? (
          <p className="notice website-card-intro" role="status">
            {t("website.readOnly")}
          </p>
        ) : null}
        {loading ? <SkeletonLines lines={4} label={t("website.promo.loading")} /> : null}
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button className="button button--quiet" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : null}
        {!loading && !error && items?.length === 0 ? (
          <p className="staff-empty">{t("website.promo.empty")}</p>
        ) : null}
        {!loading && !error && items && items.length > 0 ? (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("website.promo.name")}</th>
                  <th>{t("website.promo.activation")}</th>
                  <th>{t("website.promo.benefit")}</th>
                  <th>{t("website.promo.channel")}</th>
                  <th>{t("website.promo.redemptions")}</th>
                  <th>{t("website.sales.state")}</th>
                  <th className="end">{t("website.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} data-testid={`website-promo-${item.id}`}>
                    <td>{item.name}</td>
                    <td>{t(`website.promo.activation.${item.activationType}`)}</td>
                    <td>{t(`website.promo.benefit.${item.benefitType}`)}</td>
                    <td>{t(`website.promo.channel.${item.channel ?? "all"}`)}</td>
                    <td>
                      {item.globalRedemptionLimit === null
                        ? item.redemptionCount
                        : `${item.redemptionCount} / ${item.globalRedemptionLimit}`}
                    </td>
                    <td>
                      <span className={`pill${item.status === "active" ? " pill--good" : ""}`}>
                        {item.status === "active"
                          ? t("website.promo.active")
                          : t("website.promo.inactive")}
                      </span>
                    </td>
                    <td className="end website-row-actions">
                      <button
                        className="link"
                        disabled={busyId !== null}
                        onClick={() => setViewing(item.id)}
                      >
                        {t("website.promo.details")}
                      </button>
                      {canManage ? (
                        <>
                          <button
                            className="link"
                            disabled={busyId !== null}
                            onClick={() => void openEdit(item.id)}
                          >
                            {t("website.promo.edit")}
                          </button>
                          <button
                            className="link"
                            disabled={busyId !== null}
                            onClick={() =>
                              item.status === "active" ? setPausing(item) : void toggle(item)
                            }
                          >
                            {item.status === "active"
                              ? t("website.promo.deactivate")
                              : t("website.promo.activate")}
                          </button>
                          <button
                            className="link link--danger"
                            disabled={busyId !== null}
                            onClick={() => setDeleting(item)}
                          >
                            {t("website.promo.delete")}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {viewing ? (
        <PromotionDetailDialog
          client={client}
          context={context}
          promotionId={viewing}
          canManage={canManage}
          onChanged={() => setChanged(true)}
          onDeleted={() => {
            setViewing(null);
            setChanged(false);
            void load();
          }}
          onEdit={(promotion) => {
            setViewing(null);
            setEditing({ promotion });
          }}
          onClose={closeDetail}
        />
      ) : null}

      {editing ? (
        <PromotionEditor
          client={client}
          context={context}
          catalogRead={catalogRead}
          promotion={editing.promotion}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setChanged(false);
            void load();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={t("website.promo.deleteTitle")}
          message={t(
            deleting.redemptionCount > 0
              ? "website.promo.deleteUsedMessage"
              : "website.promo.deleteMessage",
            { name: deleting.name },
          )}
          confirmLabel={t("website.promo.delete")}
          busy={busyId === deleting.id}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      ) : null}

      {pausing ? (
        <ConfirmDialog
          title={t("website.promo.pauseTitle")}
          message={t("website.promo.pauseMessage", { name: pausing.name })}
          confirmLabel={t("website.promo.deactivate")}
          busy={busyId === pausing.id}
          onCancel={() => setPausing(null)}
          onConfirm={() => void toggle(pausing)}
        />
      ) : null}
    </>
  );
}
