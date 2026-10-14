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
    if (!accessToken) throw new Error("Restore your operator session to confirm the saved return.");
    return { tenantId: client.tenantId, accessToken };
  }, [client.tenantId]);
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
        if (active)
          setError("Connection and local persistence are required to check previous returns.");
      });
    return () => {
      active = false;
    };
  }, [bridge, connected, recoveryChecked, session, displayReply]);

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
      setError("Connection and local persistence are required to complete confirmation.");
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
      setError("The acknowledged return could not be archived. Retry confirmation.");
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
      setError(
        view.uncertain
          ? "Could not load current order/return data. Check the connection and retry."
          : view.message,
      );
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
    return item ? `${item.productName} · ${item.sku}` : `Order line ${lineNumber}`;
  }
  function receipt(value: ReturnDetailResponse) {
    return (
      <article className="return-result" key={value.id}>
        <h3>Return accepted · Order {order?.header.orderNumber ?? workflow?.orderReference}</h3>
        <p>
          Return reference: unavailable from the API. Identify this return by its original order and
          timestamp.
        </p>
        <p>
          Timestamp: <time dateTime={value.createdAt}>{value.createdAt}</time>
        </p>
        <ul>
          {value.lines.map((line) => (
            <li key={line.orderLineId}>
              {itemName(line.lineNumber)} · Quantity {line.quantity} ·{" "}
              {line.disposition === "restock" ? "RESTOCK" : "NON-RESTOCK"} · {line.reason} ·{" "}
              {formatMoney(line.amountMinor, value.currency)}
            </li>
          ))}
        </ul>
        <p>
          <strong>
            Refund: {formatMoney(value.refund.amountMinor, value.refund.currency)} ·{" "}
            {value.refund.status}
          </strong>
        </p>
        <p>
          Method: {value.refund.method}
          {value.refund.settledAt ? ` · Settled: ${value.refund.settledAt}` : ""}
        </p>
        {value.refund.status === "pending" ? (
          <p>
            Settlement is still owed.
            {value.refund.method === "electronic"
              ? " Electronic refunds await provider processing; this POS cannot settle them."
              : ""}
          </p>
        ) : null}
        {value.refund.status === "failed" ? (
          <p>
            The refund failed. Ask an authorized supervisor to review it; do not create another
            return for these items.
          </p>
        ) : null}
      </article>
    );
  }

  return (
    <section className="returns-panel" aria-label="Connected returns">
      <h2>Returns and refunds</h2>
      <p role="status">{connected ? "Connected · Returns available" : CONNECTION_REQUIRED}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!bridge ? (
        <p role="alert">
          Durable return storage is unavailable. Use the Electron application to submit returns.
        </p>
      ) : null}
      {!recoveryChecked || uncertain ? (
        <div className="return-review">
          <p>
            Confirming a previously submitted return… Connection is required to complete
            confirmation. The saved command and key survive application restart.
          </p>
          <button
            className="button"
            disabled={!bridge || !connected || pending}
            onClick={() => void recoverSaved()}
          >
            Recover saved return/refund
          </button>
        </div>
      ) : null}
      {workflow?.stage === "return_acknowledged" ? (
        <div className="return-review">
          <p>
            Previous return acknowledged · Order {workflow.orderReference}. Record cash settlement
            below, or finish with the canonical refund state shown.
          </p>
          <button disabled={!connected || pending} onClick={() => void finishWorkflow()}>
            {workflow.result?.refund.status === "pending"
              ? "Finish and leave refund pending"
              : "Finish acknowledged return"}
          </button>
        </div>
      ) : null}
      {result && (!order || !eligibility) ? receipt(result) : null}
      <fieldset disabled={!connected || locked || activeWorkflow}>
        <legend>Find original order</legend>
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
          Load connected orders
        </button>
        <label>
          Filter loaded orders by receipt/order number
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <p>
          Orders from {register.branchName}. Load more to search further; unsynchronized local
          receipts are not connected orders.
        </p>
        {orders?.items
          .filter((item) => item.orderNumber.toLowerCase().includes(query.trim().toLowerCase()))
          .map((item) => (
            <button
              className="button button--quiet"
              key={item.id}
              onClick={() => void read(() => loadOrder(item.id))}
            >
              Order {item.orderNumber} · {formatMoney(item.totalMinor, item.currency)} ·{" "}
              {new Date(item.placedAt).toLocaleString()}
            </button>
          ))}
        {orders &&
        !orders.items.some((item) =>
          item.orderNumber.toLowerCase().includes(query.trim().toLowerCase()),
        ) ? (
          <p>No matching order in the loaded results.</p>
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
            Load more orders
          </button>
        ) : null}
      </fieldset>
      {order && eligibility ? (
        <>
          <h3>Original order {order.header.orderNumber}</h3>
          <p>
            Server eligibility: {eligibility.eligible ? "Eligible" : "Not eligible"}
            {eligibility.reason ? ` · ${eligibility.reason}` : ""}
          </p>
          <p>
            Maximum remaining refundable amount:{" "}
            {formatMoney(eligibility.maxRefundableMinor, eligibility.currency)}
          </p>
          <button
            disabled={!connected || locked || activeWorkflow}
            onClick={() => void read(() => loadOrder(order.header.id))}
          >
            Refresh eligibility and return history
          </button>
          {!result ? (
            <>
              <fieldset
                disabled={!connected || locked || activeWorkflow || review || !eligibility.eligible}
              >
                <legend>Select received items</legend>
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
                        Purchased: {line.purchasedQuantity} · Previously returned:{" "}
                        {line.returnedQuantity} · Remaining eligible: {line.eligibleQuantity} ·
                        Original unit amount:{" "}
                        {formatMoney(line.unitPriceMinor, eligibility.currency)}
                      </p>
                      {selected ? (
                        <div className="return-fields">
                          <label>
                            Quantity for line {line.lineNumber}
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
                            Reason for line {line.lineNumber}
                            {eligibility.policy.allowedReasons !== null ? (
                              <Select
                                ariaLabel={`Reason for line ${line.lineNumber}`}
                                placeholder="Choose reason"
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
                            Disposition for line {line.lineNumber}
                            <Select<Selection["disposition"]>
                              ariaLabel={`Disposition for line ${line.lineNumber}`}
                              value={selected.disposition}
                              onChange={(disposition) => update(line.orderLineId, { disposition })}
                              options={[
                                {
                                  value: "non_restock",
                                  label: "NON-RESTOCK — does not increase sellable inventory",
                                },
                                {
                                  value: "restock",
                                  label: "RESTOCK — returns units to sellable inventory",
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
                  RESTOCK destination: {register.defaultInventoryLocationName}. The server verifies
                  receiving permission and sellable location eligibility.
                </p>
              ) : (
                <p>NON-RESTOCK does not increase sellable inventory.</p>
              )}
              {!review ? (
                <button
                  className="button"
                  disabled={!connected || locked || !valid}
                  onClick={() => setReview(true)}
                >
                  Review return
                </button>
              ) : (
                <div className="return-review">
                  <h3>Confirm received merchandise</h3>
                  <ul>
                    {lines.map((line) => (
                      <li key={line.orderLineId}>
                        {itemName(
                          eligibility.lines.find((item) => item.orderLineId === line.orderLineId)!
                            .lineNumber,
                        )}{" "}
                        · Quantity {line.quantity} ·{" "}
                        {line.disposition === "restock" ? "RESTOCK" : "NON-RESTOCK"} · {line.reason}
                      </li>
                    ))}
                  </ul>
                  <p>
                    Confirm that these items have been received and accepted. The API calculates the
                    exact refund when it accepts the return. A pending refund will be recorded;
                    review its amount before handing back cash.
                  </p>
                  <button disabled={!connected || locked} onClick={() => setReview(false)}>
                    Edit return
                  </button>
                  <button
                    className="button"
                    disabled={!connected || locked || activeWorkflow || !valid}
                    onClick={() => void submit("create")}
                  >
                    Confirm return
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
                  <h3>Record cash refund</h3>
                  <p>
                    Only after handing back exactly{" "}
                    {formatMoney(result.refund.amountMinor, result.refund.currency)}, record the
                    completed payment below. Server authorization and policy apply.
                  </p>
                  <label>
                    Settlement reference
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
                    I have handed back the displayed cash amount.
                  </label>
                  <button
                    className="button"
                    disabled={!connected || locked || !cashConfirmed || !reference.trim()}
                    onClick={() => void submit("settle")}
                  >
                    {uncertain === "settle"
                      ? "Retry exact cash confirmation"
                      : "Record cash refund"}
                  </button>
                </div>
              ) : null}
              <button
                disabled={!connected || locked}
                onClick={() => void read(async () => setResult(await client.getReturn(result.id)))}
              >
                Refresh refund result
              </button>
            </>
          )}
          <details>
            <summary>Previous returns for this order</summary>
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
                Load more returns
              </button>
            ) : null}
            {history.length === 0 ? <p>No previous returns in the loaded history.</p> : null}
          </details>
          {history.length > 0 && !result ? (
            <fieldset disabled={!connected || locked || activeWorkflow}>
              <legend>Open previous return result</legend>
              {history.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setResult(item);
                    setReference("");
                    setCashConfirmed(false);
                  }}
                >
                  {item.createdAt} · {formatMoney(item.refund.amountMinor, item.refund.currency)} ·{" "}
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
