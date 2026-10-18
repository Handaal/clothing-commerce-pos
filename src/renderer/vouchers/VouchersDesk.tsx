import type { PromotionDetail, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { currencySymbol, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { formatDate } from "../format";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

// A "voucher" is a code-activated, order-targeted promotion with a single code. The promotions API is
// the backend; this page presents just the voucher-shaped subset of it.
type VoucherType = "percent" | "fixed";

type FormState = {
  promotionId?: string;
  code: string;
  type: VoucherType;
  value: string;
  minSubtotal: string;
  maxUses: string;
  expiresAt: string;
  active: boolean;
  economicsLocked: boolean;
};

const blankForm = (): FormState => ({
  code: "",
  type: "percent",
  value: "",
  minSubtotal: "",
  maxUses: "",
  expiresAt: "",
  active: true,
  economicsLocked: false,
});

// A promotion is only shown here when it is voucher-shaped: a single code, activated by code.
function voucherCode(detail: PromotionDetail): string | null {
  if (detail.activationType !== "code" || detail.codes.length === 0) return null;
  return detail.codes[0].code;
}

export function VouchersDesk({
  client,
  currency,
}: {
  client: TenantCommerceClient;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const [vouchers, setVouchers] = useState<PromotionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  const [detail, setDetail] = useState<PromotionDetail | null>(null);

  const sym = currencySymbol(currency, locale);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The list is summaries only; enrich each code promotion with its detail (code, benefit, limits).
      const summary = await client.listPromotions({ limit: 100 });
      const codePromotions = summary.items.filter((item) => item.activationType === "code");
      const details = await Promise.all(codePromotions.map((item) => client.getPromotion(item.id)));
      setVouchers(details.filter((d) => voucherCode(d) !== null));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(done);
        await load();
      } catch (err) {
        toast.error(classifyCommerceError(err).message);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [load, toast],
  );

  const openNew = () => setForm(blankForm());
  const openEdit = (v: PromotionDetail) => {
    const code = voucherCode(v) ?? "";
    setForm({
      promotionId: v.id,
      code,
      type: v.benefitType === "percentage" ? "percent" : "fixed",
      value:
        v.benefitType === "percentage"
          ? String((v.benefitPercentBp ?? 0) / 100)
          : minorToMajorInput(v.benefitAmountMinor ?? 0),
      minSubtotal: v.minSubtotalMinor ? minorToMajorInput(v.minSubtotalMinor) : "",
      maxUses: v.globalRedemptionLimit != null ? String(v.globalRedemptionLimit) : "",
      expiresAt: v.endsAt ? v.endsAt.slice(0, 10) : "",
      active: v.status === "active",
      economicsLocked: v.economicsLocked,
    });
  };

  // Build the benefit fields shared by create + edit. Percent is basis points; fixed is minor units.
  const benefitFields = (f: FormState) => {
    if (f.type === "percent") {
      const percent = Number(f.value);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
      return { benefitType: "percentage" as const, benefitPercentBp: Math.round(percent * 100) };
    }
    const minor = parseMajorToMinor(f.value);
    if (minor === null || minor <= 0) return null;
    return {
      benefitType: "fixed_amount" as const,
      benefitAmountMinor: minor,
      benefitCurrency: currency,
    };
  };

  const save = () => {
    if (!form) return;
    const benefit = benefitFields(form);
    if (!benefit) {
      toast.error(form.type === "percent" ? t("vouchers.err.percent") : t("vouchers.err.amount"));
      return;
    }
    const minSubtotalMinor =
      form.minSubtotal.trim() === "" ? null : parseMajorToMinor(form.minSubtotal);
    if (minSubtotalMinor === null && form.minSubtotal.trim() !== "") {
      toast.error(t("vouchers.err.minSubtotal"));
      return;
    }
    const endsAt = form.expiresAt ? `${form.expiresAt}T23:59:59.000Z` : null;

    if (form.promotionId) {
      // Edit: code and usage limit are fixed after creation; benefit is locked once redeemed. The update
      // contract takes only the benefit *value* (no type/currency change), so send that subset.
      const economicUpdate = form.economicsLocked
        ? {}
        : benefit.benefitType === "percentage"
          ? { benefitPercentBp: benefit.benefitPercentBp }
          : { benefitAmountMinor: benefit.benefitAmountMinor };
      void run(
        () =>
          client.updatePromotion({
            promotionId: form.promotionId!,
            idempotencyKey: crypto.randomUUID(),
            ...economicUpdate,
            minSubtotalMinor,
            endsAt,
          }),
        t("vouchers.ok.updated", { code: form.code }),
      ).then(
        () => setForm(null),
        () => undefined,
      );
      return;
    }

    const code = form.code.trim().toUpperCase();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      toast.error(t("vouchers.err.code"));
      return;
    }
    const maxUses = form.maxUses.trim() === "" ? null : Number(form.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
      toast.error(t("vouchers.err.maxUses"));
      return;
    }
    void run(
      () =>
        client.createPromotion({
          idempotencyKey: crypto.randomUUID(),
          name: code,
          targetType: "order",
          activationType: "code",
          ...benefit,
          minSubtotalMinor,
          endsAt,
          globalRedemptionLimit: maxUses,
          status: form.active ? "active" : "inactive",
          codes: [{ code }],
        }),
      t("vouchers.ok.created", { code }),
    ).then(
      () => setForm(null),
      () => undefined,
    );
  };

  const toggle = (v: PromotionDetail) =>
    void run(
      () =>
        client.setPromotionStatus({
          promotionId: v.id,
          status: v.status === "active" ? "inactive" : "active",
          idempotencyKey: crypto.randomUUID(),
        }),
      v.status === "active"
        ? t("vouchers.ok.deactivated", { code: voucherCode(v) ?? "" })
        : t("vouchers.ok.activated", { code: voucherCode(v) ?? "" }),
    ).catch(() => undefined);

  const describe = (v: PromotionDetail) =>
    v.benefitType === "percentage"
      ? `${(v.benefitPercentBp ?? 0) / 100}%`
      : formatMoney(v.benefitAmountMinor ?? 0, v.benefitCurrency ?? currency, locale);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("vouchers.promotions")}</p>
          <h1>{t("nav.vouchers")}</h1>
        </div>
        <div className="staff-filters">
          <button className="button button--quiet" onClick={() => void load()} disabled={busy}>
            {t("orders.refresh")}
          </button>
          <button className="button" onClick={openNew} disabled={busy}>
            {t("vouchers.new")}
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {loading ? (
        <SkeletonLines lines={5} label={t("vouchers.loading")} />
      ) : vouchers.length === 0 ? (
        <p className="staff-empty">{t("vouchers.none")}</p>
      ) : (
        <div className="voucher-grid">
          {vouchers.map((v) => {
            const code = voucherCode(v) ?? "—";
            const expired = !!v.endsAt && v.endsAt.slice(0, 10) < today;
            const exhausted =
              v.globalRedemptionLimit != null && v.redemptionCount >= v.globalRedemptionLimit;
            return (
              <article className="voucher-card" key={v.id}>
                <div className="voucher-card__head">
                  <div>
                    <strong className="voucher-code">{code}</strong>
                    <span className="voucher-benefit">
                      {t("vouchers.off", { value: describe(v) })}
                    </span>
                  </div>
                  <div className="voucher-badges">
                    {v.status === "active" ? (
                      <span className="pill pill--good">{t("vouchers.active")}</span>
                    ) : (
                      <span className="pill pill--bad">{t("vouchers.inactive")}</span>
                    )}
                    {expired ? (
                      <span className="pill pill--warn">{t("vouchers.expired")}</span>
                    ) : null}
                    {exhausted ? (
                      <span className="pill pill--warn">{t("vouchers.exhausted")}</span>
                    ) : null}
                  </div>
                </div>
                <dl className="voucher-meta">
                  {v.minSubtotalMinor ? (
                    <div>
                      <dt>{t("vouchers.minSubtotal")}</dt>
                      <dd>{formatMoney(v.minSubtotalMinor, currency, locale)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{t("vouchers.used")}</dt>
                    <dd>
                      {v.redemptionCount}
                      {v.globalRedemptionLimit != null ? ` / ${v.globalRedemptionLimit}` : ""}
                    </dd>
                  </div>
                  {v.endsAt ? (
                    <div>
                      <dt>{t("vouchers.expires")}</dt>
                      <dd>{formatDate(v.endsAt, locale)}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="voucher-card__actions">
                  <button className="link" disabled={busy} onClick={() => setDetail(v)}>
                    {t("vouchers.details")}
                  </button>
                  <button className="link" disabled={busy} onClick={() => openEdit(v)}>
                    {t("staff.edit")}
                  </button>
                  <button className="link" disabled={busy} onClick={() => toggle(v)}>
                    {v.status === "active" ? t("vouchers.deactivate") : t("vouchers.activate")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {form ? (
        <Modal
          title={
            form.promotionId ? t("vouchers.editTitle", { code: form.code }) : t("vouchers.new")
          }
          onClose={() => setForm(null)}
          onSave={save}
          busy={busy}
          saveLabel={form.promotionId ? t("staff.save") : t("vouchers.create")}
        >
          <label className="field">
            {t("vouchers.code")}
            <input
              autoFocus
              value={form.code}
              disabled={!!form.promotionId}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="SUMMER10"
            />
          </label>
          <div className="voucher-form-row">
            <label className="field">
              {t("staff.type")}
              <Select<VoucherType>
                ariaLabel={t("vouchers.typeLabel")}
                value={form.type}
                disabled={form.economicsLocked}
                onChange={(type) => setForm({ ...form, type })}
                options={[
                  { value: "percent", label: t("vouchers.percentage") },
                  { value: "fixed", label: t("vouchers.fixedAmount") },
                ]}
              />
            </label>
            <label className="field">
              {form.type === "percent" ? t("vouchers.percent") : t("staff.amountSym", { sym })}
              <input
                inputMode="decimal"
                value={form.value}
                disabled={form.economicsLocked}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </label>
          </div>
          {form.economicsLocked ? <p className="muted">{t("vouchers.economicsLocked")}</p> : null}
          <div className="voucher-form-row">
            <label className="field">
              {t("vouchers.minSubtotalSym", { sym })}
              <input
                inputMode="decimal"
                value={form.minSubtotal}
                onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })}
                placeholder="0"
              />
            </label>
            <label className="field">
              {t("vouchers.maxUses")}
              <input
                inputMode="numeric"
                value={form.maxUses}
                disabled={!!form.promotionId}
                onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                placeholder="∞"
              />
            </label>
          </div>
          <label className="field">
            {t("vouchers.expiresOn")}
            <input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </label>
          {!form.promotionId ? (
            <label className="voucher-toggle">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              {t("vouchers.activeImmediately")}
            </label>
          ) : null}
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={t("vouchers.detailsTitle", { code: voucherCode(detail) ?? "" })}
          onClose={() => setDetail(null)}
          busy={false}
          saveLabel={t("vouchers.close")}
          onSave={() => setDetail(null)}
        >
          <div className="voucher-stats">
            <div className="voucher-stat">
              <strong>
                {detail.redemptionCount}
                {detail.globalRedemptionLimit != null ? ` / ${detail.globalRedemptionLimit}` : ""}
              </strong>
              <span>{t("vouchers.used")}</span>
            </div>
            <div className="voucher-stat">
              <strong>
                {detail.remainingRedemptions != null ? detail.remainingRedemptions : "∞"}
              </strong>
              <span>{t("vouchers.remaining")}</span>
            </div>
            <div className="voucher-stat voucher-stat--accent">
              <strong>{describe(detail)}</strong>
              <span>{t("vouchers.discount")}</span>
            </div>
          </div>
          <dl className="order-kv">
            <div>
              <dt>{t("orders.statusLabel")}</dt>
              <dd>
                <span className={`pill ${detail.status === "active" ? "pill--good" : "pill--bad"}`}>
                  {detail.status === "active" ? t("vouchers.active") : t("vouchers.inactive")}
                </span>
              </dd>
            </div>
            {detail.minSubtotalMinor ? (
              <div>
                <dt>{t("vouchers.minimumSubtotal")}</dt>
                <dd>{formatMoney(detail.minSubtotalMinor, currency, locale)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("vouchers.starts")}</dt>
              <dd>{formatDate(detail.startsAt, locale)}</dd>
            </div>
            <div>
              <dt>{t("vouchers.expires")}</dt>
              <dd>{formatDate(detail.endsAt, locale)}</dd>
            </div>
            <div>
              <dt>{t("customers.channel")}</dt>
              <dd>{detail.channel ?? t("vouchers.allChannels")}</dd>
            </div>
          </dl>
          <p className="muted">{t("vouchers.historyNote")}</p>
        </Modal>
      ) : null}
    </main>
  );
}

function Modal({
  title,
  children,
  onClose,
  onSave,
  busy,
  saveLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  saveLabel: string;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
