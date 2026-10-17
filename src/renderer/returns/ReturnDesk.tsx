import type {
  CommerceClient,
  OrderDetailResponse,
  OrderListResponse,
  ReturnDetailResponse,
  ReturnEligibilityResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReturnReply,
  ReturnSession,
  ReturnWorkflow,
  ReturnsBridge,
} from "../../shared/returns";
import { formatMoney } from "../money";
import { formatDateTime } from "../format";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import type { PosRegister } from "../pos/context";
import { CONNECTION_REQUIRED, returnFailure, type ReturnIntent } from "./commands.mjs";

interface Props {
  client: TenantCommerceClient;
  health: CommerceClient["getHealth"];
  register: PosRegister;
  onLocked: (locked: boolean) => void;
  getToken: () => Promise<string | null>;
  bridge?: ReturnsBridge;
}
type Selection = { quantity: string; reason: string; disposition: "restock" | "non_restock" };

export function ReturnDesk({
  client,
  health,
  register,
  onLocked,
  getToken,
  bridge = window.returns,
}: Props) {
  const { t, locale } = useI18n();
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  const [orders, setOrders] = useState<OrderListResponse | null>(null);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<OrderDetailResponse | null>(null);
  const [eligibility, setEligibility] = useState<ReturnEligibilityResponse | null>(null);
  const [history, setHistory] = useState<ReturnDetailResponse[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [workflow, setWorkflow] = useState<ReturnWorkflow | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const tokenRef = useRef(getToken);
  useEffect(() => {
    tokenRef.current = getToken;
  });
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [uncertain, setUncertain] = useState<"create" | "settle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReturnDetailResponse | null>(null);
  const [reference, setReference] = useState("");
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const locked = pending || uncertain !== null || !recoveryChecked;
  const activeWorkflow = workflow !== null && workflow.stage !== "completed";

  const session = useCallback(async (): Promise<ReturnSession> => {
    const accessToken = await tokenRef.current();
    if (!accessToken) throw new Error(t("returns.err.restoreSession"));
    return { tenantId: client.tenantId, accessToken };
  }, [client.tenantId, t]);
  const displayReply = useCallback(
    async (reply: ReturnReply) => {
      setWorkflow(reply.workflow);
      setError(reply.error?.message ?? null);
      setUncertain(
        reply.workflow?.stage === "prepared"
          ? "create"
          : reply.workflow?.stage === "settlement_prepared"
            ? "settle"
            : null,
      );
      if (
        !reply.error &&
        reply.workflow?.stage !== "prepared" &&
        reply.workflow?.stage !== "settlement_prepared"
      )
        setRecoveryChecked(true);
      if (reply.workflow?.result) {
        setResult(reply.workflow.result);
        setReview(false);
        try {
          const [detail, eligible] = await Promise.all([
            client.getOrder(reply.workflow.orderId),
            client.getReturnEligibility(reply.workflow.orderId),
          ]);
          setOrder(detail);
          setEligibility(eligible);
        } catch {
          /* Canonical acknowledgement remains visible if detail reads fail. */
        }
      }
    },
    [client],
  );

  useEffect(() => {
    if (!bridge || !connected || recoveryChecked) return;
    let active = true;
    void session()
      .then((auth) => bridge.inspect(auth))
      .then(async (reply) => {
        if (!active) return;
        if (
          !reply.error &&
          (reply.workflow?.stage === "prepared" || reply.workflow?.stage === "settlement_prepared")
        ) {
          await displayReply(reply);
          const recovered = await bridge.recover(await session());
          if (active) await displayReply(recovered);
        } else await displayReply(reply);
      })
      .catch(() => {
        if (active) setError(t("returns.err.checkPrevious"));
      });
    return () => {
      active = false;
    };
  }, [bridge, connected, recoveryChecked, session, displayReply, t]);

  useEffect(() => {
    let active = true;
    let probing = false;
    let generation = 0;
    const offline = () => {
      generation++;
      connectedRef.current = false;
      setConnected(false);
    };
    const probe = async () => {
      if (!navigator.onLine) {
        offline();
        return;
      }
      if (probing) return;
      probing = true;
      const current = generation;
      let available = false;
      try {
        await health();
        available = true;
      } catch {
        /* reachability only */
      }
      if (active && generation === current) {
        connectedRef.current = available && navigator.onLine;
        setConnected(connectedRef.current);
      }
      probing = false;
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 5000);
    window.addEventListener("offline", offline);
    window.addEventListener("online", probe);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", probe);
    };
  }, [health]);

  useEffect(() => {
    onLocked(locked || activeWorkflow);
    return () => onLocked(false);
  }, [locked, activeWorkflow, onLocked]);

  async function recoverSaved() {
    if (!bridge || !connectedRef.current || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await displayReply(await bridge.recover(await session()));
    } catch {
      setError(t("returns.err.completeConfirmation"));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function finishWorkflow() {
    if (!bridge || !workflow || !connectedRef.current || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await displayReply(await bridge.finish(await session(), workflow.id));
    } catch {
      setError(t("returns.err.archive"));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function read(action: () => Promise<void>) {
    if (pendingRef.current || !connectedRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      const view = returnFailure(failure);
      setError(view.uncertain ? t("returns.err.loadData") : view.message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function loadOrder(id: string) {
    const [detail, eligible, returns] = await Promise.all([
      client.getOrder(id),
      client.getReturnEligibility(id),
      client.listReturns(id),
    ]);
    setOrder(detail);
    setEligibility(eligible);
    setHistory(returns.items);
    setHistoryCursor(returns.pageInfo.nextCursor);
    setSelection({});
    setReview(false);
    setResult(null);
    setReference("");
    setCashConfirmed(false);
  }
  const lines: ReturnIntent["lines"] =
    eligibility?.lines.flatMap((line) => {
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
    eligibility?.eligible &&
    lines.length > 0 &&
    lines.length <= 100 &&
    lines.every((line) => {
      const eligible = eligibility.lines.find((item) => item.orderLineId === line.orderLineId);
      return (
        Number.isSafeInteger(line.quantity) &&
        line.quantity > 0 &&
        line.quantity <= (eligible?.eligibleQuantity ?? 0) &&
        line.reason.length > 0 &&
        line.reason.length <= 500 &&
        (eligibility.policy.allowedReasons === null ||
          eligibility.policy.allowedReasons.includes(line.reason))
      );
    });
  const restock = lines.some((line) => line.disposition === "restock");
  function update(id: string, change: Partial<Selection>) {
    setSelection((current) => ({ ...current, [id]: { ...current[id], ...change } as Selection }));
    setReview(false);
  }
  async function submit(kind: "create" | "settle") {
    if (
      !bridge ||
      !recoveryChecked ||
      pendingRef.current ||
      !connectedRef.current ||
      !navigator.onLine ||
      !order ||
      !eligibility
    )
      return;
    if (kind === "create" && (!valid || !review)) return;
    if (kind === "settle" && (!result || !cashConfirmed || !reference.trim())) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const response =
        kind === "create"
          ? await bridge.start(await session(), {
              orderId: order.header.id,
              lines,
              inventoryLocationId: restock ? register.defaultInventoryLocationId : null,
              refundMode: "pending",
              settlementReference: null,
            })
          : await bridge.settle(await session(), result!.id, reference.trim());
      await displayReply(response);
    } catch (failure) {
      const view = returnFailure(failure);
      setError(view.message);
      setRecoveryChecked(false);
      if (view.uncertain) {
        connectedRef.current = false;
        setConnected(false);
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function itemName(lineNumber: number) {
    const item = order?.lines.find((line) => line.lineNumber === lineNumber);
    return item ? `${item.productName} · ${item.sku}` : t("returns.orderLine", { n: lineNumber });
  }
  function disposition(value: "restock" | "non_restock") {
    return value === "restock" ? t("orders.restock") : t("orders.nonRestock");
  }
  function receipt(value: ReturnDetailResponse) {
    return (
      <article className="return-result" key={value.id}>
        <h3>
          {t("returns.accepted", {
            number: order?.header.orderNumber ?? workflow?.orderReference ?? "",
          })}
        </h3>
        <p>{t("returns.referenceNote")}</p>
        <p>
          {t("returns.timestamp")} <time dateTime={value.createdAt}>{value.createdAt}</time>
        </p>
        <ul>
          {value.lines.map((line) => (
            <li key={line.orderLineId}>
              {itemName(line.lineNumber)} · {t("returns.quantityShort", { q: line.quantity })} ·{" "}
              {disposition(line.disposition)} · {line.reason} ·{" "}
              {formatMoney(line.amountMinor, value.currency, locale)}
            </li>
          ))}
        </ul>
        <p>
          <strong>
            {t("returns.refundStatus", {
              amount: formatMoney(value.refund.amountMinor, value.refund.currency, locale),
              status: value.refund.status,
            })}
          </strong>
        </p>
        <p>
          {t("returns.method", { method: value.refund.method })}
          {value.refund.settledAt
            ? ` · ${t("returns.settledAt", { when: value.refund.settledAt })}`
            : ""}
        </p>
        {value.refund.status === "pending" ? (
          <p>
            {t("returns.settlementOwed")}
            {value.refund.method === "electronic" ? ` ${t("returns.electronicNote")}` : ""}
          </p>
        ) : null}
        {value.refund.status === "failed" ? <p>{t("returns.failedNote")}</p> : null}
      </article>
    );
  }

  return (
    <section className="returns-panel" aria-label={t("returns.ariaLabel")}>
      <h2>{t("pos.returns")}</h2>
      <p role="status">{connected ? t("returns.connectedAvailable") : CONNECTION_REQUIRED}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!bridge ? <p role="alert">{t("returns.noDurable")}</p> : null}
      {!recoveryChecked || uncertain ? (
        <div className="return-review">
          <p>{t("returns.confirmingPrev")}</p>
          <button
            className="button"
            disabled={!bridge || !connected || pending}
            onClick={() => void recoverSaved()}
          >
            {t("returns.recoverSaved")}
          </button>
        </div>
      ) : null}
      {workflow?.stage === "return_acknowledged" ? (
        <div className="return-review">
          <p>{t("returns.prevAcknowledged", { ref: workflow.orderReference })}</p>
          <button disabled={!connected || pending} onClick={() => void finishWorkflow()}>
            {workflow.result?.refund.status === "pending"
              ? t("returns.finishPending")
              : t("returns.finishAck")}
          </button>
        </div>
      ) : null}
      {result && (!order || !eligibility) ? receipt(result) : null}
      <fieldset disabled={!connected || locked || activeWorkflow}>
        <legend>{t("returns.findOrder")}</legend>
        <button
          className="button"
          onClick={() =>
            void read(async () =>
              setOrders(
                await client.listOrders({
                  channel: "pos",
                  branchId: register.branchId,
                  status: "placed",
                  limit: 50,
                }),
              ),
            )
          }
        >
          {t("returns.loadConnected")}
        </button>
        <label>
          {t("returns.filterLabel")}
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <p>{t("returns.ordersFrom", { branch: register.branchName })}</p>
        {orders?.items
          .filter((item) => item.orderNumber.toLowerCase().includes(query.trim().toLowerCase()))
          .map((item) => (
            <button
              className="button button--quiet"
              key={item.id}
              onClick={() => void read(() => loadOrder(item.id))}
            >
              {t("receipt.order", { number: item.orderNumber })} ·{" "}
              {formatMoney(item.totalMinor, item.currency, locale)} ·{" "}
              {formatDateTime(item.placedAt, locale)}
            </button>
          ))}
        {orders &&
        !orders.items.some((item) =>
          item.orderNumber.toLowerCase().includes(query.trim().toLowerCase()),
        ) ? (
          <p>{t("returns.noMatchLoaded")}</p>
        ) : null}
        {orders?.pageInfo.hasMore ? (
          <button
            onClick={() =>
              void read(async () => {
                const next = await client.listOrders({
                  channel: "pos",
                  branchId: register.branchId,
                  status: "placed",
                  limit: 50,
                  cursor: orders.pageInfo.nextCursor ?? undefined,
                });
                setOrders({ ...next, items: [...orders.items, ...next.items] });
              })
            }
          >
            {t("returns.loadMoreOrders")}
          </button>
        ) : null}
      </fieldset>
      {order && eligibility ? (
        <>
          <h3>{t("returns.originalOrder", { number: order.header.orderNumber })}</h3>
          <p>
            {t("returns.serverEligibility")}{" "}
            {eligibility.eligible ? t("returns.eligible") : t("returns.notEligible")}
            {eligibility.reason ? ` · ${eligibility.reason}` : ""}
          </p>
          <p>
            {t("returns.maxRefundable", {
              amount: formatMoney(eligibility.maxRefundableMinor, eligibility.currency, locale),
            })}
          </p>
          <button
            disabled={!connected || locked || activeWorkflow}
            onClick={() => void read(() => loadOrder(order.header.id))}
          >
            {t("returns.refreshEligibility")}
          </button>
          {!result ? (
            <>
              <fieldset
                disabled={!connected || locked || activeWorkflow || review || !eligibility.eligible}
              >
                <legend>{t("returns.selectItems")}</legend>
                {eligibility.lines.map((line) => {
                  const selected = selection[line.orderLineId];
                  return (
                    <div className="return-line" key={line.orderLineId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!selected}
                          disabled={line.eligibleQuantity === 0}
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
                        {itemName(line.lineNumber)}
                      </label>
                      <p>
                        {t("returns.lineInfo", {
                          purchased: line.purchasedQuantity,
                          returned: line.returnedQuantity,
                          eligible: line.eligibleQuantity,
                          amount: formatMoney(line.unitPriceMinor, eligibility.currency, locale),
                        })}
                      </p>
                      {selected ? (
                        <div className="return-fields">
                          <label>
                            {t("returns.quantityFor", { n: line.lineNumber })}
                            <input
                              type="number"
                              min="1"
                              max={line.eligibleQuantity}
                              step="1"
                              value={selected.quantity}
                              onChange={(event) =>
                                update(line.orderLineId, { quantity: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            {t("returns.reasonFor", { n: line.lineNumber })}
                            {eligibility.policy.allowedReasons !== null ? (
                              <Select
                                ariaLabel={t("returns.reasonFor", { n: line.lineNumber })}
                                placeholder={t("returns.chooseReason")}
                                value={selected.reason}
                                onChange={(value) => update(line.orderLineId, { reason: value })}
                                options={eligibility.policy.allowedReasons.map((reason) => ({
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
                                {
                                  value: "non_restock",
                                  label: t("returns.nonRestockOption"),
                                },
                                {
                                  value: "restock",
                                  label: t("returns.restockOption"),
                                },
                              ]}
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </fieldset>
              {restock ? (
                <p>
                  {t("returns.restockDestination", {
                    location: register.defaultInventoryLocationName,
                  })}
                </p>
              ) : (
                <p>{t("returns.nonRestockNote")}</p>
              )}
              {!review ? (
                <button
                  className="button"
                  disabled={!connected || locked || !valid}
                  onClick={() => setReview(true)}
                >
                  {t("returns.reviewReturn")}
                </button>
              ) : (
                <div className="return-review">
                  <h3>{t("returns.confirmReceived")}</h3>
                  <ul>
                    {lines.map((line) => (
                      <li key={line.orderLineId}>
                        {itemName(
                          eligibility.lines.find((item) => item.orderLineId === line.orderLineId)!
                            .lineNumber,
                        )}{" "}
                        · {t("returns.quantityShort", { q: line.quantity })} ·{" "}
                        {disposition(line.disposition)} · {line.reason}
                      </li>
                    ))}
                  </ul>
                  <p>{t("returns.confirmNote")}</p>
                  <button disabled={!connected || locked} onClick={() => setReview(false)}>
                    {t("returns.editReturn")}
                  </button>
                  <button
                    className="button"
                    disabled={!connected || locked || activeWorkflow || !valid}
                    onClick={() => void submit("create")}
                  >
                    {t("returns.confirmReturn")}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {receipt(result)}
              {result.refund.status === "pending" &&
              result.refund.method !== "electronic" &&
              eligibility.policy.manualRefundsEnabled &&
              (eligibility.policy.maxManualRefundMinor === null ||
                result.refund.amountMinor <= eligibility.policy.maxManualRefundMinor) ? (
                <div className="return-settlement">
                  <h3>{t("returns.recordCashRefund")}</h3>
                  <p>
                    {t("returns.handBackNote", {
                      amount: formatMoney(
                        result.refund.amountMinor,
                        result.refund.currency,
                        locale,
                      ),
                    })}
                  </p>
                  <label>
                    {t("returns.settlementReference")}
                    <input
                      maxLength={200}
                      disabled={locked}
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={cashConfirmed}
                      disabled={locked}
                      onChange={(event) => setCashConfirmed(event.target.checked)}
                    />
                    {t("returns.cashAttest")}
                  </label>
                  <button
                    className="button"
                    disabled={!connected || locked || !cashConfirmed || !reference.trim()}
                    onClick={() => void submit("settle")}
                  >
                    {uncertain === "settle"
                      ? t("returns.retryCash")
                      : t("returns.recordCashRefund")}
                  </button>
                </div>
              ) : null}
              <button
                disabled={!connected || locked}
                onClick={() => void read(async () => setResult(await client.getReturn(result.id)))}
              >
                {t("returns.refreshResult")}
              </button>
            </>
          )}
          <details>
            <summary>{t("returns.previousReturns")}</summary>
            {history.map(receipt)}
            {historyCursor ? (
              <button
                disabled={!connected || locked}
                onClick={() =>
                  void read(async () => {
                    const next = await client.listReturns(order.header.id, {
                      cursor: historyCursor,
                    });
                    setHistory((current) => [...current, ...next.items]);
                    setHistoryCursor(next.pageInfo.nextCursor);
                  })
                }
              >
                {t("returns.loadMoreReturns")}
              </button>
            ) : null}
            {history.length === 0 ? <p>{t("returns.noPrevious")}</p> : null}
          </details>
          {history.length > 0 && !result ? (
            <fieldset disabled={!connected || locked || activeWorkflow}>
              <legend>{t("returns.openPrevious")}</legend>
              {history.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setResult(item);
                    setReference("");
                    setCashConfirmed(false);
                  }}
                >
                  {formatDateTime(item.createdAt, locale)} ·{" "}
                  {formatMoney(item.refund.amountMinor, item.refund.currency, locale)} ·{" "}
                  {item.refund.status}
                </button>
              ))}
            </fieldset>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
