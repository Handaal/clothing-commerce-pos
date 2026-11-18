import type {
  MeContextResponse,
  PromotionDetail,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";
import { ConfirmDialog } from "./ConfirmDialog";
import type { FieldError } from "./content-form";
import { describeWebsiteError } from "./errors";
import { CodeLimitFields, restrictionOptions } from "./PromotionEditor";
import {
  codeLimit,
  normalizePromotionCode,
  promotionEffectiveState,
  promotionTargetLabel,
  type PromotionLimitKind,
} from "./promotion-form";
import { formatPercentBasisPoints } from "./sale-form";

export type PromotionDetailClient = Pick<
  TenantCommerceClient,
  | "getPromotion"
  | "setPromotionStatus"
  | "createPromotionCode"
  | "setPromotionCodeStatus"
  | "deletePromotion"
>;

const STATE_TONE: Record<string, string> = {
  active: "pill--good",
  scheduled: "pill--warn",
  expired: "",
  exhausted: "pill--warn",
  inactive: "",
};

/** "10% off", "EGP 50.00 off", "Buy 2 get 1". */
export function usePromotionBenefitLabel() {
  const { t, locale } = useI18n();
  return useCallback(
    (promotion: PromotionDetail) => {
      if (promotion.benefitType === "buy_x_get_y") {
        return promotion.buyQuantity && promotion.getQuantity
          ? t("website.promo.bxgy", { buy: promotion.buyQuantity, get: promotion.getQuantity })
          : t("website.promo.benefit.buy_x_get_y");
      }
      if (promotion.benefitType === "percentage") {
        return t("website.sales.percentOff", {
          percent: formatPercentBasisPoints(promotion.benefitPercentBp ?? 0),
        });
      }
      return t("website.promo.amountOff", {
        amount: formatMoney(
          promotion.benefitAmountMinor ?? 0,
          promotion.benefitCurrency ?? "",
          locale,
        ),
      });
    },
    [locale, t],
  );
}

// Promotion detail (Admin Mobile's Promotion detail screen): every setting, live state, usage, and the
// promotion's codes — list them, add another code, or disable one. A promotions manager can also edit,
// pause/resume and delete it here; pausing, deleting and disabling a code ask for confirmation. Delete
// removes a never-used promotion and archives a used one (the server decides; past orders keep it).
export function PromotionDetailDialog({
  client,
  context,
  promotionId,
  canManage,
  onEdit,
  onChanged,
  onDeleted,
  onClose,
}: {
  client: PromotionDetailClient;
  context: Pick<MeContextResponse, "access"> | null;
  promotionId: string;
  canManage: boolean;
  onEdit: (promotion: PromotionDetail) => void;
  onChanged: (promotion: PromotionDetail) => void;
  onDeleted: (outcome: "deleted" | "archived") => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const ref = useModalA11y<HTMLDivElement>(onClose);
  const benefitLabel = usePromotionBenefitLabel();
  const [promotion, setPromotion] = useState<PromotionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "pause" }
    | { kind: "delete" }
    | { kind: "disableCode"; codeId: string; code: string }
    | null
  >(null);
  const [newCode, setNewCode] = useState("");
  const [limitKind, setLimitKind] = useState<PromotionLimitKind>("unlimited");
  const [customLimit, setCustomLimit] = useState("");
  const [codeError, setCodeError] = useState<FieldError | null>(null);
  const [limitError, setLimitError] = useState<FieldError | undefined>(undefined);
  const { brands, branches } = useMemo(() => restrictionOptions(context), [context]);

  const load = useCallback(async () => {
    setError(null);
    setPromotion(null);
    try {
      setPromotion(await client.getPromotion(promotionId));
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, promotionId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const apply = (next: PromotionDetail) => {
    setPromotion(next);
    onChanged(next);
  };

  const run = async (action: () => Promise<PromotionDetail>, done: string) => {
    setBusy(true);
    try {
      apply(await action());
      toast.success(done);
      return true;
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: PromotionDetail["status"]) => {
    if (!promotion) return;
    const ok = await run(
      () =>
        client.setPromotionStatus({
          promotionId: promotion.id,
          status,
          idempotencyKey: crypto.randomUUID(),
        }),
      status === "active"
        ? t("website.promo.activated", { name: promotion.name })
        : t("website.promo.deactivated", { name: promotion.name }),
    );
    if (ok) setConfirm(null);
  };

  const remove = async () => {
    if (!promotion) return;
    setBusy(true);
    try {
      const result = await client.deletePromotion(promotion.id);
      toast.success(
        result.outcome === "archived"
          ? t("website.promo.archivedToast", { name: promotion.name })
          : t("website.promo.deletedToast", { name: promotion.name }),
      );
      setConfirm(null);
      onDeleted(result.outcome);
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const disableCode = async (codeId: string, code: string) => {
    const ok = await run(
      () =>
        client.setPromotionCodeStatus({
          codeId,
          status: "disabled",
          idempotencyKey: crypto.randomUUID(),
        }),
      t("website.promo.codeDisabled", { code }),
    );
    if (ok) setConfirm(null);
  };

  const addCode = async () => {
    if (!promotion) return;
    const code = normalizePromotionCode(newCode);
    const limit = codeLimit(limitKind, customLimit);
    const badCode = typeof code !== "string" ? code : null;
    const badLimit = limit !== null && typeof limit !== "number" ? limit : undefined;
    setCodeError(badCode);
    setLimitError(badLimit);
    if (badCode || badLimit) return;
    const ok = await run(
      () =>
        client.createPromotionCode({
          promotionId: promotion.id,
          code: code as string,
          maxRedemptions: limit as number | null,
          idempotencyKey: crypto.randomUUID(),
        }),
      t("website.promo.codeAdded", { code: code as string }),
    );
    if (ok) {
      setNewCode("");
      setLimitKind("unlimited");
      setCustomLimit("");
    }
  };

  const money = (minor: number | null) =>
    minor === null
      ? t("website.promo.none")
      : formatMoney(minor, promotion?.benefitCurrency ?? "", locale);
  const date = (value: string | null) =>
    value ? formatDateTime(value, locale) : t("website.promo.noLimit");
  const nameOf = (options: { value: string; label: string }[], id: string | null, all: string) =>
    id === null
      ? all
      : (options.find((item) => item.value === id)?.label ?? t("website.promo.restricted"));

  const state = promotion ? promotionEffectiveState(promotion) : null;

  return (
    <>
      <div className="staff-modal__scrim" role="presentation" onClick={busy ? undefined : onClose}>
        <div
          className="staff-modal settings-modal website-promo-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby="website-promo-detail-title"
          ref={ref}
          data-testid="website-promo-detail"
          onClick={(event) => event.stopPropagation()}
        >
          <h3 id="website-promo-detail-title">
            {promotion?.name ?? t("website.promo.detailTitle")}
          </h3>
          {error ? (
            <div className="notice notice--error" role="alert">
              <span>{error}</span>
              <button className="button button--quiet" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : !promotion || !state ? (
            <SkeletonLines lines={5} label={t("website.promo.loadingDetail")} />
          ) : (
            <>
              <div className="website-promo-headline">
                <span className={`pill ${STATE_TONE[state]}`} data-testid="website-promo-state">
                  {t(`website.promo.state.${state}`)}
                </span>
                <strong>{benefitLabel(promotion)}</strong>
                <span className="muted">
                  {t(`website.promo.activation.${promotion.activationType}`)}
                </span>
              </div>
              {canManage ? (
                <div className="website-row-actions">
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    data-testid="website-promo-edit"
                    onClick={() => onEdit(promotion)}
                  >
                    {t("website.promo.edit")}
                  </button>
                  {promotion.status === "active" ? (
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: "pause" })}
                    >
                      {t("website.promo.deactivate")}
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void setStatus("active")}
                    >
                      {t("website.promo.activate")}
                    </button>
                  )}
                  <button
                    className="button button--danger"
                    disabled={busy}
                    data-testid="website-promo-delete"
                    onClick={() => setConfirm({ kind: "delete" })}
                  >
                    {t("website.promo.delete")}
                  </button>
                </div>
              ) : (
                <p className="notice" role="status">
                  {t("website.readOnly")}
                </p>
              )}

              <dl className="order-kv website-promo-kv">
                {promotion.description ? (
                  <Row label={t("website.promo.description")}>{promotion.description}</Row>
                ) : null}
                <Row label={t("website.promo.channel")}>
                  {t(`website.promo.channel.${promotion.channel ?? "all"}`)}
                </Row>
                <Row label={t("website.promo.target")}>
                  {t(`website.promo.target.${promotion.targetType}`)}
                  {promotion.targetType === "variant_scope" ? (
                    <ul className="website-promo-targets" data-testid="website-promo-target-list">
                      {promotion.targets.map((target) => (
                        <li key={target.productId ?? target.variantId}>
                          <small className="muted">
                            {target.productId
                              ? t("website.promo.targetProduct")
                              : t("website.promo.targetVariant")}
                          </small>{" "}
                          {promotionTargetLabel(target)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Row>
                <Row label={t("website.promo.minSubtotalShort")}>
                  {money(promotion.minSubtotalMinor)}
                </Row>
                <Row label={t("website.promo.maxDiscountShort")}>
                  {money(promotion.maxDiscountMinor)}
                </Row>
                <Row label={t("website.promo.brand")}>
                  {nameOf(brands, promotion.brandId, t("website.promo.allBrands"))}
                </Row>
                <Row label={t("website.promo.branch")}>
                  {nameOf(branches, promotion.branchId, t("website.promo.allBranches"))}
                </Row>
                <Row label={t("website.promo.redemptions")}>
                  {promotion.globalRedemptionLimit === null
                    ? promotion.redemptionCount
                    : `${promotion.redemptionCount} / ${promotion.globalRedemptionLimit}`}
                </Row>
                <Row label={t("website.promo.remaining")}>
                  {promotion.remainingRedemptions === null
                    ? t("website.promo.unlimited")
                    : promotion.remainingRedemptions}
                </Row>
                <Row label={t("website.sales.startsAt")}>{date(promotion.startsAt)}</Row>
                <Row label={t("website.sales.endsAt")}>{date(promotion.endsAt)}</Row>
              </dl>

              <h4>{t("website.promo.codes")}</h4>
              {promotion.activationType !== "code" ? (
                <p className="muted">{t("website.promo.automaticNoCode")}</p>
              ) : (
                <>
                  {promotion.codes.length === 0 ? (
                    <p className="staff-empty">{t("website.promo.noCodes")}</p>
                  ) : (
                    <div className="staff-table-wrap">
                      <table className="staff-table">
                        <thead>
                          <tr>
                            <th>{t("website.promo.code")}</th>
                            <th>{t("website.promo.codeUse")}</th>
                            <th>{t("website.promo.redemptions")}</th>
                            <th>{t("website.sales.state")}</th>
                            {canManage ? <th className="end">{t("website.actions")}</th> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {promotion.codes.map((code) => (
                            <tr key={code.id} data-testid={`website-promo-code-${code.id}`}>
                              <td>
                                <strong>{code.code}</strong>
                              </td>
                              <td>
                                {code.maxRedemptions === null
                                  ? t("website.promo.codeUnlimited")
                                  : code.maxRedemptions === 1
                                    ? t("website.promo.codeSingle")
                                    : t("website.promo.codeCapped", { count: code.maxRedemptions })}
                              </td>
                              <td>
                                {code.redemptionCount}
                                {code.remainingRedemptions !== null
                                  ? ` · ${t("website.promo.left", { count: code.remainingRedemptions })}`
                                  : ""}
                              </td>
                              <td>
                                <span
                                  className={`pill${code.status === "active" ? " pill--good" : ""}`}
                                >
                                  {t(`website.promo.code.${code.status}`)}
                                </span>
                              </td>
                              {canManage ? (
                                <td className="end">
                                  {code.status === "active" ? (
                                    <button
                                      className="link link--danger"
                                      disabled={busy}
                                      onClick={() =>
                                        setConfirm({
                                          kind: "disableCode",
                                          codeId: code.id,
                                          code: code.code,
                                        })
                                      }
                                    >
                                      {t("website.promo.disableCode")}
                                    </button>
                                  ) : null}
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {canManage ? (
                    <div className="settings-grid website-promo-addcode">
                      <label className="field">
                        {t("website.promo.newCode")}
                        <input
                          value={newCode}
                          disabled={busy}
                          placeholder="WELCOME10"
                          data-testid="website-promo-new-code"
                          onChange={(event) => {
                            setNewCode(event.target.value.toUpperCase());
                            setCodeError(null);
                          }}
                        />
                        {codeError ? (
                          <span className="website-field-error" role="alert">
                            {t(codeError.key, codeError.vars)}
                          </span>
                        ) : null}
                      </label>
                      <CodeLimitFields
                        kind={limitKind}
                        custom={customLimit}
                        disabled={busy}
                        error={limitError}
                        onKind={setLimitKind}
                        onCustom={(value) => {
                          setCustomLimit(value);
                          setLimitError(undefined);
                        }}
                      />
                      <div className="field">
                        <button
                          className="button"
                          disabled={busy}
                          data-testid="website-promo-add-code"
                          onClick={() => void addCode()}
                        >
                          {t("website.promo.addCode")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
          <div className="staff-modal__actions">
            <button className="button button--quiet" onClick={onClose} disabled={busy}>
              {t("website.close")}
            </button>
          </div>
        </div>
      </div>

      {confirm && promotion ? (
        confirm.kind === "delete" ? (
          <ConfirmDialog
            title={t("website.promo.deleteTitle")}
            message={t(
              promotion.redemptionCount > 0
                ? "website.promo.deleteUsedMessage"
                : "website.promo.deleteMessage",
              { name: promotion.name },
            )}
            confirmLabel={t("website.promo.delete")}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void remove()}
          />
        ) : confirm.kind === "pause" ? (
          <ConfirmDialog
            title={t("website.promo.pauseTitle")}
            message={t("website.promo.pauseMessage", { name: promotion.name })}
            confirmLabel={t("website.promo.deactivate")}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void setStatus("inactive")}
          />
        ) : (
          <ConfirmDialog
            title={t("website.promo.disableCodeTitle")}
            message={t("website.promo.disableCodeMessage", { code: confirm.code })}
            confirmLabel={t("website.promo.disableCode")}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void disableCode(confirm.codeId, confirm.code)}
          />
        )
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
