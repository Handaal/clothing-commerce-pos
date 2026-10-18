import type {
  OrderDetailResponse,
  OrderListResponse,
  ReturnDetailResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney } from "../money";
import { formatDateTime } from "../format";
import { useI18n, type TVars } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";

type OrderListItem = OrderListResponse["items"][number];
type T = (key: string, vars?: TVars) => string;

interface CachedOrderDetail {
  readonly order: OrderDetailResponse;
  readonly returns: readonly ReturnDetailResponse[];
  readonly returnsRestricted: boolean;
}

// Offline-first order detail cache. Keyed by the globally-unique order id, so a previously-viewed
// order renders instantly (no loading skeleton) when re-opened — even after navigating to another
// section and back — while a fresh copy is fetched in the background (stale-while-revalidate). When
// the device is offline, re-opening a cached order still works and the silent refresh simply fails.
// Order ids are unique across the whole system, so there is no cross-tenant collision risk.
const orderDetailCache = new Map<string, CachedOrderDetail>();

// Payment-method labels for the methods the order API reports. The business has no delivery, so the
// SDK's `cash_on_delivery` member never occurs in practice; it falls back to a neutral label rather
// than surfacing delivery wording.
type ApiPaymentMethod = "cash" | "cash_on_delivery" | "electronic";
function paymentMethodLabel(method: ApiPaymentMethod, t: T): string {
  if (method === "cash") return t("pay.method.cash");
  if (method === "electronic") return t("orders.method.electronic");
  return t("orders.method.other");
}

function statusPill(status: "placed" | "cancelled", t: T) {
  return (
    <span className={`pill ${status === "cancelled" ? "pill--bad" : "pill--good"}`}>
      {t(`orders.status.${status}`)}
    </span>
  );
}

function fulfillmentPill(status: "unfulfilled" | "partially_fulfilled" | "fulfilled", t: T) {
  const cls =
    status === "fulfilled"
      ? "pill--good"
      : status === "partially_fulfilled"
        ? "pill--warn"
        : "pill";
  return <span className={`pill ${cls}`}>{t(`orders.fulfillment.${status}`)}</span>;
}

function refundPill(status: "pending" | "failed" | "succeeded", t: T) {
  const cls =
    status === "succeeded" ? "pill--good" : status === "failed" ? "pill--bad" : "pill--warn";
  return <span className={`pill ${cls}`}>{t(`orders.refund.${status}`)}</span>;
}

export function OrdersDesk({ client }: { client: TenantCommerceClient }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<OrderListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderDetailResponse | null>(null);
  const [returns, setReturns] = useState<ReturnDetailResponse[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [returnsRestricted, setReturnsRestricted] = useState(false);

  const loadFirstPage = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      // No channel/status filter: the Orders page lists every order the operator may read.
      setList(await client.listOrders({ limit: 50 }));
    } catch (err) {
      setListError(classifyCommerceError(err).message);
    } finally {
      setListLoading(false);
    }
  }, [client]);

  // Initial load deliberately exposes the loading transition before the async result settles.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!list?.pageInfo.hasMore) return;
    setListError(null);
    try {
      const next = await client.listOrders({
        limit: 50,
        cursor: list.pageInfo.nextCursor ?? undefined,
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setListError(classifyCommerceError(err).message);
    }
  }, [client, list]);

  // Tracks the most recently requested order so a slow response for a previously-clicked order can
  // never overwrite the detail the operator is actually looking at.
  const requestRef = useRef<string | null>(null);

  const openOrder = useCallback(
    async (id: string) => {
      requestRef.current = id;
      setSelectedId(id);
      setDetailError(null);

      const cached = orderDetailCache.get(id);
      if (cached) {
        // Offline-first: paint the cached order immediately, no skeleton, then revalidate silently.
        setOrder(cached.order);
        setReturns([...cached.returns]);
        setReturnsRestricted(cached.returnsRestricted);
        setDetailLoading(false);
      } else {
        setOrder(null);
        setReturns([]);
        setReturnsRestricted(false);
        setDetailLoading(true);
      }

      try {
        // The order detail is the required read. The full per-return breakdown needs the separate
        // `returns.read` permission, so it is fetched independently and degrades to the embedded
        // returns summary (or a notice) when the operator is not authorized for return history.
        const detail = await client.getOrder(id);
        let nextReturns: readonly ReturnDetailResponse[] = [];
        let restricted = false;
        try {
          const returnList = await client.listReturns(id);
          nextReturns = returnList.items;
        } catch (returnErr) {
          if (classifyCommerceError(returnErr).kind === "forbidden") {
            restricted = true;
          } else {
            throw returnErr;
          }
        }
        orderDetailCache.set(id, {
          order: detail,
          returns: nextReturns,
          returnsRestricted: restricted,
        });
        // Ignore a stale response for an order the operator has since navigated away from.
        if (requestRef.current !== id) return;
        setOrder(detail);
        setReturns([...nextReturns]);
        setReturnsRestricted(restricted);
      } catch (err) {
        if (requestRef.current !== id) return;
        // A failed background refresh over a cached order is silent — the operator keeps the last
        // known detail (offline-first). Only a cold open with no cache surfaces the error.
        if (!cached) setDetailError(classifyCommerceError(err).message);
      } finally {
        if (requestRef.current === id) setDetailLoading(false);
      }
    },
    [client],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems: readonly OrderListItem[] =
    list === null
      ? []
      : normalizedQuery === ""
        ? list.items
        : list.items.filter((item) => item.orderNumber.toLowerCase().includes(normalizedQuery));

  return (
    <main className="orders-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("orders.sales")}</p>
          <h1>{t("nav.orders")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            {t("orders.searchLabel")}
            <input
              value={query}
              placeholder={t("orders.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="button button--quiet" onClick={() => void loadFirstPage()}>
            {t("orders.refresh")}
          </button>
        </div>
      </header>

      {listError ? (
        <div className="notice notice--error" role="alert">
          <span>{listError}</span>
          <button className="button button--quiet" onClick={() => void loadFirstPage()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="orders-layout">
        <section className="orders-list staff-card">
          <div className="staff-card__head">
            <h2>{t("orders.allOrders")}</h2>
            <span>{list ? t("orders.loaded", { count: list.items.length }) : ""}</span>
          </div>
          <div className="orders-list__body">
            {listLoading ? <SkeletonLines lines={6} label={t("orders.loadingOrders")} /> : null}
            {!listLoading && visibleItems.length === 0 ? (
              <p className="staff-empty">
                {normalizedQuery === "" ? t("orders.none") : t("orders.noMatch", { query })}
              </p>
            ) : null}
            {visibleItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`orders-row${item.id === selectedId ? " orders-row--active" : ""}`}
                onClick={() => void openOrder(item.id)}
              >
                <span className="orders-row__top">
                  <strong>{t("receipt.order", { number: item.orderNumber })}</strong>
                  <strong>{formatMoney(item.totalMinor, item.currency, locale)}</strong>
                </span>
                <span className="orders-row__meta">
                  <span className="pill">{item.channel}</span>
                  {statusPill(item.status, t)}
                  <span className="muted">{formatDateTime(item.placedAt, locale)}</span>
                </span>
              </button>
            ))}
            {list?.pageInfo.hasMore ? (
              <button className="button button--quiet orders-more" onClick={() => void loadMore()}>
                {t("orders.loadMore")}
              </button>
            ) : null}
          </div>
        </section>

        <section className="orders-detail">
          {!selectedId ? (
            <div className="staff-card">
              <p className="staff-empty">{t("orders.selectPrompt")}</p>
            </div>
          ) : detailLoading ? (
            <div className="staff-card">
              <SkeletonLines lines={5} label={t("orders.loadingOrder")} />
            </div>
          ) : detailError ? (
            <div className="notice notice--error" role="alert">
              <span>{detailError}</span>
              <button
                className="button button--quiet"
                onClick={() => selectedId && void openOrder(selectedId)}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : order ? (
            <OrderDetail order={order} returns={returns} returnsRestricted={returnsRestricted} />
          ) : null}
        </section>
      </div>
    </main>
  );
}

function OrderDetail({
  order,
  returns,
  returnsRestricted,
}: {
  order: OrderDetailResponse;
  returns: readonly ReturnDetailResponse[];
  returnsRestricted: boolean;
}) {
  const { t, locale } = useI18n();
  const currency = order.header.currency;
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const grossSubtotalMinor = order.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const discountMinor = grossSubtotalMinor - order.header.totalMinor;
  const commerce = order.commerce;
  const fulfilledByLine = new Map(
    order.fulfillmentProgress.lines.map((line) => [line.lineNumber, line]),
  );
  const returnedByLine = new Map(
    (order.returns?.lines ?? []).map((line) => [line.lineNumber, line.returnedQuantity]),
  );

  return (
    <article className="order-detail">
      <header className="order-detail__head">
        <div>
          <p className="eyebrow">{t("orders.order")}</p>
          <h2>{order.header.orderNumber}</h2>
          <p className="muted">{formatDateTime(order.header.placedAt, locale)}</p>
        </div>
        <div className="order-detail__badges">
          <span className="pill">{order.header.channel}</span>
          {statusPill(order.header.status, t)}
          {fulfillmentPill(order.fulfillmentProgress.status, t)}
        </div>
      </header>

      {order.cancellation ? (
        <div className="notice notice--warning" role="status">
          <strong>{t("orders.cancelled")}</strong>
          <span>
            {formatDateTime(order.cancellation.cancelledAt, locale)}
            {order.cancellation.reason ? ` · ${order.cancellation.reason}` : ""}
          </span>
        </div>
      ) : null}

      <div className="order-detail__grid">
        <section className="order-card">
          <h3>{t("orders.customer")}</h3>
          {commerce?.customer ? (
            <dl className="order-kv">
              <div>
                <dt>{t("orders.name")}</dt>
                <dd>{commerce.customer.name}</dd>
              </div>
              {commerce.customer.email ? (
                <div>
                  <dt>{t("orders.email")}</dt>
                  <dd>{commerce.customer.email}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("orders.phone")}</dt>
                <dd>{commerce.customer.phone}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">{t("orders.walkIn")}</p>
          )}
        </section>

        <section className="order-card">
          <h3>{t("orders.payment")}</h3>
          {commerce?.payment ? (
            <dl className="order-kv">
              <div>
                <dt>{t("orders.method")}</dt>
                <dd>{paymentMethodLabel(commerce.payment.method, t)}</dd>
              </div>
              <div>
                <dt>{t("orders.statusLabel")}</dt>
                <dd>
                  <span className="pill">{commerce.payment.status}</span>
                </dd>
              </div>
              {commerce.payment.provider ? (
                <div>
                  <dt>{t("orders.provider")}</dt>
                  <dd>{commerce.payment.provider}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("orders.amount")}</dt>
                <dd>
                  {formatMoney(commerce.payment.amountMinor, commerce.payment.currency, locale)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">{t("orders.noPayment")}</p>
          )}
        </section>
      </div>

      <section className="order-card">
        <h3>{t("orders.items")}</h3>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("orders.product")}</th>
                <th className="end">{t("orders.qty")}</th>
                <th className="end">{t("orders.fulfilled")}</th>
                <th className="end">{t("orders.returned")}</th>
                <th className="end">{t("orders.unit")}</th>
                <th className="end">{t("orders.lineTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => {
                const returned = returnedByLine.get(line.lineNumber) ?? 0;
                return (
                  <tr key={line.lineNumber}>
                    <td className="muted">{line.lineNumber}</td>
                    <td>
                      <strong>{line.productName}</strong>
                      <small>{t("cashier.sku", { sku: line.sku })}</small>
                    </td>
                    <td className="end">{line.quantity}</td>
                    <td className="end muted">
                      {fulfilledByLine.get(line.lineNumber)?.fulfilledQuantity ?? 0}
                    </td>
                    <td className={`end ${returned > 0 ? "bad" : "muted"}`}>{returned || "—"}</td>
                    <td className="end">{money(line.unitPriceMinor)}</td>
                    <td className="end">{money(line.lineTotalMinor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="order-totals">
          <div>
            <span>{t("pos.grossSubtotal")}</span>
            <strong>{money(grossSubtotalMinor)}</strong>
          </div>
          {discountMinor > 0 ? (
            <div className="order-totals__discount">
              <span>{t("orders.discount")}</span>
              <strong>−{money(discountMinor)}</strong>
            </div>
          ) : null}
          <div className="order-totals__due">
            <span>{t("cashier.total")}</span>
            <strong>{money(order.header.totalMinor)}</strong>
          </div>
        </div>
      </section>

      <section className="order-card">
        <h3>
          {t("orders.returnsHeading")}
          {order.returns &&
          (order.returns.pendingRefundMinor > 0 || order.returns.refundedMinor > 0) ? (
            <span className="order-returns__summary">
              {order.returns.refundedMinor > 0
                ? ` ${t("orders.refunded", { amount: money(order.returns.refundedMinor) })}`
                : ""}
              {order.returns.pendingRefundMinor > 0
                ? `${order.returns.refundedMinor > 0 ? " ·" : ""} ${t("orders.pending", {
                    amount: money(order.returns.pendingRefundMinor),
                  })}`
                : ""}
            </span>
          ) : null}
        </h3>
        {returnsRestricted ? (
          <p className="muted">{t("orders.returnsRestricted")}</p>
        ) : returns.length === 0 ? (
          <p className="muted">{t("orders.noReturns")}</p>
        ) : (
          <div className="order-returns">
            {returns.map((ret) => (
              <article className="order-return" key={ret.id}>
                <div className="order-return__head">
                  <strong>{formatDateTime(ret.createdAt, locale)}</strong>
                  <span>
                    {refundPill(ret.refund.status, t)}
                    <span className="order-return__amount">
                      {formatMoney(ret.refund.amountMinor, ret.refund.currency, locale)}
                    </span>
                  </span>
                </div>
                <p className="muted">
                  {t("orders.refundLine", { method: paymentMethodLabel(ret.refund.method, t) })} ·{" "}
                  {ret.source}
                  {ret.refund.settlementReference
                    ? ` · ${t("orders.ref", { ref: ret.refund.settlementReference })}`
                    : ""}
                  {ret.refund.settledAt
                    ? ` · ${t("orders.settled", {
                        when: formatDateTime(ret.refund.settledAt, locale),
                      })}`
                    : ""}
                </p>
                <ul className="order-return__lines">
                  {ret.lines.map((line) => (
                    <li key={line.orderLineId}>
                      {t("orders.returnLine", {
                        line: line.lineNumber,
                        qty: line.quantity,
                        disposition:
                          line.disposition === "restock"
                            ? t("orders.restock")
                            : t("orders.nonRestock"),
                        reason: line.reason,
                        amount: formatMoney(line.amountMinor, ret.currency, locale),
                      })}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
