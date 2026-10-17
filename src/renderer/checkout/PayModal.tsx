import { useEffect, useMemo, useState } from "react";

import { currencySymbol, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { useI18n } from "../shell/i18n";
import { useModalA11y } from "../shell/useModalA11y";

export type TenderMethod = "cash" | "card" | "instapay" | "wallet";

export interface SaleTender {
  method: TenderMethod;
  amountMinor: number;
  cashReceivedMinor?: number;
}

export interface SaleCustomer {
  name: string;
  phone: string;
}

// Phone is matched/stored in E.164; normalization keeps only + and digits.
function normalizePhone(value: string): string {
  return value.replace(/[^+0-9]/g, "");
}
function isValidPhone(value: string): boolean {
  return /^\+[1-9][0-9]{6,14}$/.test(normalizePhone(value));
}

const METHODS: readonly TenderMethod[] = ["cash", "card", "instapay", "wallet"];
const METHOD_LABEL_KEYS: Record<TenderMethod, string> = {
  cash: "pay.method.cash",
  card: "pay.method.card",
  instapay: "pay.method.instapay",
  wallet: "pay.method.wallet",
};

interface Row {
  method: TenderMethod;
  amount: string;
}

/**
 * Collects how a sale is settled: one or more cashier-confirmed tenders whose amounts must sum to the
 * authoritative net total. The cash tender additionally captures physical cash received to compute
 * change. The final amounts and change are re-derived and confirmed by the Commerce API.
 */
export function PayModal({
  netMinor,
  currency,
  submitting,
  onConfirm,
  onCancel,
  lookupCustomer,
}: {
  netMinor: number;
  currency: string;
  submitting: boolean;
  onConfirm: (tenders: SaleTender[], customer?: SaleCustomer) => void;
  onCancel: () => void;
  // Optional phone lookup; returns the matched customer's name or null. Absent ⇒ no live matching.
  lookupCustomer?: (phone: string) => Promise<{ name: string } | null>;
}) {
  const [rows, setRows] = useState<Row[]>([
    { method: "cash", amount: minorToMajorInput(netMinor) },
  ]);
  const [cashReceived, setCashReceived] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [matchedName, setMatchedName] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const { t, locale } = useI18n();
  const symbol = currencySymbol(currency, locale);

  const phoneValid = isValidPhone(customerPhone);
  const nameValid = customerName.trim().length >= 1 && customerName.trim().length <= 200;
  // Customer is optional: attach only when both name and a valid phone are present.
  const customerValid = nameValid && phoneValid;
  const customerPartial =
    (customerName.trim() !== "" || customerPhone.trim() !== "") && !customerValid;

  // Debounced match-by-phone. When a known phone is typed we surface the stored name and prefill an
  // empty name field so the cashier can confirm the existing customer at a glance.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- synchronize match state with the phone input */
    if (!lookupCustomer || !phoneValid) {
      setMatchedName(null);
      setLookingUp(false);
      return;
    }
    let active = true;
    setLookingUp(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    const handle = window.setTimeout(() => {
      void lookupCustomer(normalizePhone(customerPhone))
        .then((match) => {
          if (!active) return;
          setMatchedName(match?.name ?? null);
          if (match?.name)
            setCustomerName((current) => (current.trim() === "" ? match.name : current));
        })
        .catch(() => active && setMatchedName(null))
        .finally(() => active && setLookingUp(false));
    }, 400);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [customerPhone, phoneValid, lookupCustomer]);

  const amounts = useMemo(() => rows.map((row) => parseMajorToMinor(row.amount)), [rows]);
  const sum = amounts.reduce<number>((total, value) => total + (value ?? 0), 0);
  const remaining = netMinor - sum;
  const cashIndex = rows.findIndex((row) => row.method === "cash");
  const cashAmountMinor = cashIndex >= 0 ? (amounts[cashIndex] ?? 0) : 0;
  const cashReceivedMinor = cashIndex >= 0 ? parseMajorToMinor(cashReceived) : null;
  const change =
    cashIndex >= 0 && cashReceivedMinor !== null ? cashReceivedMinor - cashAmountMinor : 0;

  const usedMethods = new Set(rows.map((row) => row.method));
  const availableToAdd = METHODS.filter((method) => !usedMethods.has(method));

  const amountsValid = amounts.every((value) => value !== null && value > 0);
  const cashValid =
    cashIndex < 0 || (cashReceivedMinor !== null && cashReceivedMinor >= cashAmountMinor);
  const canConfirm = remaining === 0 && amountsValid && cashValid && !submitting;

  function setMethod(index: number, method: TenderMethod) {
    if (usedMethods.has(method) && rows[index].method !== method) return;
    setRows((current) => current.map((row, i) => (i === index ? { ...row, method } : row)));
  }
  function setAmount(index: number, amount: string) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, amount } : row)));
  }
  function addRow() {
    const next = availableToAdd[0];
    if (!next) return;
    // Seed the new tender with whatever is still outstanding so the split balances quickly.
    const seed = remaining > 0 ? minorToMajorInput(remaining) : "";
    setRows((current) => [...current, { method: next, amount: seed }]);
  }
  function removeRow(index: number) {
    setRows((current) => current.filter((_, i) => i !== index));
  }

  function confirm() {
    if (!canConfirm) return;
    const tenders: SaleTender[] = rows.map((row, index) => ({
      method: row.method,
      amountMinor: amounts[index] as number,
      ...(row.method === "cash" ? { cashReceivedMinor: cashReceivedMinor ?? cashAmountMinor } : {}),
    }));
    const customer: SaleCustomer | undefined = customerValid
      ? { name: customerName.trim(), phone: normalizePhone(customerPhone) }
      : undefined;
    onConfirm(tenders, customer);
  }

  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("pay.dialogLabel")}
    >
      <div className="modal-card pay-modal" ref={dialogRef}>
        <p className="eyebrow">{t("pay.title")}</p>
        <div className="pay-due">
          <span>{t("pay.amountDue")}</span>
          <strong>{formatMoney(netMinor, currency, locale)}</strong>
        </div>

        <div className="pay-rows">
          {rows.map((row, index) => (
            <div className="pay-row" key={index}>
              <div className="pay-methods">
                {METHODS.map((method) => {
                  const disabled = usedMethods.has(method) && row.method !== method;
                  return (
                    <button
                      key={method}
                      type="button"
                      className={`pay-method${row.method === method ? " pay-method--active" : ""}`}
                      disabled={disabled || submitting}
                      onClick={() => setMethod(index, method)}
                    >
                      {t(METHOD_LABEL_KEYS[method])}
                    </button>
                  );
                })}
              </div>
              <label className="pay-amount">
                <span>{symbol}</span>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={row.amount}
                  disabled={submitting}
                  onChange={(event) => setAmount(index, event.target.value)}
                />
              </label>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className="pay-remove"
                  aria-label={t("pay.removeTender")}
                  disabled={submitting}
                  onClick={() => removeRow(index)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>

        {availableToAdd.length > 0 ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={submitting}
            onClick={addRow}
          >
            {t("pay.split")}
          </button>
        ) : null}

        {cashIndex >= 0 ? (
          <label className="cash-field">
            {t("pay.cashReceived")} <span>{symbol}</span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={cashReceived}
              disabled={submitting}
              onChange={(event) => setCashReceived(event.target.value)}
            />
          </label>
        ) : null}

        <div className="pay-customer">
          <p className="eyebrow">{t("pay.customerOptional")}</p>
          <div className="pay-customer__fields">
            <input
              aria-label={t("pay.customerPhone")}
              inputMode="tel"
              placeholder={t("pay.phonePlaceholder")}
              value={customerPhone}
              disabled={submitting}
              onChange={(event) => setCustomerPhone(event.target.value)}
            />
            <input
              aria-label={t("pay.customerName")}
              placeholder={t("pay.namePlaceholder")}
              value={customerName}
              disabled={submitting}
              onChange={(event) => setCustomerName(event.target.value)}
            />
          </div>
          {lookingUp ? (
            <span className="pay-customer__status">{t("pay.checking")}</span>
          ) : matchedName ? (
            <span className="pay-customer__status pay-customer__status--match">
              {t("pay.existing", { name: matchedName })}
            </span>
          ) : customerPartial ? (
            <span className="pay-customer__status pay-customer__status--hint">
              {t("pay.partialHint")}
            </span>
          ) : phoneValid && customerName.trim() === "" ? (
            <span className="pay-customer__status pay-customer__status--hint">
              {t("pay.newCustomer")}
            </span>
          ) : null}
        </div>

        <div className="pay-summary">
          {remaining !== 0 ? (
            <div className={`pay-remaining${remaining < 0 ? " pay-remaining--over" : ""}`}>
              <span>{remaining > 0 ? t("pay.remaining") : t("pay.overBy")}</span>
              <strong>{formatMoney(Math.abs(remaining), currency, locale)}</strong>
            </div>
          ) : null}
          {cashIndex >= 0 && change > 0 ? (
            <div className="pay-change">
              <span>{t("pay.change")}</span>
              <strong>{formatMoney(change, currency, locale)}</strong>
            </div>
          ) : null}
        </div>

        <div className="pay-actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={submitting}
            onClick={onCancel}
          >
            {t("pay.cancel")}
          </button>
          <button
            type="button"
            className="button button--complete"
            disabled={!canConfirm}
            onClick={confirm}
          >
            {submitting ? t("pay.completing") : t("pay.complete")}
          </button>
        </div>
      </div>
    </div>
  );
}
