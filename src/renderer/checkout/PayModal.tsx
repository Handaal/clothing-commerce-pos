import { useEffect, useMemo, useRef, useState } from "react";

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

// One typeahead match from the existing customer book.
export interface CustomerMatch {
  id: string;
  name: string;
  phone: string;
}

// Phone is matched/stored in E.164; normalization keeps only + and digits.
// Canonicalize a typed phone to E.164 — the form the server stores and matches on. The POS is
// Egypt-only, so a locally-typed mobile (11 digits with a leading 0, e.g. 01012345678) is mapped to
// +20… and an international 00-prefix to +. An input already in + form is kept. Anything else is
// returned digits-only so it fails validation and the "won't be saved" hint shows. Without this, a
// cashier typing a plain local number produced an invalid phone, so the customer was silently dropped
// from the sale (a customer is optional for a normal sale) and never created server-side.
function normalizePhone(value: string): string {
  const cleaned = value.replace(/[^+0-9]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  if (cleaned.startsWith("0") && cleaned.length === 11) return `+20${cleaned.slice(1)}`;
  return cleaned;
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
  searchCustomers,
  disableFreeformCustomer = false,
  presetCustomer,
}: {
  netMinor: number;
  currency: string;
  submitting: boolean;
  // amountPaidMinor is the deposit when the cashier chooses installments (always < netMinor). It is
  // omitted for a normal fully-settled sale. The unpaid remainder is recorded as a customer balance.
  onConfirm: (tenders: SaleTender[], customer?: SaleCustomer, amountPaidMinor?: number) => void;
  onCancel: () => void;
  // Optional phone lookup; returns the matched customer's name or null. Absent ⇒ no live matching.
  lookupCustomer?: (phone: string) => Promise<{ name: string } | null>;
  // Optional typeahead over existing customers, matching the typed name OR phone. Absent ⇒ no dropdown.
  // Selecting a suggestion fills both contact fields; typing a new name/phone still creates a profile.
  searchCustomers?: (term: string) => Promise<ReadonlyArray<CustomerMatch>>;
  // Offline mode: the till never captures a free-form name/phone (customers come from the signed
  // snapshot). Freeform fields are hidden; installments are offered only when a snapshot customer has
  // already been selected and passed as presetCustomer — the caller owns that customer's id.
  disableFreeformCustomer?: boolean;
  // The already-selected snapshot customer (offline). Shows a read-only summary + running balance and
  // satisfies the installment customer requirement without collecting contact fields.
  presetCustomer?: { name: string; phone: string; balanceMinor: number };
}) {
  const [rows, setRows] = useState<Row[]>([
    { method: "cash", amount: minorToMajorInput(netMinor) },
  ]);
  const [cashReceived, setCashReceived] = useState("");
  // Installment ("pay later") state: when on, the tenders settle only the deposit and the remainder
  // becomes a customer debt — so a customer is mandatory. The deposit is entered in major units.
  const [installment, setInstallment] = useState(false);
  const [deposit, setDeposit] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [matchedName, setMatchedName] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // Typeahead over the customer book. `customerQuery` holds the last-typed contact fragment (name or
  // phone); picking a suggestion fills both fields and clears the query so the list collapses.
  const [customerQuery, setCustomerQuery] = useState("");
  const [suggestions, setSuggestions] = useState<readonly CustomerMatch[]>([]);
  const { t, locale } = useI18n();
  const symbol = currencySymbol(currency, locale);

  const phoneValid = isValidPhone(customerPhone);
  const nameValid = customerName.trim().length >= 1 && customerName.trim().length <= 200;
  const freeformValid = nameValid && phoneValid;
  // Customer is optional for a normal sale, but mandatory for an installment (it owns the balance).
  // Offline, the customer is the preselected snapshot entry; online it is the freeform capture.
  const customerValid = disableFreeformCustomer ? presetCustomer !== undefined : freeformValid;
  const customerPartial =
    (customerName.trim() !== "" || customerPhone.trim() !== "") && !freeformValid;
  // Installments need someone to owe the balance: freeform capture online, or a preselected customer
  // offline. With neither, the toggle is hidden and only a full settlement is possible.
  const canOfferInstallment = !disableFreeformCustomer || presetCustomer !== undefined;

  // Callers pass these as inline arrows, so their identity changes on every parent render — and the
  // parent re-renders on the 2s offline poll. Read them through refs so the debounced effects below
  // depend only on the actual inputs (phone/query); otherwise each poll tick would re-run the lookup,
  // flickering the status back to "Checking…" even though the customer was already matched.
  const lookupCustomerRef = useRef(lookupCustomer);
  const searchCustomersRef = useRef(searchCustomers);
  useEffect(() => {
    lookupCustomerRef.current = lookupCustomer;
    searchCustomersRef.current = searchCustomers;
  }, [lookupCustomer, searchCustomers]);

  // Debounced match-by-phone. When a known phone is typed we surface the stored name and prefill an
  // empty name field so the cashier can confirm the existing customer at a glance.
  useEffect(() => {
    if (!lookupCustomerRef.current || !phoneValid) {
      setMatchedName(null);
      setLookingUp(false);
      return;
    }
    let active = true;
    setLookingUp(true);
    const handle = window.setTimeout(() => {
      void lookupCustomerRef
        .current!(normalizePhone(customerPhone))
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
  }, [customerPhone, phoneValid]);

  // Debounced customer typeahead. Searches the book by the last-typed contact fragment (matches name
  // or phone server-side) and surfaces up to a handful of matches for the cashier to pick from.
  useEffect(() => {
    const term = customerQuery.trim();
    if (!searchCustomersRef.current || term.length < 2) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const handle = window.setTimeout(() => {
      void searchCustomersRef
        .current!(term)
        .then((matches) => active && setSuggestions(matches.slice(0, 6)))
        .catch(() => active && setSuggestions([]));
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [customerQuery]);

  function pickCustomer(match: CustomerMatch) {
    setCustomerName(match.name);
    setCustomerPhone(match.phone);
    setCustomerQuery("");
    setSuggestions([]);
    setMatchedName(match.name);
  }

  const amounts = useMemo(() => rows.map((row) => parseMajorToMinor(row.amount)), [rows]);
  const sum = amounts.reduce<number>((total, value) => total + (value ?? 0), 0);
  // The deposit (installment) or the full net is what the tenders must settle now.
  const depositMinor = installment ? parseMajorToMinor(deposit) : null;
  const settleTarget = installment ? (depositMinor ?? 0) : netMinor;
  const remaining = settleTarget - sum;
  // The unpaid balance recorded as a customer debt (installment only, deposit strictly below net).
  const balanceMinor =
    installment && depositMinor !== null ? Math.max(0, netMinor - depositMinor) : 0;
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
  // A valid installment deposit is positive and strictly below the net (otherwise it is a normal sale).
  const depositValid =
    !installment || (depositMinor !== null && depositMinor > 0 && depositMinor < netMinor);
  const customerRequired = installment;
  const canConfirm =
    remaining === 0 &&
    amountsValid &&
    cashValid &&
    depositValid &&
    (!customerRequired || customerValid) &&
    !submitting;

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
  // Toggling installments collapses back to a single cash tender: in installment mode it is seeded
  // empty (the cashier enters the deposit), in full mode it is reseeded to the net total as before.
  function toggleInstallment(next: boolean) {
    setInstallment(next);
    setDeposit("");
    setCashReceived("");
    setRows([{ method: "cash", amount: next ? "" : minorToMajorInput(netMinor) }]);
  }

  function confirm() {
    if (!canConfirm) return;
    const tenders: SaleTender[] = rows.map((row, index) => ({
      method: row.method,
      amountMinor: amounts[index] as number,
      ...(row.method === "cash" ? { cashReceivedMinor: cashReceivedMinor ?? cashAmountMinor } : {}),
    }));
    // Offline the caller owns the snapshot customer id, so no contact is returned here; online we hand
    // back the freeform-captured name/phone for the server to upsert.
    const customer: SaleCustomer | undefined =
      disableFreeformCustomer || !freeformValid
        ? undefined
        : { name: customerName.trim(), phone: normalizePhone(customerPhone) };
    onConfirm(tenders, customer, installment ? (depositMinor as number) : undefined);
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

        {canOfferInstallment ? (
          <div className="pay-installment">
            <label className="pay-installment__toggle">
              <input
                type="checkbox"
                checked={installment}
                disabled={submitting}
                onChange={(event) => toggleInstallment(event.target.checked)}
              />
              <span>{t("pay.installmentToggle")}</span>
            </label>
            {installment ? (
              <>
                <label className="pay-amount pay-installment__deposit">
                  <span>{t("pay.depositNow")}</span>
                  <span>{symbol}</span>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={deposit}
                    disabled={submitting}
                    onChange={(event) => setDeposit(event.target.value)}
                  />
                </label>
                <div className="pay-installment__balance">
                  <span>{t("pay.balanceOwed")}</span>
                  <strong>{formatMoney(balanceMinor, currency, locale)}</strong>
                </div>
                {!depositValid && deposit.trim() !== "" ? (
                  <span className="pay-customer__status pay-customer__status--hint">
                    {t("pay.depositHint")}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {disableFreeformCustomer ? (
          presetCustomer ? (
            <div className="pay-customer pay-customer--preset">
              <p className="eyebrow">{t("pay.installmentCustomer")}</p>
              <div className="pay-customer__preset">
                <strong>{presetCustomer.name}</strong>
                <span>{presetCustomer.phone}</span>
                <span>
                  {t("pay.currentBalance", {
                    amount: formatMoney(presetCustomer.balanceMinor, currency, locale),
                  })}
                </span>
              </div>
            </div>
          ) : null
        ) : (
          <div className="pay-customer">
            <p className="eyebrow">
              {customerRequired ? t("pay.customerRequired") : t("pay.customerOptional")}
            </p>
            <div className="pay-customer__fields">
              <input
                aria-label={t("pay.customerPhone")}
                inputMode="tel"
                placeholder={t("pay.phonePlaceholder")}
                value={customerPhone}
                disabled={submitting}
                onChange={(event) => {
                  setCustomerPhone(event.target.value);
                  setCustomerQuery(event.target.value);
                }}
              />
              <input
                aria-label={t("pay.customerName")}
                placeholder={t("pay.namePlaceholder")}
                value={customerName}
                disabled={submitting}
                onChange={(event) => {
                  setCustomerName(event.target.value);
                  setCustomerQuery(event.target.value);
                }}
              />
            </div>
            {suggestions.length > 0 ? (
              <ul className="pay-customer__suggestions" role="listbox">
                {suggestions.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      className="pay-customer__suggestion"
                      disabled={submitting}
                      onClick={() => pickCustomer(match)}
                    >
                      <strong>{match.name}</strong>
                      <span>{match.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
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
            ) : customerRequired && !customerValid ? (
              <span className="pay-customer__status pay-customer__status--hint">
                {t("pay.customerRequiredHint")}
              </span>
            ) : null}
          </div>
        )}

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
