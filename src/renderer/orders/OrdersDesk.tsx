import type {
  OrderDetailResponse,
  OrderListResponse,
  ReturnDetailResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney } from "../money";
import { SkeletonLines } from "../shell/Skeleton";

type OrderListItem = OrderListResponse["items"][number];

// Cashier-facing labels for the payment methods the order API reports.
const PAYMENT_METHOD_LABELS: Record<"cash" | "cash_on_delivery" | "electronic", string> = {
  cash: "Cash",
  cash_on_delivery: "Cash on delivery",
  electronic: "Electronic",
};

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function statusPill(status: "placed" | "cancelled") {
  return (
    <span className={`pill ${status === "cancelled" ? "pill--bad" : "pill--good"}`}>{status}</span>
  );
}

function fulfillmentPill(status: "unfulfilled" | "partially_fulfilled" | "fulfilled") {
  const cls =
    status === "fulfilled"
      ? "pill--good"
      : status === "partially_fulfilled"
        ? "pill--warn"
        : "pill";
  const label =
    status === "fulfilled"
      ? "Fulfilled"
      : status === "partially_fulfilled"
        ? "Partially fulfilled"
        : "Unfulfilled";
  return <span className={`pill ${cls}`}>{label}</span>;
}

function refundPill(status: "pending" | "failed" | "succeeded") {
  const cls =
    status === "succeeded" ? "pill--good" : status === "failed" ? "pill--bad" : "pill--warn";
  return <span className={`pill ${cls}`}>{status}</span>;
}

export function OrdersDesk({ client }: { client: TenantCommerceClient }) {
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

  const openOrder = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetailLoading(true);
      setDetailError(null);
      setOrder(null);
      setReturns([]);
      setReturnsRestricted(false);
      try {
        // The order detail is the required read. The full per-return breakdown needs the separate
        // `returns.read` permission, so it is fetched independently and degrades to the embedded
        // returns summary (or a notice) when the operator is not authorized for return history.
        const detail = await client.getOrder(id);
        setOrder(detail);
        try {
          const returnList = await client.listReturns(id);
          setReturns(returnList.items);
        } catch (returnErr) {
          if (classifyCommerceError(returnErr).kind === "forbidden") {
            setReturnsRestricted(true);
          } else {
            throw returnErr;
          }
        }
      } catch (err) {
        setDetailError(classifyCommerceError(err).message);
      } finally {
        setDetailLoading(false);
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
          <p className="eyebrow">Sales</p>
          <h1>Orders</h1>
        </div>
        <div className="staff-filters">
          <label>
            Search order number
            <input
              value={query}
              placeholder="e.g. 1042"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="button button--quiet" onClick={() => void loadFirstPage()}>
            Refresh
          </button>
        </div>
      </header>

      {listError ? (
        <div className="notice notice--error" role="alert">
          <span>{listError}</span>
          <button className="button button--quiet" onClick={() => void loadFirstPage()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="orders-layout">
        <section className="orders-list staff-card">
          <div className="staff-card__head">
            <h2>All orders</h2>
            <span>{list ? `${list.items.length} loaded` : ""}</span>
          </div>
          <div className="orders-list__body">
            {listLoading ? <SkeletonLines lines={6} label="Loading orders" /> : null}
            {!listLoading && visibleItems.length === 0 ? (
              <p className="staff-empty">
                {normalizedQuery === "" ? "No orders yet." : `No order matches “${query}”.`}
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
                  <strong>Order {item.orderNumber}</strong>
                  <strong>{formatMoney(item.totalMinor, item.currency)}</strong>
                </span>
                <span className="orders-row__meta">
                  <span className="pill">{item.channel}</span>
                  {statusPill(item.status)}
                  <span className="muted">{fmtDateTime(item.placedAt)}</span>
                </span>
              </button>
            ))}
            {list?.pageInfo.hasMore ? (
              <button className="button button--quiet orders-more" onClick={() => void loadMore()}>
                Load more orders
              </button>
            ) : null}
          </div>
        </section>

        <section className="orders-detail">
          {!selectedId ? (
            <div className="staff-card">
              <p className="staff-empty">Select an order to see its full detail.</p>
            </div>
          ) : detailLoading ? (
            <div className="staff-card">
              <SkeletonLines lines={5} label="Loading order" />
            </div>
          ) : detailError ? (
            <div className="notice notice--error" role="alert">
              <span>{detailError}</span>
              <button
                className="button button--quiet"
                onClick={() => selectedId && void openOrder(selectedId)}
              >
                Retry
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
  const currency = order.header.currency;
  const money = (minor: number) => formatMoney(minor, currency);
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
          <p className="eyebrow">Order</p>
          <h2>{order.header.orderNumber}</h2>
          <p className="muted">{fmtDateTime(order.header.placedAt)}</p>
        </div>
        <div className="order-detail__badges">
          <span className="pill">{order.header.channel}</span>
          {statusPill(order.header.status)}
          {fulfillmentPill(order.fulfillmentProgress.status)}
        </div>
      </header>

      {order.cancellation ? (
        <div className="notice notice--warning" role="status">
          <strong>Cancelled</strong>
          <span>
            {fmtDateTime(order.cancellation.cancelledAt)}
            {order.cancellation.reason ? ` · ${order.cancellation.reason}` : ""}
          </span>
        </div>
      ) : null}

      <div className="order-detail__grid">
        <section className="order-card">
          <h3>Customer</h3>
          {commerce?.customer ? (
            <dl className="order-kv">
              <div>
                <dt>Name</dt>
                <dd>{commerce.customer.name}</dd>
              </div>
              {commerce.customer.email ? (
                <div>
                  <dt>Email</dt>
                  <dd>{commerce.customer.email}</dd>
                </div>
              ) : null}
              <div>
                <dt>Phone</dt>
                <dd>{commerce.customer.phone}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Walk-in — no customer on file.</p>
          )}
        </section>

        <section className="order-card">
          <h3>Delivery</h3>
          {commerce?.delivery ? (
            <address className="order-address">
              <strong>{commerce.delivery.recipientName}</strong>
              <span>{commerce.delivery.phone}</span>
              <span>{commerce.delivery.line1}</span>
              {commerce.delivery.line2 ? <span>{commerce.delivery.line2}</span> : null}
              <span>
                {[commerce.delivery.city, commerce.delivery.region, commerce.delivery.postalCode]
                  .filter(Boolean)
                  .join(", ")}
              </span>
              <span>{commerce.delivery.countryCode}</span>
              {commerce.delivery.notes ? (
                <span className="muted">{commerce.delivery.notes}</span>
              ) : null}
            </address>
          ) : (
            <p className="muted">In-store collection — no delivery address.</p>
          )}
        </section>

        <section className="order-card">
          <h3>Payment</h3>
          {commerce?.payment ? (
            <dl className="order-kv">
              <div>
                <dt>Method</dt>
                <dd>{PAYMENT_METHOD_LABELS[commerce.payment.method]}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="pill">{commerce.payment.status}</span>
                </dd>
              </div>
              {commerce.payment.provider ? (
                <div>
                  <dt>Provider</dt>
                  <dd>{commerce.payment.provider}</dd>
                </div>
              ) : null}
              <div>
                <dt>Amount</dt>
                <dd>{formatMoney(commerce.payment.amountMinor, commerce.payment.currency)}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">No payment record on this order.</p>
          )}
        </section>
      </div>

      <section className="order-card">
        <h3>Items</h3>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th className="end">Qty</th>
                <th className="end">Fulfilled</th>
                <th className="end">Returned</th>
                <th className="end">Unit</th>
                <th className="end">Line total</th>
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
                      <small>SKU {line.sku}</small>
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
            <span>Gross subtotal</span>
            <strong>{money(grossSubtotalMinor)}</strong>
          </div>
          {discountMinor > 0 ? (
            <div className="order-totals__discount">
              <span>Discount</span>
              <strong>−{money(discountMinor)}</strong>
            </div>
          ) : null}
          <div className="order-totals__due">
            <span>Total</span>
            <strong>{money(order.header.totalMinor)}</strong>
          </div>
        </div>
      </section>

      <section className="order-card">
        <h3>
          Returns
          {order.returns &&
          (order.returns.pendingRefundMinor > 0 || order.returns.refundedMinor > 0) ? (
            <span className="order-returns__summary">
              {order.returns.refundedMinor > 0
                ? ` Refunded ${money(order.returns.refundedMinor)}`
                : ""}
              {order.returns.pendingRefundMinor > 0
                ? `${order.returns.refundedMinor > 0 ? " ·" : ""} Pending ${money(order.returns.pendingRefundMinor)}`
                : ""}
            </span>
          ) : null}
        </h3>
        {returnsRestricted ? (
          <p className="muted">
            Return history requires the returns-read permission, which this operator does not have.
          </p>
        ) : returns.length === 0 ? (
          <p className="muted">No returns against this order.</p>
        ) : (
          <div className="order-returns">
            {returns.map((ret) => (
              <article className="order-return" key={ret.id}>
                <div className="order-return__head">
                  <strong>{fmtDateTime(ret.createdAt)}</strong>
                  <span>
                    {refundPill(ret.refund.status)}
                    <span className="order-return__amount">
                      {formatMoney(ret.refund.amountMinor, ret.refund.currency)}
                    </span>
                  </span>
                </div>
                <p className="muted">
                  {PAYMENT_METHOD_LABELS[ret.refund.method]} refund · {ret.source}
                  {ret.refund.settlementReference ? ` · ref ${ret.refund.settlementReference}` : ""}
                  {ret.refund.settledAt ? ` · settled ${fmtDateTime(ret.refund.settledAt)}` : ""}
                </p>
                <ul className="order-return__lines">
                  {ret.lines.map((line) => (
                    <li key={line.orderLineId}>
                      Line {line.lineNumber} · Qty {line.quantity} ·{" "}
                      {line.disposition === "restock" ? "RESTOCK" : "NON-RESTOCK"} · {line.reason} ·{" "}
                      {formatMoney(line.amountMinor, ret.currency)}
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
