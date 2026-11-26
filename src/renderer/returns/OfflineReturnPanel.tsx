import { useCallback, useEffect, useState } from "react";

import type {
  AcceptedOfflineReturn,
  LocalOfflineReturn,
  LocalReturnsState,
  OfflineBridge,
  OfflineReturnGrantView,
} from "../../shared/offline";
import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";

export type OfflineReturnBridge = Pick<
  OfflineBridge,
  "getReturnGrants" | "recordReturn" | "getLocalReturns"
>;

type Selection = { quantity: string; reason: string; disposition: "restock" | "non_restock" };

/**
 * Offline return capture (ADR-041 Decision A). Offers ONLY orders whose server-issued return grant was
 * cached while connected, and only the granted lines up to their remaining quantity. Recording a return
 * saves a signed command on this device; the refund is REQUESTED, never paid here — the server computes
 * the amount on sync and leaves it pending for connected settlement. No refund money is shown until the
 * server has computed it.
 */
export function OfflineReturnPanel({
  bridge,
  onClose,
  onRecorded,
}: {
  readonly bridge: OfflineReturnBridge;
  readonly onClose: () => void;
  readonly onRecorded?: (accepted: AcceptedOfflineReturn) => void;
}) {
  const { t, locale } = useI18n();
  const [grants, setGrants] = useState<readonly OfflineReturnGrantView[]>([]);
  const [local, setLocal] = useState<LocalReturnsState>({ pending: 0, recent: [] });
  const [grantId, setGrantId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptedOfflineReturn | null>(null);
  // ADR-042 §6/§7: admin credentials checked at the till now, only when the grant requires them. Cleared after
  // each attempt; never stored. There is no approval queue.
  const [approverName, setApproverName] = useState("");
  const [approverPassword, setApproverPassword] = useState("");

  const refresh = useCallback(async () => {
    const [nextGrants, nextLocal] = await Promise.all([
      bridge.getReturnGrants(),
      bridge.getLocalReturns(),
    ]);
    setGrants(nextGrants);
    setLocal(nextLocal);
  }, [bridge]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refresh().catch(() => setError(t("offlineReturns.loadFailed")));
    }, 0);
    return () => window.clearTimeout(initial);
  }, [refresh, t]);

  const grant = grants.find((item) => item.returnGrantId === grantId) ?? null;
  const lines =
    grant?.lines.flatMap((line) => {
      const item = selection[line.orderLineId];
      return item
        ? [
            {
              orderLineId: line.orderLineId,
              quantity: Number(item.quantity),
              reason: item.reason.trim(),
              disposition: item.disposition,
            },
          ]
        : [];
    }) ?? [];
  const valid =
    grant !== null &&
    lines.length > 0 &&
    lines.every((line) => {
      const granted = grant.lines.find((item) => item.orderLineId === line.orderLineId);
      return (
        Number.isSafeInteger(line.quantity) &&
        line.quantity > 0 &&
        line.quantity <= (granted?.remainingQuantity ?? 0) &&
        line.reason.length > 0 &&
        line.reason.length <= 500 &&
        (grant.allowedReasons === null || grant.allowedReasons.includes(line.reason))
      );
    });

  function choose(id: string | null) {
    setGrantId(id);
    setSelection({});
    setReview(false);
    setAccepted(null);
    setError(null);
  }
  function update(id: string, change: Partial<Selection>) {
    setSelection((current) => ({ ...current, [id]: { ...current[id], ...change } as Selection }));
    setReview(false);
  }
  function lineLabel(line: {
    lineNumber: number | null;
    productName: string | null;
    sku: string | null;
  }) {
    if (line.productName) return line.sku ? `${line.productName} · ${line.sku}` : line.productName;
    return t("returns.orderLine", { n: line.lineNumber ?? "?" });
  }
  async function confirm() {
    if (!grant || !valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bridge.recordReturn({
        returnGrantId: grant.returnGrantId,
        lines,
        ...(grant.requiresAdminCredentials
          ? { approver: { username: approverName, password: approverPassword } }
          : {}),
      });
      setAccepted(result);
      setSelection({});
      setReview(false);
      onRecorded?.(result);
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      setError(
        message.includes("ADMIN_CREDENTIALS_")
          ? t("approval.failed", { reason: message })
          : t("offlineReturns.saveFailed"),
      );
    } finally {
      setApproverPassword("");
      setSaving(false);
    }
  }
  function status(item: LocalOfflineReturn) {
    if (item.lifecycle === "synced" && item.refund) {
      return t("offlineReturns.status.synced", {
        amount: formatMoney(item.refund.amountMinor, item.refund.currency, locale),
      });
    }
    if (item.lifecycle === "needs_reconciliation") return t("offlineReturns.status.reconcile");
    return t("offlineReturns.status.pending");
  }

  return (
    <section className="returns-panel" aria-label={t("offlineReturns.ariaLabel")}>
      <div className="section-heading">
        <h2>{t("offlineReturns.title")}</h2>
        <button className="button button--quiet" onClick={onClose}>
          {t("offlineReturns.close")}
        </button>
      </div>
      <p>{t("offlineReturns.intro")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {accepted ? (
        <article className="return-result" role="status">
          <h3>{t("offlineReturns.recorded", { number: accepted.orderNumber })}</h3>
          <p>
            <strong>{t("offlineReturns.refundRequested")}</strong>
          </p>
          <p>{t("offlineReturns.noCash")}</p>
          <p>
            {t("returns.timestamp")}{" "}
            <time dateTime={accepted.acceptedAt}>
              {formatDateTime(accepted.acceptedAt, locale)}
            </time>
          </p>
        </article>
      ) : null}
      {grants.length === 0 ? <p className="inline-state">{t("offlineReturns.noGrants")}</p> : null}
      {grants.length > 0 ? (
        <fieldset disabled={saving}>
          <legend>{t("offlineReturns.chooseOrder")}</legend>
          {grants.map((item) => (
            <button
              key={item.returnGrantId}
              className={`button ${item.returnGrantId === grantId ? "" : "button--quiet"}`}
              aria-pressed={item.returnGrantId === grantId}
              onClick={() => choose(item.returnGrantId)}
            >
              {t("receipt.order", { number: item.orderNumber })} ·{" "}
              {t("offlineReturns.until", { when: formatDateTime(item.expiresAt, locale) })}
            </button>
          ))}
        </fieldset>
      ) : null}
      {grant ? (
        <>
          <fieldset disabled={saving || review}>
            <legend>{t("returns.selectItems")}</legend>
            {grant.lines.map((line) => {
              const selected = selection[line.orderLineId];
              return (
                <div className="return-line" key={line.orderLineId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!selected}
                      disabled={line.remainingQuantity === 0}
                      onChange={(event) => {
                        if (event.target.checked)
                          update(line.orderLineId, {
                            quantity: "1",
                            reason: "",
                            disposition: "non_restock",
                          });
                        else
                          setSelection((current) => {
                            const copy = { ...current };
                            delete copy[line.orderLineId];
                            return copy;
                          });
                      }}
                    />
                    {lineLabel(line)}
                  </label>
                  <p>
                    {t("offlineReturns.remaining", {
                      remaining: line.remainingQuantity,
                      granted: line.grantedQuantity,
                    })}
                  </p>
                  {selected ? (
                    <div className="return-fields">
                      <label>
                        {t("returns.quantityFor", { n: line.lineNumber })}
                        <input
                          type="number"
                          min="1"
                          max={line.remainingQuantity}
                          step="1"
                          value={selected.quantity}
                          onChange={(event) =>
                            update(line.orderLineId, { quantity: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        {t("returns.reasonFor", { n: line.lineNumber })}
                        {grant.allowedReasons !== null ? (
                          <Select
                            ariaLabel={t("returns.reasonFor", { n: line.lineNumber })}
                            placeholder={t("returns.chooseReason")}
                            value={selected.reason}
                            onChange={(value) => update(line.orderLineId, { reason: value })}
                            options={grant.allowedReasons.map((reason) => ({
                              value: reason,
                              label: reason,
                            }))}
                          />
                        ) : (
                          <input
                            maxLength={500}
                            value={selected.reason}
                            onChange={(event) =>
                              update(line.orderLineId, { reason: event.target.value })
                            }
                          />
                        )}
                      </label>
                      <label>
                        {t("returns.dispositionFor", { n: line.lineNumber })}
                        <Select<Selection["disposition"]>
                          ariaLabel={t("returns.dispositionFor", { n: line.lineNumber })}
                          value={selected.disposition}
                          onChange={(disposition) => update(line.orderLineId, { disposition })}
                          options={[
                            { value: "non_restock", label: t("returns.nonRestockOption") },
                            { value: "restock", label: t("returns.restockOption") },
                          ]}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
          <p>{t("offlineReturns.stockNote")}</p>
          {!review ? (
            <button className="button" disabled={!valid || saving} onClick={() => setReview(true)}>
              {t("returns.reviewReturn")}
            </button>
          ) : (
            <div className="return-review">
              <h3>{t("returns.confirmReceived")}</h3>
              <p>{t("offlineReturns.confirmNote")}</p>
              {grant?.requiresAdminCredentials ? (
                <fieldset className="approval" data-testid="return-approval">
                  <legend>{t("approval.title")}</legend>
                  <p>{t("approval.note")}</p>
                  <label>
                    {t("approval.username")}
                    <input
                      value={approverName}
                      autoComplete="off"
                      onChange={(event) => setApproverName(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("approval.password")}
                    <input
                      type="password"
                      value={approverPassword}
                      autoComplete="off"
                      onChange={(event) => setApproverPassword(event.target.value)}
                    />
                  </label>
                </fieldset>
              ) : null}
              <button disabled={saving} onClick={() => setReview(false)}>
                {t("returns.editReturn")}
              </button>
              <button
                className="button"
                disabled={
                  !valid ||
                  saving ||
                  (grant?.requiresAdminCredentials === true &&
                    (approverName.trim() === "" || approverPassword === ""))
                }
                onClick={() => void confirm()}
              >
                {saving ? t("offlineReturns.saving") : t("offlineReturns.confirm")}
              </button>
            </div>
          )}
        </>
      ) : null}
      <details open={local.recent.length > 0}>
        <summary>
          {t("offlineReturns.history", { count: local.recent.length, pending: local.pending })}
        </summary>
        {local.recent.length === 0 ? <p>{t("offlineReturns.noHistory")}</p> : null}
        <ul>
          {local.recent.map((item) => (
            <li key={item.localReturnId}>
              {t("receipt.order", { number: item.orderNumber })} ·{" "}
              {formatDateTime(item.acceptedAt, locale)} ·{" "}
              {item.lines.map((line) => `${lineLabel(line)} × ${line.quantity}`).join(", ")} ·{" "}
              <strong>{status(item)}</strong>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
