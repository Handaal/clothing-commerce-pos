import { useMemo, useState } from "react";

import { currencySymbol, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";

export type TenderMethod = "cash" | "card" | "instapay" | "wallet";

export interface SaleTender {
  method: TenderMethod;
  amountMinor: number;
  cashReceivedMinor?: number;
}

const METHODS: readonly TenderMethod[] = ["cash", "card", "instapay", "wallet"];
const METHOD_LABELS: Record<TenderMethod, string> = {
  cash: "Cash",
  card: "Card",
  instapay: "Instapay",
  wallet: "Wallet",
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
}: {
  netMinor: number;
  currency: string;
  submitting: boolean;
  onConfirm: (tenders: SaleTender[]) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([
    { method: "cash", amount: minorToMajorInput(netMinor) },
  ]);
  const [cashReceived, setCashReceived] = useState("");
  const symbol = currencySymbol(currency);

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
      ...(row.method === "cash"
        ? { cashReceivedMinor: cashReceivedMinor ?? cashAmountMinor }
        : {}),
    }));
    onConfirm(tenders);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Take payment">
      <div className="modal-card pay-modal">
        <p className="eyebrow">Payment</p>
        <div className="pay-due">
          <span>Amount due</span>
          <strong>{formatMoney(netMinor, currency)}</strong>
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
                      {METHOD_LABELS[method]}
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
                  aria-label="Remove tender"
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
          <button type="button" className="button button--quiet" disabled={submitting} onClick={addRow}>
            + Split payment
          </button>
        ) : null}

        {cashIndex >= 0 ? (
          <label className="cash-field">
            Cash received <span>{symbol}</span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={cashReceived}
              disabled={submitting}
              onChange={(event) => setCashReceived(event.target.value)}
            />
          </label>
        ) : null}

        <div className="pay-summary">
          {remaining !== 0 ? (
            <div className={`pay-remaining${remaining < 0 ? " pay-remaining--over" : ""}`}>
              <span>{remaining > 0 ? "Remaining" : "Over by"}</span>
              <strong>{formatMoney(Math.abs(remaining), currency)}</strong>
            </div>
          ) : null}
          {cashIndex >= 0 && change > 0 ? (
            <div className="pay-change">
              <span>Change</span>
              <strong>{formatMoney(change, currency)}</strong>
            </div>
          ) : null}
        </div>

        <div className="pay-actions">
          <button type="button" className="button button--quiet" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button button--complete" disabled={!canConfirm} onClick={confirm}>
            {submitting ? "Completing sale…" : "Complete sale"}
          </button>
        </div>
      </div>
    </div>
  );
}
