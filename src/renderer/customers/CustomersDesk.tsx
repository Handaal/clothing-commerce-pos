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
import { formatDate, formatDateTime } from "../format";
import type { ReceiptIdentity } from "../pos/receipt-identity";
import { useI18n, type TVars } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { OrderReceiptModal } from "./OrderReceiptModal";

type CustomerItem = CustomerListResponse["items"][number];
type T = (key: string, vars?: TVars) => string;

function statusPill(status: "placed" | "cancelled", t: T) {
  return (
    <span className={`pill ${status === "cancelled" ? "pill--bad" : "pill--good"}`}>
      {t(`orders.status.${status}`)}
    </span>
  );
}

export function CustomersDesk({
  client,
  currency,
  identity = null,
}: {
  client: TenantCommerceClient;
  currency: string;
  // Business/branch identity for reprinted receipts; null when POS context has not resolved yet.
  identity?: ReceiptIdentity | null;
}) {
  const { t, locale } = useI18n();
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
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
          <p className="eyebrow">{t("customers.people")}</p>
          <h1>{t("nav.customers")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            {t("customers.searchLabel")}
            <input
              value={query}
              placeholder={t("customers.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="button button--quiet" onClick={() => void loadList(query)}>
            {t("orders.refresh")}
          </button>
        </div>
      </header>

      {listError ? (
        <div className="notice notice--error" role="alert">
          <span>{listError}</span>
          <button className="button button--quiet" onClick={() => void loadList(query)}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="orders-layout">
        <section className="orders-list staff-card">
          <div className="staff-card__head">
            <h2>{t("customers.all")}</h2>
            <span>{list ? t("orders.loaded", { count: list.items.length }) : ""}</span>
          </div>
          <div className="orders-list__body">
            {listLoading ? <SkeletonLines lines={6} label={t("customers.loading")} /> : null}
            {!listLoading && items.length === 0 ? (
              <p className="staff-empty">
                {query.trim() === "" ? t("customers.none") : t("customers.noMatch", { query })}
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
                    {formatMoney(customer.totalSpentMinor, customer.currency ?? currency, locale)}
                  </strong>
                </span>
                <span className="orders-row__meta">
                  <span className="muted">{customer.phone}</span>
                  <span className="pill">
                    {t("customers.orderCount", { count: customer.orderCount })}
                  </span>
                </span>
              </button>
            ))}
            {list?.pageInfo.hasMore ? (
              <button className="button button--quiet orders-more" onClick={() => void loadMore()}>
                {t("customers.loadMore")}
              </button>
            ) : null}
          </div>
        </section>

        <section className="orders-detail">
          {!selectedId ? (
            <div className="staff-card">
              <p className="staff-empty">{t("customers.selectPrompt")}</p>
            </div>
          ) : detailLoading ? (
            <div className="staff-card">
              <SkeletonLines lines={5} label={t("customers.loadingOne")} />
            </div>
          ) : detailError ? (
            <div className="notice notice--error" role="alert">
              <span>{detailError}</span>
              <button
                className="button button--quiet"
                onClick={() => selectedId && void openCustomer(selectedId)}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : detail ? (
            <CustomerDetail
              customer={detail}
              orders={orders}
              fallbackCurrency={currency}
              onLoadMore={() => void loadMoreOrders()}
              onOpenReceipt={setReceiptOrderId}
            />
          ) : null}
        </section>
      </div>

      {receiptOrderId ? (
        <OrderReceiptModal
          client={client}
          orderId={receiptOrderId}
          identity={identity}
          onClose={() => setReceiptOrderId(null)}
        />
      ) : null}
    </main>
  );
}

function CustomerDetail({
  customer,
  orders,
  fallbackCurrency,
  onLoadMore,
  onOpenReceipt,
}: {
  customer: CustomerDetailResponse;
  orders: CustomerOrdersResponse | null;
  fallbackCurrency: string;
  onLoadMore: () => void;
  onOpenReceipt: (orderId: string) => void;
}) {
  const { t, locale } = useI18n();
  const currency = customer.currency ?? fallbackCurrency;
  const items: readonly OrderSummary[] = orders?.items ?? [];
  return (
    <article className="order-detail">
      <header className="order-detail__head">
        <div>
          <p className="eyebrow">{t("orders.customer")}</p>
          <h2>{customer.name}</h2>
          <p className="muted">
            {customer.phone}
            {customer.email ? ` · ${customer.email}` : ""}
          </p>
          <p className="muted">
            {t("customers.since", { date: formatDate(customer.createdAt, locale) })}
          </p>
        </div>
      </header>

      <div className="voucher-stats">
        <div className="voucher-stat">
          <strong>{customer.orderCount}</strong>
          <span>{t("customers.orders")}</span>
        </div>
        <div className="voucher-stat voucher-stat--accent">
          <strong>{formatMoney(customer.totalSpentMinor, currency, locale)}</strong>
          <span>{t("customers.lifetimeSpend")}</span>
        </div>
        <div className="voucher-stat">
          <strong>{customer.lastOrderAt ? formatDate(customer.lastOrderAt, locale) : "—"}</strong>
          <span>{t("customers.lastOrder")}</span>
        </div>
      </div>

      <section className="order-card">
        <h3>{t("customers.purchaseHistory")}</h3>
        {items.length === 0 ? (
          <p className="muted">{t("customers.noOrders")}</p>
        ) : (
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("orders.order")}</th>
                  <th>{t("customers.channel")}</th>
                  <th>{t("orders.statusLabel")}</th>
                  <th>{t("customers.date")}</th>
                  <th className="end">{t("cashier.total")}</th>
                  <th className="end">{t("staff.actions")}</th>
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
                    <td>{statusPill(order.status, t)}</td>
                    <td className="muted">{formatDateTime(order.placedAt, locale)}</td>
                    <td className="end">
                      <strong>{formatMoney(order.totalMinor, order.currency, locale)}</strong>
                    </td>
                    <td className="end">
                      <button
                        type="button"
                        className="row-action"
                        onClick={() => onOpenReceipt(order.id)}
                      >
                        {t("customers.viewReceipt")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {orders?.pageInfo.hasMore ? (
          <button className="button button--quiet orders-more" onClick={onLoadMore}>
            {t("customers.loadMore")}
          </button>
        ) : null}
      </section>
    </article>
  );
}
