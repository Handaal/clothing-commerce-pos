import type {
  OrderDetailResponse,
  OrderSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { useModalA11y } from "../shell/useModalA11y";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { MAX_PAGES } from "./access";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeWebsiteError } from "./errors";

export type OnlineOrdersClient = Pick<
  TenantCommerceClient,
  "listOrders" | "getOrder" | "fulfillOrder" | "cancelOrder"
>;

export type OnlineOrderView = "toFulfil" | "fulfilled" | "cancelled" | "all";
type FulfillmentStatus = OrderDetailResponse["fulfillmentProgress"]["status"];
type DetailState = OrderDetailResponse | "error";

/** Every online order (newest first), following the cursor to completion (fails closed at the bound). */
export async function loadOnlineOrders(
  client: Pick<TenantCommerceClient, "listOrders">,
  maxPages = MAX_PAGES,
): Promise<OrderSummary[]> {
  const items: OrderSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await client.listOrders({
      channel: "online",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...response.items);
    if (!response.pageInfo.hasMore || response.pageInfo.nextCursor === null) return items;
    cursor = response.pageInfo.nextCursor;
  }
  throw new Error("The order list is larger than this screen can load.");
}

/** Which queue an order belongs in. `null` fulfillment = detail not loaded yet (treated as pending). */
export function orderView(
  order: Pick<OrderSummary, "status">,
  fulfillment: FulfillmentStatus | null,
): Exclude<OnlineOrderView, "all"> {
  if (order.status === "cancelled") return "cancelled";
  return fulfillment === "fulfilled" ? "fulfilled" : "toFulfil";
}

/** Lines still to ship: ordered minus already fulfilled, per line number (only lines with a remainder). */
export function remainingByLine(detail: OrderDetailResponse): Map<number, number> {
  const fulfilled = new Map(
    detail.fulfillmentProgress.lines.map((line) => [line.lineNumber, line.fulfilledQuantity]),
  );
  const remaining = new Map<number, number>();
  for (const line of detail.lines) {
    const left = line.quantity - (fulfilled.get(line.lineNumber) ?? 0);
    if (left > 0) remaining.set(line.lineNumber, left);
  }
  return remaining;
}

const DETAIL_CONCURRENCY = 4;

// Online orders: the fulfilment queue for Storefront orders. Lists every online order the operator can
// read, loads each open order's detail (customer, delivery address, payment, fulfilment progress) and lets
// staff ship items (orders.fulfill + inventory.issue — stock is taken from the location the order's
// reservation holds) or cancel an unshipped order (orders.cancel — releases the held stock). Admin Mobile
// shows the same order data read-only; the API authorizes every action independently.
export function OnlineOrdersPanel({
  client,
  canFulfill,
  canCancel,
}: {
  client: OnlineOrdersClient;
  canFulfill: boolean;
  canCancel: boolean;
}) {
  const { t, locale } = useI18n();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, DetailState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<OnlineOrderView>("toFulfil");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const run = ++generation.current;
    setError(null);
    setOrders(null);
    setDetails(new Map());
    let list: OrderSummary[];
    try {
      list = await loadOnlineOrders(client);
    } catch (err) {
      if (run === generation.current) setError(describeWebsiteError(err, t));
      return;
    }
    if (run !== generation.current) return;
    setOrders(list);
    // Open orders need their detail to know fulfilment progress and who/where to ship to. Cancelled
    // orders are complete as listed; their detail loads on demand when opened.
    const queue = list.filter((order) => order.status === "placed").map((order) => order.id);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        let result: DetailState;
        try {
          result = await client.getOrder(id);
        } catch {
          result = "error";
        }
        if (run !== generation.current) return;
        const settled = result;
        const key = id;
        setDetails((current) => new Map(current).set(key, settled));
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
    return () => {
      // Invalidate the in-flight load (a counter, not a DOM node): late results are dropped on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [load]);

  const fulfillmentOf = useCallback(
    (id: string): FulfillmentStatus | null => {
      const detail = details.get(id);
      return detail && detail !== "error" ? detail.fulfillmentProgress.status : null;
    },
    [details],
  );

  const counts = useMemo(() => {
    const result: Record<OnlineOrderView, number> = {
      toFulfil: 0,
      fulfilled: 0,
      cancelled: 0,
      all: orders?.length ?? 0,
    };
    for (const order of orders ?? []) result[orderView(order, fulfillmentOf(order.id))] += 1;
    return result;
  }, [orders, fulfillmentOf]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = (orders ?? []).filter((order) => {
      if (view !== "all" && orderView(order, fulfillmentOf(order.id)) !== view) return false;
      if (!needle) return true;
      const detail = details.get(order.id);
      const commerce = detail && detail !== "error" ? detail.commerce : undefined;
      return [
        order.orderNumber,
        commerce?.customer?.name,
        commerce?.customer?.phone,
        commerce?.delivery?.phone,
        commerce?.delivery?.city,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
    // The work queue is first-in first-out; the other views read newest first (the API order).
    return view === "toFulfil" ? [...rows].reverse() : rows;
  }, [orders, details, view, query, fulfillmentOf]);

  const onChanged = (detail: OrderDetailResponse) => {
    setDetails((current) => new Map(current).set(detail.header.id, detail));
    setOrders(
      (current) =>
        current?.map((order) =>
          order.id === detail.header.id ? { ...order, status: detail.header.status } : order,
        ) ?? null,
    );
  };

  const views: OnlineOrderView[] = ["toFulfil", "fulfilled", "cancelled", "all"];

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.tab.orders")}</h2>
          <div className="staff-filters">
            <input
              className="input"
              type="search"
              aria-label={t("website.orders.search")}
              placeholder={t("website.orders.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="button button--quiet" onClick={() => void load()}>
              {t("website.orders.refresh")}
            </button>
          </div>
        </div>
        <p className="muted website-card-intro">{t("website.orders.intro")}</p>
        {!canFulfill && !canCancel ? (
          <p className="notice website-card-intro" role="status">
            {t("website.orders.readOnly")}
          </p>
        ) : null}
        <nav className="report-tabs website-orders-views" aria-label={t("website.orders.views")}>
          {views.map((item) => (
            <button
              key={item}
              className={`report-tab${view === item ? " report-tab--active" : ""}`}
              aria-pressed={view === item}
              data-testid={`website-orders-view-${item}`}
              onClick={() => setView(item)}
            >
              {t(`website.orders.view.${item}`)}
              {orders ? <span className="muted"> · {counts[item]}</span> : null}
            </button>
          ))}
        </nav>

        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
            <button className="button button--quiet" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : orders === null ? (
          <SkeletonLines lines={4} label={t("website.orders.loading")} />
        ) : visible.length === 0 ? (
          <p className="staff-empty">
            {query.trim() ? t("website.orders.noMatch") : t(`website.orders.empty.${view}`)}
          </p>
        ) : (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("website.orders.order")}</th>
                  <th>{t("website.orders.placed")}</th>
                  <th>{t("website.orders.customer")}</th>
                  <th>{t("website.orders.city")}</th>
                  <th className="end">{t("website.orders.total")}</th>
                  <th>{t("website.orders.status")}</th>
                  <th className="end">{t("website.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((order) => {
                  const detail = details.get(order.id);
                  const loaded = detail && detail !== "error" ? detail : null;
                  const customer = loaded?.commerce?.customer;
                  return (
                    <tr key={order.id} data-testid={`website-order-${order.id}`}>
                      <td>
                        <strong>#{order.orderNumber}</strong>
                      </td>
                      <td>{formatDateTime(order.placedAt, locale)}</td>
                      <td>
                        {customer ? (
                          <>
                            {customer.name}
                            <br />
                            <span className="muted">{customer.phone}</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {loaded?.commerce?.delivery?.city ?? <span className="muted">—</span>}
                      </td>
                      <td className="end">
                        {formatMoney(order.totalMinor, order.currency, locale)}
                      </td>
                      <td>
                        <StatusPill
                          status={order.status}
                          fulfillment={loaded?.fulfillmentProgress.status ?? null}
                          detailFailed={detail === "error"}
                          pending={order.status === "placed" && detail === undefined}
                        />
                      </td>
                      <td className="end">
                        <button
                          className="link"
                          data-testid={`website-order-open-${order.id}`}
                          onClick={() => setOpenId(order.id)}
                        >
                          {t("website.orders.open")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId ? (
        <OnlineOrderDialog
          client={client}
          orderId={openId}
          initial={(() => {
            const detail = details.get(openId);
            return detail && detail !== "error" ? detail : null;
          })()}
          canFulfill={canFulfill}
          canCancel={canCancel}
          onChanged={onChanged}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}

function StatusPill({
  status,
  fulfillment,
  detailFailed = false,
  pending = false,
}: {
  status: OrderSummary["status"];
  fulfillment: FulfillmentStatus | null;
  detailFailed?: boolean;
  pending?: boolean;
}) {
  const { t } = useI18n();
  if (status === "cancelled") {
    return <span className="pill pill--bad">{t("website.orders.state.cancelled")}</span>;
  }
  if (fulfillment === null) {
    return (
      <span className="pill">
        {pending
          ? t("website.orders.state.checking")
          : detailFailed
            ? t("website.orders.state.unknown")
            : t("website.orders.state.unfulfilled")}
      </span>
    );
  }
  const tone =
    fulfillment === "fulfilled"
      ? " pill--good"
      : fulfillment === "partially_fulfilled"
        ? " pill--warn"
        : "";
  return <span className={`pill${tone}`}>{t(`website.orders.state.${fulfillment}`)}</span>;
}

function OnlineOrderDialog({
  client,
  orderId,
  initial,
  canFulfill,
  canCancel,
  onChanged,
  onClose,
}: {
  client: OnlineOrdersClient;
  orderId: string;
  initial: OrderDetailResponse | null;
  canFulfill: boolean;
  canCancel: boolean;
  onChanged: (detail: OrderDetailResponse) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [detail, setDetail] = useState<OrderDetailResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [ship, setShip] = useState<Record<number, string>>(() =>
    initial ? shipDefaults(initial) : {},
  );
  const [confirm, setConfirm] = useState<"fulfil" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per confirmed intent: a retry after a network failure replays instead of shipping twice.
  const intentKey = useRef<string | null>(null);
  const ref = useModalA11y<HTMLDivElement>(busy || confirm ? () => undefined : onClose);

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await client.getOrder(orderId);
      setDetail(fresh);
      setShip(shipDefaults(fresh));
      onChanged(fresh);
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
    // onChanged is a parent callback recreated each render; reloading on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, orderId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const remaining = useMemo(() => (detail ? remainingByLine(detail) : new Map()), [detail]);
  const fulfilledByLine = useMemo(
    () =>
      new Map(
        (detail?.fulfillmentProgress.lines ?? []).map((line) => [
          line.lineNumber,
          line.fulfilledQuantity,
        ]),
      ),
    [detail],
  );

  const shipLines = useMemo(() => {
    const lines: { lineNumber: number; quantity: number }[] = [];
    let invalid = false;
    for (const [lineNumber, left] of remaining) {
      const raw = (ship[lineNumber] ?? "").trim();
      if (raw === "" || raw === "0") continue;
      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > left) {
        invalid = true;
        continue;
      }
      lines.push({ lineNumber, quantity });
    }
    return { lines, invalid, units: lines.reduce((sum, line) => sum + line.quantity, 0) };
  }, [remaining, ship]);

  const placed = detail?.header.status === "placed";
  const canShipNow = Boolean(placed && canFulfill && remaining.size > 0);
  const canCancelNow = Boolean(
    placed && canCancel && detail?.fulfillmentProgress.status === "unfulfilled",
  );

  const openConfirm = (kind: "fulfil" | "cancel") => {
    intentKey.current = crypto.randomUUID();
    setConfirm(kind);
  };

  const run = async (kind: "fulfil" | "cancel") => {
    if (!detail) return;
    setBusy(true);
    try {
      const idempotencyKey = intentKey.current ?? crypto.randomUUID();
      const next =
        kind === "fulfil"
          ? await client.fulfillOrder({ orderId, idempotencyKey, lines: shipLines.lines })
          : await client.cancelOrder({
              orderId,
              idempotencyKey,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
      intentKey.current = null;
      setDetail(next);
      setShip(shipDefaults(next));
      setConfirm(null);
      setReason("");
      onChanged(next);
      toast.success(
        kind === "fulfil"
          ? next.fulfillmentProgress.status === "fulfilled"
            ? t("website.orders.fulfilledToast", { number: next.header.orderNumber })
            : t("website.orders.partialToast", { number: next.header.orderNumber })
          : t("website.orders.cancelledToast", { number: next.header.orderNumber }),
      );
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const commerce = detail?.commerce;
  const customer = commerce?.customer;
  const delivery = commerce?.delivery;
  const payment = commerce?.payment;
  const money = (minor: number) => formatMoney(minor, detail?.header.currency, locale);

  return (
    <>
      <div
        className="staff-modal__scrim"
        role="presentation"
        onClick={busy || confirm ? undefined : onClose}
      >
        <div
          className="staff-modal settings-modal website-promo-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby="website-order-title"
          ref={ref}
          data-testid="website-order-detail"
          onClick={(event) => event.stopPropagation()}
        >
          <h3 id="website-order-title">
            {detail
              ? t("website.orders.detailTitle", { number: detail.header.orderNumber })
              : t("website.orders.loadingOne")}
          </h3>

          {error ? (
            <div className="notice notice--error" role="alert">
              <span>{error}</span>
              <button className="button button--quiet" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : null}

          {!detail ? (
            error ? null : (
              <SkeletonLines lines={5} label={t("website.orders.loadingOne")} />
            )
          ) : (
            <>
              <div className="website-promo-headline">
                <StatusPill
                  status={detail.header.status}
                  fulfillment={detail.fulfillmentProgress.status}
                />
                <span className="muted">{formatDateTime(detail.header.placedAt, locale)}</span>
                <strong>{money(detail.header.totalMinor)}</strong>
              </div>

              {detail.commerce?.deliveryFeeMinor !== undefined &&
              (detail.commerce.deliveryFeeMinor > 0 || detail.commerce.delivery?.zoneCode) ? (
                <p className="muted" data-testid="online-order-delivery-fee">
                  {t("website.orders.deliveryFee", {
                    area:
                      detail.commerce.delivery?.region ?? detail.commerce.delivery?.zoneCode ?? "",
                    fee:
                      detail.commerce.deliveryFeeMinor === 0
                        ? t("website.orders.deliveryFree")
                        : money(detail.commerce.deliveryFeeMinor),
                  })}
                </p>
              ) : null}

              {detail.cancellation ? (
                <p className="notice notice--warning" role="status">
                  {t("website.orders.cancelledOn", {
                    date: formatDateTime(detail.cancellation.cancelledAt, locale),
                  })}
                  {detail.cancellation.reason ? ` — ${detail.cancellation.reason}` : ""}
                </p>
              ) : null}

              {payment?.method === "cash_on_delivery" && payment.status === "pending" && placed ? (
                <p className="notice" role="status" data-testid="website-order-cod">
                  {t("website.orders.codCollect", {
                    amount: formatMoney(payment.amountMinor, payment.currency, locale),
                  })}
                </p>
              ) : null}

              <div className="website-order-grid">
                <section>
                  <h4>{t("website.orders.customer")}</h4>
                  {customer ? (
                    <dl className="order-kv">
                      <Row label={t("website.orders.name")}>{customer.name}</Row>
                      <Row label={t("website.orders.phone")}>{customer.phone}</Row>
                      {customer.email ? (
                        <Row label={t("website.orders.email")}>{customer.email}</Row>
                      ) : null}
                    </dl>
                  ) : (
                    <p className="muted">{t("website.orders.noCustomer")}</p>
                  )}
                </section>
                <section>
                  <h4>{t("website.orders.delivery")}</h4>
                  {delivery ? (
                    <dl className="order-kv" data-testid="website-order-delivery">
                      <Row label={t("website.orders.recipient")}>{delivery.recipientName}</Row>
                      <Row label={t("website.orders.phone")}>{delivery.phone}</Row>
                      <Row label={t("website.orders.address")}>
                        {[delivery.line1, delivery.line2].filter(Boolean).join(", ")}
                      </Row>
                      <Row label={t("website.orders.city")}>
                        {[delivery.city, delivery.region, delivery.postalCode]
                          .filter(Boolean)
                          .join(", ")}
                      </Row>
                      <Row label={t("website.orders.country")}>{delivery.countryCode}</Row>
                      {delivery.notes ? (
                        <Row label={t("website.orders.notes")}>{delivery.notes}</Row>
                      ) : null}
                    </dl>
                  ) : (
                    <p className="muted">{t("website.orders.noDelivery")}</p>
                  )}
                </section>
                <section>
                  <h4>{t("website.orders.payment")}</h4>
                  {payment ? (
                    <dl className="order-kv">
                      <Row label={t("website.orders.method")}>
                        {t(`website.orders.method.${payment.method}`)}
                      </Row>
                      <Row label={t("website.orders.paymentStatus")}>{payment.status}</Row>
                      <Row label={t("website.orders.amount")}>
                        {formatMoney(payment.amountMinor, payment.currency, locale)}
                      </Row>
                    </dl>
                  ) : (
                    <p className="muted">{t("website.orders.noPayment")}</p>
                  )}
                </section>
              </div>

              <h4>{t("website.orders.items")}</h4>
              <div className="staff-table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>{t("website.orders.item")}</th>
                      <th>{t("website.orders.sku")}</th>
                      <th className="end">{t("website.orders.qty")}</th>
                      <th className="end">{t("website.orders.lineTotal")}</th>
                      <th className="end">{t("website.orders.shipped")}</th>
                      {canShipNow ? <th className="end">{t("website.orders.shipNow")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const left = remaining.get(line.lineNumber) ?? 0;
                      return (
                        <tr key={line.lineNumber}>
                          <td>{line.productName}</td>
                          <td className="muted">{line.sku}</td>
                          <td className="end">{line.quantity}</td>
                          <td className="end">{money(line.lineTotalMinor)}</td>
                          <td className="end">
                            {fulfilledByLine.get(line.lineNumber) ?? 0} / {line.quantity}
                          </td>
                          {canShipNow ? (
                            <td className="end">
                              {left > 0 ? (
                                <input
                                  className="input website-order-qty"
                                  type="number"
                                  min={0}
                                  max={left}
                                  step={1}
                                  inputMode="numeric"
                                  aria-label={t("website.orders.shipQtyFor", {
                                    item: line.productName,
                                  })}
                                  data-testid={`website-order-ship-${line.lineNumber}`}
                                  value={ship[line.lineNumber] ?? ""}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setShip((current) => ({
                                      ...current,
                                      [line.lineNumber]: event.target.value,
                                    }))
                                  }
                                />
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {canShipNow && shipLines.invalid ? (
                <p className="website-field-error" role="alert">
                  {t("website.orders.qtyInvalid")}
                </p>
              ) : null}
              {placed && remaining.size > 0 && !canFulfill ? (
                <p className="notice" role="status">
                  {t("website.orders.noFulfilAccess")}
                </p>
              ) : null}
            </>
          )}

          <div className="staff-modal__actions">
            {canCancelNow ? (
              <button
                className="button button--danger"
                data-testid="website-order-cancel"
                disabled={busy}
                onClick={() => openConfirm("cancel")}
              >
                {t("website.orders.cancelOrder")}
              </button>
            ) : null}
            <button className="button button--quiet" onClick={onClose} disabled={busy}>
              {t("website.orders.close")}
            </button>
            {canShipNow ? (
              <button
                className="button"
                data-testid="website-order-fulfil"
                disabled={busy || shipLines.invalid || shipLines.units === 0}
                onClick={() => openConfirm("fulfil")}
              >
                {shipLines.units > 0 && shipLines.units === sum(remaining)
                  ? t("website.orders.fulfilAll")
                  : t("website.orders.fulfilSelected", { count: shipLines.units })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {confirm === "fulfil" && detail ? (
        <ConfirmDialog
          tone="primary"
          title={t("website.orders.fulfilTitle", { number: detail.header.orderNumber })}
          message={t("website.orders.fulfilMessage", { count: shipLines.units })}
          confirmLabel={t("website.orders.fulfilConfirm")}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run("fulfil")}
        />
      ) : null}

      {confirm === "cancel" && detail ? (
        <ConfirmDialog
          title={t("website.orders.cancelTitle", { number: detail.header.orderNumber })}
          message={t("website.orders.cancelMessage")}
          confirmLabel={t("website.orders.cancelOrder")}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run("cancel")}
        >
          <label className="field">
            <span>{t("website.orders.cancelReason")}</span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              data-testid="website-order-cancel-reason"
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function shipDefaults(detail: OrderDetailResponse): Record<number, string> {
  return Object.fromEntries(
    [...remainingByLine(detail)].map(([lineNumber, left]) => [lineNumber, String(left)]),
  );
}

function sum(values: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
