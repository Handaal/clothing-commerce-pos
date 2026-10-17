import type {
  InventoryReportResponse,
  InventoryView,
  ProductLevel,
  ProductsReportResponse,
  ProductView,
  PromotionsReportResponse,
  ReportExportQuery,
  ReportSummaryResponse,
  ReturnsReportResponse,
  ReturnsView,
  SalesReportResponse,
  SalesView,
  SalesBucket,
  SalesReportItem,
  SuppliersReportResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { BUSINESS_CURRENCY, formatMoney } from "../money";
import { useI18n, type TVars } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";

type T = (key: string, vars?: TVars) => string;
type Tab = "summary" | "sales" | "products" | "inventory" | "returns" | "promotions" | "suppliers";

const TABS: readonly { id: Tab; labelKey: string }[] = [
  { id: "summary", labelKey: "reports.tab.summary" },
  { id: "sales", labelKey: "reports.tab.sales" },
  { id: "products", labelKey: "reports.tab.products" },
  { id: "inventory", labelKey: "reports.tab.inventory" },
  { id: "returns", labelKey: "reports.tab.returns" },
  { id: "promotions", labelKey: "reports.tab.promotions" },
  { id: "suppliers", labelKey: "reports.tab.suppliers" },
];

// One loaded report. The union keeps each response strongly typed while a single loader drives the view.
type Payload =
  | { kind: "summary"; data: ReportSummaryResponse }
  | { kind: "sales"; data: SalesReportResponse }
  | { kind: "products"; data: ProductsReportResponse }
  | { kind: "inventory"; data: InventoryReportResponse }
  | { kind: "returns"; data: ReturnsReportResponse }
  | { kind: "promotions"; data: PromotionsReportResponse }
  | { kind: "suppliers"; data: SuppliersReportResponse };

// Which canonical CSV dataset (if any) the current tab exports. Sales/summary/promotions have none.
const EXPORT_DATASET: Partial<Record<Tab, ReportExportQuery["dataset"]>> = {
  products: "sales-products",
  inventory: "inventory-movements",
  returns: "returns",
  suppliers: "supplier-receipts",
};

const PAGE_LIMIT = 50;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: isoDate(start), end: isoDate(end) };
}

const fmtDate = (iso: string | null | undefined, locale: string): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { dateStyle: "medium" });
};

// A derived ratio rendered as a percentage. Returns an em dash when the denominator is zero so an
// empty period never shows a misleading "0%" or NaN.
const fmtPercent = (numerator: number, denominator: number, locale: string): string => {
  if (!denominator) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(numerator / denominator);
};

const fmtDateTime = (iso: string | null | undefined, locale: string): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};

// Append the next page's items onto the current payload of the same kind (paginated tabs only).
function mergePayload(prev: Payload, next: Payload): Payload {
  if (prev.kind === "products" && next.kind === "products")
    return {
      kind: "products",
      data: { ...next.data, items: [...prev.data.items, ...next.data.items] },
    };
  if (prev.kind === "inventory" && next.kind === "inventory")
    return {
      kind: "inventory",
      data: { ...next.data, items: [...prev.data.items, ...next.data.items] },
    };
  if (prev.kind === "returns" && next.kind === "returns")
    return {
      kind: "returns",
      data: { ...next.data, items: [...(prev.data.items ?? []), ...(next.data.items ?? [])] },
    };
  if (prev.kind === "suppliers" && next.kind === "suppliers")
    return {
      kind: "suppliers",
      data: { ...next.data, items: [...prev.data.items, ...next.data.items] },
    };
  return next;
}

function nextCursorOf(payload: Payload | null): string | null {
  if (!payload) return null;
  if (payload.kind === "products" || payload.kind === "inventory" || payload.kind === "suppliers")
    return payload.data.pageInfo.hasMore ? payload.data.pageInfo.nextCursor : null;
  if (payload.kind === "returns")
    return payload.data.pageInfo?.hasMore ? (payload.data.pageInfo.nextCursor ?? null) : null;
  return null;
}

export function ReportsDesk({ client }: { client: TenantCommerceClient }) {
  const { t } = useI18n();
  const initial = defaultRange();
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);
  const [tab, setTab] = useState<Tab>("summary");

  // Per-tab view selectors; harmless to keep mounted regardless of the active tab.
  const [salesView, setSalesView] = useState<SalesView>("channel");
  const [salesBucket, setSalesBucket] = useState<SalesBucket>("day");
  const [productLevel, setProductLevel] = useState<ProductLevel>("product");
  const [productView, setProductView] = useState<ProductView>("sales");
  const [inventoryView, setInventoryView] = useState<InventoryView>("balances");
  const [returnsView, setReturnsView] = useState<ReturnsView>("summary");

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchPage = useCallback(
    async (cursor?: string): Promise<Payload> => {
      switch (tab) {
        case "summary":
          return { kind: "summary", data: await client.getReportSummary({ startDate, endDate }) };
        case "sales":
          return {
            kind: "sales",
            data: await client.getSalesReport({
              startDate,
              endDate,
              view: salesView,
              ...(salesView === "trend" ? { bucket: salesBucket } : {}),
            }),
          };
        case "products":
          return {
            kind: "products",
            data: await client.getProductsReport({
              startDate,
              endDate,
              level: productLevel,
              view: productView,
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            }),
          };
        case "inventory":
          return {
            kind: "inventory",
            data: await client.getInventoryReport({
              view: inventoryView,
              limit: PAGE_LIMIT,
              // `balances` is current state with no period; every other view is period-scoped.
              ...(inventoryView === "balances" ? {} : { startDate, endDate }),
              ...(cursor ? { cursor } : {}),
            }),
          };
        case "returns":
          return {
            kind: "returns",
            data: await client.getReturnsReport({
              startDate,
              endDate,
              view: returnsView,
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            }),
          };
        case "promotions":
          return {
            kind: "promotions",
            data: await client.getPromotionsReport({ startDate, endDate }),
          };
        case "suppliers":
          return {
            kind: "suppliers",
            data: await client.getSuppliersReport({
              startDate,
              endDate,
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            }),
          };
      }
    },
    [
      client,
      tab,
      startDate,
      endDate,
      salesView,
      salesBucket,
      productLevel,
      productView,
      inventoryView,
      returnsView,
    ],
  );

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    setLoading(true);
    setError(null);
    fetchPage()
      .then((result) => {
        if (!active) return;
        setPayload(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(classifyCommerceError(err).message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursorOf(payload);
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await fetchPage(cursor);
      setPayload((current) => (current ? mergePayload(current, next) : next));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoadingMore(false);
    }
  }, [payload, fetchPage]);

  const exportDataset = EXPORT_DATASET[tab] ?? null;
  const runExport = useCallback(async () => {
    if (!exportDataset) return;
    setExporting(true);
    setError(null);
    try {
      const result = await client.exportReport({
        dataset: exportDataset,
        startDate,
        endDate,
        ...(exportDataset === "sales-products" ? { level: productLevel } : {}),
      });
      const blob = new Blob([result.body], { type: result.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setExporting(false);
    }
  }, [client, exportDataset, startDate, endDate, productLevel]);

  const canLoadMore = nextCursorOf(payload) !== null;

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("reports.analytics")}</p>
          <h1>{t("nav.reports")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            {t("activity.from")}
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            {t("activity.to")}
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
          {exportDataset ? (
            <button
              className="button button--quiet"
              disabled={exporting || loading}
              onClick={() => void runExport()}
            >
              {exporting ? t("reports.exporting") : t("activity.exportCsv")}
            </button>
          ) : null}
        </div>
      </header>

      <nav className="report-tabs" aria-label={t("reports.reportType")}>
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`report-tab${tab === item.id ? " report-tab--active" : ""}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <ViewSelectors
        tab={tab}
        salesView={salesView}
        onSalesView={setSalesView}
        salesBucket={salesBucket}
        onSalesBucket={setSalesBucket}
        productLevel={productLevel}
        onProductLevel={setProductLevel}
        productView={productView}
        onProductView={setProductView}
        inventoryView={inventoryView}
        onInventoryView={setInventoryView}
        returnsView={returnsView}
        onReturnsView={setReturnsView}
      />

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <SkeletonLines lines={6} label={t("reports.loading")} />
      ) : payload ? (
        <ReportBody payload={payload} salesView={salesView} />
      ) : null}

      {!loading && canLoadMore ? (
        <div className="operation-message">
          <button
            className="button button--quiet"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? t("reports.loadingMore") : t("inventory.loadMore")}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function ViewSelectors(props: {
  tab: Tab;
  salesView: SalesView;
  onSalesView: (v: SalesView) => void;
  salesBucket: SalesBucket;
  onSalesBucket: (v: SalesBucket) => void;
  productLevel: ProductLevel;
  onProductLevel: (v: ProductLevel) => void;
  productView: ProductView;
  onProductView: (v: ProductView) => void;
  inventoryView: InventoryView;
  onInventoryView: (v: InventoryView) => void;
  returnsView: ReturnsView;
  onReturnsView: (v: ReturnsView) => void;
}) {
  const { t } = useI18n();
  if (props.tab === "sales")
    return (
      <div className="staff-filters">
        <label>
          {t("reports.view")}
          <Select<SalesView>
            ariaLabel={t("reports.salesView")}
            value={props.salesView}
            onChange={props.onSalesView}
            options={[
              { value: "channel", label: t("reports.byChannel") },
              { value: "trend", label: t("reports.overTime") },
              { value: "brand", label: t("reports.byBrand") },
              { value: "pos_branch", label: t("reports.byBranch") },
              { value: "pos_register", label: t("reports.byRegister") },
              { value: "pos_operator", label: t("reports.byOperator") },
            ]}
          />
        </label>
        {props.salesView === "trend" ? (
          <label>
            {t("reports.bucket")}
            <Select<SalesBucket>
              ariaLabel={t("reports.bucket")}
              value={props.salesBucket}
              onChange={props.onSalesBucket}
              options={[
                { value: "day", label: t("reports.daily") },
                { value: "week", label: t("reports.weekly") },
                { value: "month", label: t("reports.monthly") },
              ]}
            />
          </label>
        ) : null}
      </div>
    );
  if (props.tab === "products")
    return (
      <div className="staff-filters">
        <label>
          {t("reports.level")}
          <Select<ProductLevel>
            ariaLabel={t("reports.level")}
            value={props.productLevel}
            onChange={props.onProductLevel}
            options={[
              { value: "product", label: t("orders.product") },
              { value: "variant", label: t("reports.variant") },
            ]}
          />
        </label>
        <label>
          {t("reports.view")}
          <Select<ProductView>
            ariaLabel={t("reports.productView")}
            value={props.productView}
            onChange={props.onProductView}
            options={[
              { value: "sales", label: t("reports.bestSellers") },
              { value: "no_sales_with_current_stock", label: t("reports.noSalesInStock") },
            ]}
          />
        </label>
      </div>
    );
  if (props.tab === "inventory")
    return (
      <div className="staff-filters">
        <label>
          {t("reports.view")}
          <Select<InventoryView>
            ariaLabel={t("reports.inventoryView")}
            value={props.inventoryView}
            onChange={props.onInventoryView}
            options={[
              { value: "balances", label: t("reports.balances") },
              { value: "movements", label: t("reports.movements") },
              { value: "receipts", label: t("reports.receipts") },
              { value: "transfers", label: t("reports.transfers") },
              { value: "adjustments", label: t("staff.adjustments") },
            ]}
          />
        </label>
      </div>
    );
  if (props.tab === "returns")
    return (
      <div className="staff-filters">
        <label>
          {t("reports.view")}
          <Select<ReturnsView>
            ariaLabel={t("reports.returnsView")}
            value={props.returnsView}
            onChange={props.onReturnsView}
            options={[
              { value: "summary", label: t("reports.tab.summary") },
              { value: "products", label: t("reports.byProduct") },
              { value: "variants", label: t("reports.byVariant") },
            ]}
          />
        </label>
      </div>
    );
  return null;
}

function ReportBody({ payload, salesView }: { payload: Payload; salesView: SalesView }) {
  switch (payload.kind) {
    case "summary":
      return <SummaryReport data={payload.data} />;
    case "sales":
      return <SalesReport data={payload.data} view={salesView} />;
    case "products":
      return <ProductsReport data={payload.data} />;
    case "inventory":
      return <InventoryReport data={payload.data} />;
    case "returns":
      return <ReturnsReport data={payload.data} />;
    case "promotions":
      return <PromotionsReport data={payload.data} />;
    case "suppliers":
      return <SuppliersReport data={payload.data} />;
  }
}

function SummaryReport({ data }: { data: ReportSummaryResponse }) {
  const { t, locale } = useI18n();
  return (
    <>
      {data.salesByCurrency.length === 0 ? (
        <p className="staff-empty">{t("reports.noSalesPeriod")}</p>
      ) : (
        data.salesByCurrency.map((row) => {
          // Refunds for this currency let us show the "true" net the business kept after returns.
          const refunds = data.returns.refundsByCurrency.find((r) => r.currency === row.currency);
          const refundedMinor = refunds?.succeededRefundMinor ?? 0;
          const returned = data.returns.byCurrency.find((r) => r.currency === row.currency);
          return (
            <div className="staff-stats" key={row.currency}>
              <div className="staff-stat staff-stat--accent">
                <span>{t("reports.netSalesCur", { currency: row.currency })}</span>
                <strong>{formatMoney(row.netSalesMinor, row.currency, locale)}</strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.grossSales")}</span>
                <strong>{formatMoney(row.grossSalesMinor, row.currency, locale)}</strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.discounts")}</span>
                <strong>{formatMoney(row.discountsMinor, row.currency, locale)}</strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.discountRate")}</span>
                <strong>{fmtPercent(row.discountsMinor, row.grossSalesMinor, locale)}</strong>
              </div>
              <div className="staff-stat">
                <span>{t("customers.orders")}</span>
                <strong>{row.orderCount}</strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.avgOrderValue")}</span>
                <strong>
                  {row.averageOrderValueMinor === null
                    ? "—"
                    : formatMoney(row.averageOrderValueMinor, row.currency, locale)}
                </strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.netAfterReturns")}</span>
                <strong>
                  {formatMoney(
                    Math.max(0, row.netSalesMinor - refundedMinor),
                    row.currency,
                    locale,
                  )}
                </strong>
              </div>
              <div className="staff-stat">
                <span>{t("reports.returnRate")}</span>
                <strong>
                  {fmtPercent(returned?.acceptedReturnedValueMinor ?? 0, row.netSalesMinor, locale)}
                </strong>
              </div>
            </div>
          );
        })
      )}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>{t("reports.stockOnHand")}</span>
          <strong>{data.stock.totalOnHandQuantity}</strong>
        </div>
        <div className="staff-stat">
          <span>{t("reports.variantsTracked")}</span>
          <strong>{data.stock.variantCount}</strong>
        </div>
        <div className="staff-stat">
          <span>{t("inventory.locations")}</span>
          <strong>{data.stock.locationCount}</strong>
        </div>
      </div>

      {data.returns.byCurrency.length > 0 ? (
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>{t("reports.returnsRefunds")}</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("staff.col.currency")}</th>
                  <th className="end">{t("reports.returnedValue")}</th>
                  <th className="end">{t("orders.returnsHeading")}</th>
                  <th className="end">{t("reports.refunded")}</th>
                  <th className="end">{t("reports.pendingRefund")}</th>
                </tr>
              </thead>
              <tbody>
                {data.returns.byCurrency.map((row) => {
                  const refunds = data.returns.refundsByCurrency.find(
                    (r) => r.currency === row.currency,
                  );
                  return (
                    <tr key={row.currency}>
                      <td>{row.currency}</td>
                      <td className="end">
                        {formatMoney(row.acceptedReturnedValueMinor, row.currency, locale)}
                      </td>
                      <td className="end">{row.returnCount}</td>
                      <td className="end">
                        {formatMoney(refunds?.succeededRefundMinor ?? 0, row.currency, locale)}
                      </td>
                      <td className="end">
                        {formatMoney(refunds?.pendingRefundMinor ?? 0, row.currency, locale)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="staff-empty">
        {t("reports.stockAsOf", { when: fmtDateTime(data.inventoryAsOf, locale) })}
      </p>
    </>
  );
}

function salesDimension(item: SalesReportItem, view: SalesView, t: T, locale: string): string {
  switch (view) {
    case "trend":
      return fmtDate(item.bucketStart, locale);
    case "channel":
      return item.channel === "pos"
        ? t("reports.inStorePos")
        : item.channel === "online"
          ? t("reports.online")
          : "—";
    case "brand":
      return item.brandName ?? item.brandId ?? "—";
    case "pos_branch":
      return item.branchName ?? t("reports.allBranches");
    case "pos_register":
      return item.registerName ?? "—";
    case "pos_operator":
      return item.operatorName ?? t("reports.unattributed");
  }
}

const SALES_DIMENSION_LABEL_KEY: Record<SalesView, string> = {
  trend: "reports.period",
  channel: "customers.channel",
  brand: "reports.brand",
  pos_branch: "reports.branch",
  pos_register: "pos.register",
  pos_operator: "reports.operator",
};

function SalesReport({ data, view }: { data: SalesReportResponse; view: SalesView }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0) return <p className="staff-empty">{t("reports.noSalesShort")}</p>;
  const dimensionLabel = t(SALES_DIMENSION_LABEL_KEY[data.view]);
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>
          {t("reports.tab.sales")} · {dimensionLabel}
        </h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{dimensionLabel}</th>
              <th className="end">{t("reports.gross")}</th>
              <th className="end">{t("reports.discounts")}</th>
              <th className="end">{t("reports.net")}</th>
              <th className="end">{t("customers.orders")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, index) => (
              <tr key={`${salesDimension(item, view, t, locale)}-${index}`}>
                <td>{salesDimension(item, view, t, locale)}</td>
                <td className="end">{formatMoney(item.grossSalesMinor, item.currency, locale)}</td>
                <td className="end muted">
                  {formatMoney(item.discountsMinor, item.currency, locale)}
                </td>
                <td className="end">
                  <strong>{formatMoney(item.netSalesMinor, item.currency, locale)}</strong>
                </td>
                <td className="end">{item.orderCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProductsReport({ data }: { data: ProductsReportResponse }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0) return <p className="staff-empty">{t("reports.noProducts")}</p>;
  const noSales = data.view === "no_sales_with_current_stock";
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>
          {t("reports.tab.products")} ·{" "}
          {noSales ? t("reports.noSalesInStock") : t("reports.bestSellers")}
        </h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{t("orders.product")}</th>
              {noSales ? (
                <th className="end">{t("inventory.onHand")}</th>
              ) : (
                <>
                  <th className="end">{t("reports.units")}</th>
                  <th className="end">{t("reports.gross")}</th>
                  <th className="end">{t("reports.discounts")}</th>
                  <th className="end">{t("reports.net")}</th>
                  <th className="end">{t("reports.avgPrice")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.variantId ?? item.productId}>
                <td>
                  <strong>{item.productName}</strong>
                  {item.sku ? <small>{t("cashier.sku", { sku: item.sku })}</small> : null}
                </td>
                {noSales ? (
                  <td className="end">
                    <strong>{item.onHandQuantity ?? 0}</strong>
                  </td>
                ) : (
                  <>
                    <td className="end">{item.unitsSold ?? 0}</td>
                    <td className="end">
                      {formatMoney(
                        item.grossSalesMinor ?? 0,
                        item.currency ?? BUSINESS_CURRENCY,
                        locale,
                      )}
                    </td>
                    <td className="end muted">
                      {formatMoney(
                        item.allocatedDiscountsMinor ?? 0,
                        item.currency ?? BUSINESS_CURRENCY,
                        locale,
                      )}
                    </td>
                    <td className="end">
                      <strong>
                        {formatMoney(
                          item.netSalesMinor ?? 0,
                          item.currency ?? BUSINESS_CURRENCY,
                          locale,
                        )}
                      </strong>
                    </td>
                    <td className="end muted">
                      {item.unitsSold
                        ? formatMoney(
                            Math.round((item.netSalesMinor ?? 0) / item.unitsSold),
                            item.currency ?? BUSINESS_CURRENCY,
                            locale,
                          )
                        : "—"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InventoryReport({ data }: { data: InventoryReportResponse }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0) return <p className="staff-empty">{t("reports.noInventory")}</p>;
  const view = data.view;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>
          {t("nav.inventory")} · {t(`reports.invView.${view}`)}
        </h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          {view === "balances" ? (
            <>
              <thead>
                <tr>
                  <th>{t("orders.product")}</th>
                  <th>{t("inventory.location")}</th>
                  <th className="end">{t("inventory.onHand")}</th>
                  <th className="end">{t("inventory.version")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.variantId ?? ""}-${item.inventoryLocationId ?? ""}-${index}`}>
                    <td>
                      <strong>{item.productName ?? "—"}</strong>
                      {item.sku ? <small>{t("cashier.sku", { sku: item.sku })}</small> : null}
                    </td>
                    <td>{item.locationName ?? "—"}</td>
                    <td className="end">
                      <strong>{item.onHandQuantity ?? 0}</strong>
                    </td>
                    <td className="end muted">{item.version ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </>
          ) : view === "movements" ? (
            <>
              <thead>
                <tr>
                  <th>{t("activity.col.when")}</th>
                  <th>{t("staff.type")}</th>
                  <th>{t("orders.product")}</th>
                  <th>{t("inventory.location")}</th>
                  <th className="end">{t("reports.change")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.operationId ?? ""}-${index}`}>
                    <td>{fmtDateTime(item.occurredAt, locale)}</td>
                    <td>{item.operationType ?? "—"}</td>
                    <td>
                      <strong>{item.productName ?? item.sku ?? "—"}</strong>
                      {item.sku ? <small>{t("cashier.sku", { sku: item.sku })}</small> : null}
                    </td>
                    <td>{item.locationName ?? "—"}</td>
                    <td className="end">
                      <strong>
                        {item.quantityDelta !== undefined && item.quantityDelta > 0
                          ? `+${item.quantityDelta}`
                          : (item.quantityDelta ?? 0)}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th>{t("activity.col.when")}</th>
                  <th>{t("staff.type")}</th>
                  <th>{t("activity.cat.supplier")}</th>
                  <th className="end">{t("reports.lines")}</th>
                  <th className="end">{t("reports.in")}</th>
                  <th className="end">{t("reports.out")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.operationId ?? ""}-${index}`}>
                    <td>{fmtDateTime(item.occurredAt, locale)}</td>
                    <td>{item.operationType ?? "—"}</td>
                    <td>{item.supplierName ?? "—"}</td>
                    <td className="end">{item.lineCount ?? 0}</td>
                    <td className="end">{item.unitsIn ?? 0}</td>
                    <td className="end muted">{item.unitsOut ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </div>
    </section>
  );
}

function ReturnsReport({ data }: { data: ReturnsReportResponse }) {
  const { t, locale } = useI18n();
  if (data.view === "summary") {
    const summary = data.summary;
    if (!summary || summary.byCurrency.length === 0)
      return <p className="staff-empty">{t("reports.noReturns")}</p>;
    return (
      <>
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>{t("reports.returnsByCurrency")}</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("staff.col.currency")}</th>
                  <th className="end">{t("reports.returnedValue")}</th>
                  <th className="end">{t("orders.returnsHeading")}</th>
                  <th className="end">{t("reports.refunded")}</th>
                  <th className="end">{t("reports.pendingCol")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.byCurrency.map((row) => (
                  <tr key={row.currency}>
                    <td>{row.currency}</td>
                    <td className="end">
                      {formatMoney(row.acceptedReturnedValueMinor, row.currency, locale)}
                    </td>
                    <td className="end">{row.returnCount}</td>
                    <td className="end">
                      {formatMoney(row.succeededRefundMinor, row.currency, locale)}
                    </td>
                    <td className="end muted">
                      {formatMoney(row.pendingRefundMinor, row.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {summary.byDisposition.length > 0 ? (
          <section className="staff-card">
            <div className="staff-card__head">
              <h2>{t("reports.byDisposition")}</h2>
            </div>
            <div className="staff-table-wrap">
              <table className="staff-table">
                <thead>
                  <tr>
                    <th>{t("reports.disposition")}</th>
                    <th className="end">{t("reports.unitsReturned")}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byDisposition.map((row) => (
                    <tr key={row.disposition}>
                      <td>{row.disposition}</td>
                      <td className="end">{row.returnedQuantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </>
    );
  }

  const items = data.items ?? [];
  if (items.length === 0) return <p className="staff-empty">{t("reports.noReturns")}</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>
          {t("orders.returnsHeading")} ·{" "}
          {data.view === "variants" ? t("reports.byVariant") : t("reports.byProduct")}
        </h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{t("orders.product")}</th>
              <th className="end">{t("reports.qtyReturned")}</th>
              <th className="end">{t("reports.value")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={`${item.variantId ?? item.productId}-${index}`}>
                <td>
                  <strong>{item.productName}</strong>
                  {item.sku ? <small>{t("cashier.sku", { sku: item.sku })}</small> : null}
                </td>
                <td className="end">{item.returnedQuantity}</td>
                <td className="end">
                  {formatMoney(item.returnedValueMinor, item.currency, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PromotionsReport({ data }: { data: PromotionsReportResponse }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0) return <p className="staff-empty">{t("reports.noPromotions")}</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("reports.tab.promotions")}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{t("reports.promotion")}</th>
              <th>{t("vouchers.code")}</th>
              <th className="end">{t("reports.redemptions")}</th>
              <th className="end">{t("vouchers.discount")}</th>
              <th className="end">{t("reports.net")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, index) => (
              <tr key={`${item.promotionId}-${index}`}>
                <td>
                  <strong>{item.promotionName ?? "—"}</strong>
                </td>
                <td className="muted">{item.codeSnapshot ?? "—"}</td>
                <td className="end">{item.redemptionCount}</td>
                <td className="end">
                  {formatMoney(item.discountAmountMinor, item.currency, locale)}
                </td>
                <td className="end">{formatMoney(item.netSalesMinor, item.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SuppliersReport({ data }: { data: SuppliersReportResponse }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0)
    return <p className="staff-empty">{t("reports.noSupplierReceipts")}</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("reports.supplierReceipts")}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{t("nav.suppliers")}</th>
              <th className="end">{t("reports.receiptsCol")}</th>
              <th className="end">{t("reports.unitsReceived")}</th>
              <th className="end">{t("reports.lastReceipt")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.supplierId}>
                <td>
                  <strong>{item.supplierName ?? item.supplierNameSnapshot ?? "—"}</strong>
                </td>
                <td className="end">{item.receiptCount}</td>
                <td className="end">{item.unitsReceived}</td>
                <td className="end muted">{fmtDate(item.lastReceiptAt, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
