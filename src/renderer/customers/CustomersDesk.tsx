import type {
  CustomerDetailResponse,
  CustomerListResponse,
  CustomerOrdersResponse,
  OrderSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney } from "../money";
import { SkeletonLines } from "../shell/Skeleton";

type CustomerItem = CustomerListResponse["items"][number];

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};

function statusPill(status: "placed" | "cancelled") {
  return (
    <span className={`pill ${status === "cancelled" ? "pill--bad" : "pill--good"}`}>{status}</span>
  );
}

export function CustomersDesk({
  client,
  currency,
}: {
  client: TenantCommerceClient;
  currency: string;
}) {
  const [list, setList] = useState<CustomerListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetailResponse | null>(null);
  const [orders, setOrders] = useState<CustomerOrdersResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Server-side search by name/phone; debounced so typing doesn't spam the API.
  const loadList = useCallback(
    async (search: string) => {
      setListLoading(true);
      setListError(null);
      try {
        setList(
          await client.listCustomers({
            ...(search.trim() !== "" ? { search: search.trim() } : {}),
            limit: 50,
          }),
        );
      } catch (err) {
        setListError(classifyCommerceError(err).message);
      } finally {
        setListLoading(false);
      }
    },
    [client],
  );

  const firstLoad = useRef(true);
  useEffect(() => {
    const delay = firstLoad.current ? 0 : 350;
    firstLoad.current = false;
    const handle = window.setTimeout(() => void loadList(query), delay);
    return () => window.clearTimeout(handle);
  }, [query, loadList]);

  const loadMore = useCallback(async () => {
    if (!list?.pageInfo.hasMore) return;
    try {
      const next = await client.listCustomers({
        ...(query.trim() !== "" ? { search: query.trim() } : {}),
        limit: 50,
        cursor: list.pageInfo.nextCursor ?? undefined,
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setListError(classifyCommerceError(err).message);
    }
  }, [client, list, query]);

  const openCustomer = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      setOrders(null);
      try {
        const [profile, history] = await Promise.all([
          client.getCustomer(id),
          client.listCustomerOrders(id, { limit: 50 }),
        ]);
        setDetail(profile);
        setOrders(history);
      } catch (err) {
        setDetailError(classifyCommerceError(err).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [client],
  );

  const loadMoreOrders = useCallback(async () => {
    if (!selectedId || !orders?.pageInfo.hasMore) return;
    const next = await client.listCustomerOrders(selectedId, {
      limit: 50,
      cursor: orders.pageInfo.nextCursor ?? undefined,
    });
    setOrders({ ...next, items: [...orders.items, ...next.items] });
  }, [client, selectedId, orders]);

  const items: readonly CustomerItem[] = list?.items ?? [];

  return (
    <main className="orders-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">People</p>
          <h1>Customers</h1>
        </div>
        <div className="staff-filters">
          <label>
            Search name or phone
            <input
              value={query}
              placeholder="Jane or +20100…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="button button--quiet" onClick={() => void loadList(query)}>
            Refresh
          </button>
        </div>
      </header>

      {listError ? (
        <div className="notice notice--error" role="alert">
          <span>{listError}</span>
          <button className="button button--quiet" onClick={() => void loadList(query)}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="orders-layout">
        <section className="orders-list staff-card">
          <div className="staff-card__head">
            <h2>All customers</h2>
            <span>{list ? `${list.items.length} loaded` : ""}</span>
          </div>
          <div className="orders-list__body">
            {listLoading ? <SkeletonLines lines={6} label="Loading customers" /> : null}
            {!listLoading && items.length === 0 ? (
              <p className="staff-empty">
                {query.trim() === "" ? "No customers yet." : `No customer matches “${query}”.`}
              </p>
            ) : null}
            {items.map((customer) => (
              <button
                key={customer.id}
                type="button"
                className={`orders-row${customer.id === selectedId ? " orders-row--active" : ""}`}
                onClick={() => void openCustomer(customer.id)}
              >
                <span className="orders-row__top">
                  <strong>{customer.name}</strong>
                  <strong>
                    {formatMoney(customer.totalSpentMinor, customer.currency ?? currency)}
                  </strong>
                </span>
                <span className="orders-row__meta">
                  <span className="muted">{customer.phone}</span>
                  <span className="pill">
                    {customer.orderCount} order{customer.orderCount === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            ))}
            {list?.pageInfo.hasMore ? (
              <button className="button button--quiet orders-more" onClick={() => void loadMore()}>
                Load more customers
              </button>
            ) : null}
          </div>
        </section>

        <section className="orders-detail">
          {!selectedId ? (
            <div className="staff-card">
              <p className="staff-empty">Select a customer to see their profile and purchases.</p>
            </div>
          ) : detailLoading ? (
            <div className="staff-card">
              <SkeletonLines lines={5} label="Loading customer" />
            </div>
          ) : detailError ? (
            <div className="notice notice--error" role="alert">
              <span>{detailError}</span>
              <button
                className="button button--quiet"
                onClick={() => selectedId && void openCustomer(selectedId)}
              >
                Retry
              </button>
            </div>
          ) : detail ? (
            <CustomerDetail
              customer={detail}
              orders={orders}
              fallbackCurrency={currency}
              onLoadMore={() => void loadMoreOrders()}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}

function CustomerDetail({
  customer,
  orders,
  fallbackCurrency,
  onLoadMore,
}: {
  customer: CustomerDetailResponse;
  orders: CustomerOrdersResponse | null;
  fallbackCurrency: string;
  onLoadMore: () => void;
}) {
  const currency = customer.currency ?? fallbackCurrency;
  const items: readonly OrderSummary[] = orders?.items ?? [];
  return (
    <article className="order-detail">
      <header className="order-detail__head">
        <div>
          <p className="eyebrow">Customer</p>
          <h2>{customer.name}</h2>
          <p className="muted">
            {customer.phone}
            {customer.email ? ` · ${customer.email}` : ""}
          </p>
          <p className="muted">Customer since {fmtDate(customer.createdAt)}</p>
        </div>
      </header>

      <div className="voucher-stats">
        <div className="voucher-stat">
          <strong>{customer.orderCount}</strong>
          <span>Orders</span>
        </div>
        <div className="voucher-stat voucher-stat--accent">
          <strong>{formatMoney(customer.totalSpentMinor, currency)}</strong>
          <span>Lifetime spend</span>
        </div>
        <div className="voucher-stat">
          <strong>{customer.lastOrderAt ? fmtDate(customer.lastOrderAt) : "—"}</strong>
          <span>Last order</span>
        </div>
      </div>

      <section className="order-card">
        <h3>Purchase history</h3>
        {items.length === 0 ? (
          <p className="muted">No orders recorded for this customer.</p>
        ) : (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="end">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>#{order.orderNumber}</strong>
                    </td>
                    <td>
                      <span className="pill">{order.channel}</span>
                    </td>
                    <td>{statusPill(order.status)}</td>
                    <td className="muted">{fmtDateTime(order.placedAt)}</td>
                    <td className="end">
                      <strong>{formatMoney(order.totalMinor, order.currency)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {orders?.pageInfo.hasMore ? (
          <button className="button button--quiet orders-more" onClick={onLoadMore}>
            Load more orders
          </button>
        ) : null}
      </section>
    </article>
  );
}
