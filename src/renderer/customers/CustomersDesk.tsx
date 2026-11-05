import type {
  CustomerDetailResponse,
  CustomerListResponse,
  CustomerOrdersResponse,
  CustomerPaymentsResponse,
  OrderSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
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
  const [payments, setPayments] = useState<CustomerPaymentsResponse | null>(null);
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
      setPayments(null);
      try {
        const [profile, history, paid] = await Promise.all([
          client.getCustomer(id),
          client.listCustomerOrders(id, { limit: 50 }),
          client.listCustomerPayments(id),
        ]);
        setDetail(profile);
        setOrders(history);
        setPayments(paid);
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
                  {customer.outstandingMinor > 0 ? (
                    <span className="pill pill--bad">
                      {t("customers.balanceDue", {
                        amount: formatMoney(
                          customer.outstandingMinor,
                          customer.currency ?? currency,
                          locale,
                        ),
                      })}
                    </span>
                  ) : (
                    <span className="pill">
                      {t("customers.orderCount", { count: customer.orderCount })}
                    </span>
                  )}
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
              client={client}
              customer={detail}
              orders={orders}
              payments={payments}
              fallbackCurrency={currency}
              onLoadMore={() => void loadMoreOrders()}
              onOpenReceipt={setReceiptOrderId}
              onRecorded={() => {
                if (selectedId) void openCustomer(selectedId);
                void loadList(query);
              }}
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
  client,
  customer,
  orders,
  payments,
  fallbackCurrency,
  onLoadMore,
  onOpenReceipt,
  onRecorded,
}: {
  client: TenantCommerceClient;
  customer: CustomerDetailResponse;
  orders: CustomerOrdersResponse | null;
  payments: CustomerPaymentsResponse | null;
  fallbackCurrency: string;
  onLoadMore: () => void;
  onOpenReceipt: (orderId: string) => void;
  onRecorded: () => void;
}) {
  const { t, locale } = useI18n();
  const currency = customer.currency ?? fallbackCurrency;
  const items: readonly OrderSummary[] = orders?.items ?? [];
  const paymentItems = payments?.items ?? [];
  const [payOpen, setPayOpen] = useState(false);
  const owes = customer.outstandingMinor > 0;
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
        {owes ? (
          <button type="button" className="button button--complete" onClick={() => setPayOpen(true)}>
            {t("customers.recordPayment")}
          </button>
        ) : null}
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
        {owes ? (
          <div className="voucher-stat voucher-stat--bad">
            <strong>{formatMoney(customer.outstandingMinor, currency, locale)}</strong>
            <span>{t("customers.outstanding")}</span>
          </div>
        ) : (
          <div className="voucher-stat">
            <strong>
              {customer.lastOrderAt ? formatDate(customer.lastOrderAt, locale) : "—"}
            </strong>
            <span>{t("customers.lastOrder")}</span>
          </div>
        )}
      </div>

      {payOpen ? (
        <RecordPaymentModal
          client={client}
          customerId={customer.id}
          customerName={customer.name}
          outstandingMinor={customer.outstandingMinor}
          currency={currency}
          onClose={() => setPayOpen(false)}
          onRecorded={() => {
            setPayOpen(false);
            onRecorded();
          }}
        />
      ) : null}

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

      {paymentItems.length > 0 ? (
        <section className="order-card">
          <h3>{t("customers.paymentHistory")}</h3>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("customers.date")}</th>
                  <th>{t("customers.notes")}</th>
                  <th className="end">{t("customers.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {paymentItems.map((payment) => (
                  <tr key={payment.id}>
                    <td className="muted">{formatDateTime(payment.paidAt, locale)}</td>
                    <td className="muted">{payment.notes ?? "—"}</td>
                    <td className="end">
                      <strong>{formatMoney(payment.amountMinor, payment.currency, locale)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </article>
  );
}

/**
 * Records a paydown against a customer's outstanding installment balance. The amount is validated
 * client-side (positive, not exceeding the balance) and the server re-validates authoritatively; a
 * fresh idempotency key makes a double-tap safe.
 */
function RecordPaymentModal({
  client,
  customerId,
  customerName,
  outstandingMinor,
  currency,
  onClose,
  onRecorded,
}: {
  client: TenantCommerceClient;
  customerId: string;
  customerName: string;
  outstandingMinor: number;
  currency: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { t, locale } = useI18n();
  const [amount, setAmount] = useState(minorToMajorInput(outstandingMinor));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountMinor = parseMajorToMinor(amount);
  const valid = amountMinor !== null && amountMinor > 0 && amountMinor <= outstandingMinor;

  const submit = () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await client.recordCustomerPayment({
          customerId,
          idempotencyKey: crypto.randomUUID(),
          amountMinor: amountMinor as number,
          notes: notes.trim() || null,
        });
        onRecorded();
      } catch (err) {
        setError(classifyCommerceError(err).message);
        setBusy(false);
      }
    })();
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("customers.recordPayment")}>
      <div className="modal-card">
        <p className="eyebrow">{t("customers.recordPayment")}</p>
        <h2>{customerName}</h2>
        <p className="muted">
          {t("customers.balanceDue", {
            amount: formatMoney(outstandingMinor, currency, locale),
          })}
        </p>
        {error ? (
          <div className="notice notice--error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
        <label className="field">
          <span>{t("customers.amount")}</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("customers.notesOptional")}</span>
          <input
            value={notes}
            disabled={busy}
            maxLength={500}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <div className="pay-actions">
          <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>
            {t("pay.cancel")}
          </button>
          <button
            type="button"
            className="button button--complete"
            disabled={!valid || busy}
            onClick={submit}
          >
            {busy ? t("customers.recording") : t("customers.recordPayment")}
          </button>
        </div>
      </div>
    </div>
  );
}
