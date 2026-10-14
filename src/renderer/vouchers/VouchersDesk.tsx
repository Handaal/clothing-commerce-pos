import type { PromotionDetail, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { currencySymbol, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
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

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};

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
  const [vouchers, setVouchers] = useState<PromotionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  const [detail, setDetail] = useState<PromotionDetail | null>(null);

  const sym = currencySymbol(currency);

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
    [load],
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
      toast.error(
        form.type === "percent" ? "Enter a percentage between 1 and 100." : "Enter a valid amount.",
      );
      return;
    }
    const minSubtotalMinor =
      form.minSubtotal.trim() === "" ? null : parseMajorToMinor(form.minSubtotal);
    if (minSubtotalMinor === null && form.minSubtotal.trim() !== "") {
      toast.error("Minimum subtotal is not a valid amount.");
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
        `Voucher ${form.code} updated.`,
      ).then(
        () => setForm(null),
        () => undefined,
      );
      return;
    }

    const code = form.code.trim().toUpperCase();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      toast.error("Enter a code using letters, numbers, dashes or underscores.");
      return;
    }
    const maxUses = form.maxUses.trim() === "" ? null : Number(form.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
      toast.error("Max uses must be a whole number greater than zero.");
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
      `Voucher ${code} created.`,
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
      `Voucher ${voucherCode(v)} ${v.status === "active" ? "deactivated" : "activated"}.`,
    ).catch(() => undefined);

  const describe = (v: PromotionDetail) =>
    v.benefitType === "percentage"
      ? `${(v.benefitPercentBp ?? 0) / 100}%`
      : formatMoney(v.benefitAmountMinor ?? 0, v.benefitCurrency ?? currency);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">Promotions</p>
          <h1>Vouchers</h1>
        </div>
        <div className="staff-filters">
          <button className="button button--quiet" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <button className="button" onClick={openNew} disabled={busy}>
            New voucher
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <SkeletonLines lines={5} label="Loading vouchers" />
      ) : vouchers.length === 0 ? (
        <p className="staff-empty">
          No vouchers yet. Create one to offer a discount code at checkout.
        </p>
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
                    <span className="voucher-benefit">{describe(v)} off</span>
                  </div>
                  <div className="voucher-badges">
                    {v.status === "active" ? (
                      <span className="pill pill--good">Active</span>
                    ) : (
                      <span className="pill pill--bad">Inactive</span>
                    )}
                    {expired ? <span className="pill pill--warn">Expired</span> : null}
                    {exhausted ? <span className="pill pill--warn">Exhausted</span> : null}
                  </div>
                </div>
                <dl className="voucher-meta">
                  {v.minSubtotalMinor ? (
                    <div>
                      <dt>Min subtotal</dt>
                      <dd>{formatMoney(v.minSubtotalMinor, currency)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Used</dt>
                    <dd>
                      {v.redemptionCount}
                      {v.globalRedemptionLimit != null ? ` / ${v.globalRedemptionLimit}` : ""}
                    </dd>
                  </div>
                  {v.endsAt ? (
                    <div>
                      <dt>Expires</dt>
                      <dd>{fmtDate(v.endsAt)}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="voucher-card__actions">
                  <button className="link" disabled={busy} onClick={() => setDetail(v)}>
                    Details
                  </button>
                  <button className="link" disabled={busy} onClick={() => openEdit(v)}>
                    Edit
                  </button>
                  <button className="link" disabled={busy} onClick={() => toggle(v)}>
                    {v.status === "active" ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {form ? (
        <Modal
          title={form.promotionId ? `Edit voucher · ${form.code}` : "New voucher"}
          onClose={() => setForm(null)}
          onSave={save}
          busy={busy}
          saveLabel={form.promotionId ? "Save" : "Create"}
        >
          <label className="field">
            Code
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
              Type
              <Select<VoucherType>
                ariaLabel="Voucher type"
                value={form.type}
                disabled={form.economicsLocked}
                onChange={(type) => setForm({ ...form, type })}
                options={[
                  { value: "percent", label: "Percentage" },
                  { value: "fixed", label: "Fixed amount" },
                ]}
              />
            </label>
            <label className="field">
              {form.type === "percent" ? "Percent (%)" : `Amount (${sym})`}
              <input
                inputMode="decimal"
                value={form.value}
                disabled={form.economicsLocked}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </label>
          </div>
          {form.economicsLocked ? (
            <p className="muted">
              This voucher has been redeemed, so its discount can no longer change.
            </p>
          ) : null}
          <div className="voucher-form-row">
            <label className="field">
              Min subtotal ({sym})
              <input
                inputMode="decimal"
                value={form.minSubtotal}
                onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })}
                placeholder="0"
              />
            </label>
            <label className="field">
              Max uses
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
            Expires on
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
              Active immediately
            </label>
          ) : null}
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={`${voucherCode(detail)} · Details`}
          onClose={() => setDetail(null)}
          busy={false}
          saveLabel="Close"
          onSave={() => setDetail(null)}
        >
          <div className="voucher-stats">
            <div className="voucher-stat">
              <strong>
                {detail.redemptionCount}
                {detail.globalRedemptionLimit != null ? ` / ${detail.globalRedemptionLimit}` : ""}
              </strong>
              <span>Used</span>
            </div>
            <div className="voucher-stat">
              <strong>
                {detail.remainingRedemptions != null ? detail.remainingRedemptions : "∞"}
              </strong>
              <span>Remaining</span>
            </div>
            <div className="voucher-stat voucher-stat--accent">
              <strong>{describe(detail)}</strong>
              <span>Discount</span>
            </div>
          </div>
          <dl className="order-kv">
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`pill ${detail.status === "active" ? "pill--good" : "pill--bad"}`}>
                  {detail.status}
                </span>
              </dd>
            </div>
            {detail.minSubtotalMinor ? (
              <div>
                <dt>Minimum subtotal</dt>
                <dd>{formatMoney(detail.minSubtotalMinor, currency)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Starts</dt>
              <dd>{fmtDate(detail.startsAt)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{fmtDate(detail.endsAt)}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{detail.channel ?? "All channels"}</dd>
            </div>
          </dl>
          <p className="muted">
            Per-order redemption history is not exposed by the promotions API; usage totals are
            shown above.
          </p>
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
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
