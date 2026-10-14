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
import { formatMoney } from "../money";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";

type Tab = "summary" | "sales" | "products" | "inventory" | "returns" | "promotions" | "suppliers";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "sales", label: "Sales" },
  { id: "products", label: "Products" },
  { id: "inventory", label: "Inventory" },
  { id: "returns", label: "Returns" },
  { id: "promotions", label: "Promotions" },
  { id: "suppliers", label: "Suppliers" },
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

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
          <p className="eyebrow">Analytics</p>
          <h1>Reports</h1>
        </div>
        <div className="staff-filters">
          <label>
            From
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            To
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
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          ) : null}
        </div>
      </header>

      <nav className="report-tabs" aria-label="Report type">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`report-tab${tab === item.id ? " report-tab--active" : ""}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
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
        <SkeletonLines lines={6} label="Loading report" />
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
            {loadingMore ? "Loading…" : "Load more"}
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
  if (props.tab === "sales")
    return (
      <div className="staff-filters">
        <label>
          View
          <Select<SalesView>
            ariaLabel="Sales view"
            value={props.salesView}
            onChange={props.onSalesView}
            options={[
              { value: "channel", label: "By channel" },
              { value: "trend", label: "Over time" },
              { value: "brand", label: "By brand" },
              { value: "pos_branch", label: "By branch" },
              { value: "pos_register", label: "By register" },
              { value: "pos_operator", label: "By operator" },
            ]}
          />
        </label>
        {props.salesView === "trend" ? (
          <label>
            Bucket
            <Select<SalesBucket>
              ariaLabel="Bucket"
              value={props.salesBucket}
              onChange={props.onSalesBucket}
              options={[
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
                { value: "month", label: "Monthly" },
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
          Level
          <Select<ProductLevel>
            ariaLabel="Level"
            value={props.productLevel}
            onChange={props.onProductLevel}
            options={[
              { value: "product", label: "Product" },
              { value: "variant", label: "Variant" },
            ]}
          />
        </label>
        <label>
          View
          <Select<ProductView>
            ariaLabel="Product view"
            value={props.productView}
            onChange={props.onProductView}
            options={[
              { value: "sales", label: "Best sellers" },
              { value: "no_sales_with_current_stock", label: "No sales, in stock" },
            ]}
          />
        </label>
      </div>
    );
  if (props.tab === "inventory")
    return (
      <div className="staff-filters">
        <label>
          View
          <Select<InventoryView>
            ariaLabel="Inventory view"
            value={props.inventoryView}
            onChange={props.onInventoryView}
            options={[
              { value: "balances", label: "Balances" },
              { value: "movements", label: "Movements" },
              { value: "receipts", label: "Receipts" },
              { value: "transfers", label: "Transfers" },
              { value: "adjustments", label: "Adjustments" },
            ]}
          />
        </label>
      </div>
    );
  if (props.tab === "returns")
    return (
      <div className="staff-filters">
        <label>
          View
          <Select<ReturnsView>
            ariaLabel="Returns view"
            value={props.returnsView}
            onChange={props.onReturnsView}
            options={[
              { value: "summary", label: "Summary" },
              { value: "products", label: "By product" },
              { value: "variants", label: "By variant" },
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
  return (
    <>
      {data.salesByCurrency.length === 0 ? (
        <p className="staff-empty">No sales were recorded in this period.</p>
      ) : (
        data.salesByCurrency.map((row) => (
          <div className="staff-stats" key={row.currency}>
            <div className="staff-stat staff-stat--accent">
              <span>Net sales ({row.currency})</span>
              <strong>{formatMoney(row.netSalesMinor, row.currency)}</strong>
            </div>
            <div className="staff-stat">
              <span>Gross sales</span>
              <strong>{formatMoney(row.grossSalesMinor, row.currency)}</strong>
            </div>
            <div className="staff-stat">
              <span>Discounts</span>
              <strong>{formatMoney(row.discountsMinor, row.currency)}</strong>
            </div>
            <div className="staff-stat">
              <span>Orders</span>
              <strong>{row.orderCount}</strong>
            </div>
            <div className="staff-stat">
              <span>Avg order value</span>
              <strong>
                {row.averageOrderValueMinor === null
                  ? "—"
                  : formatMoney(row.averageOrderValueMinor, row.currency)}
              </strong>
            </div>
          </div>
        ))
      )}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>Stock on hand</span>
          <strong>{data.stock.totalOnHandQuantity}</strong>
        </div>
        <div className="staff-stat">
          <span>Variants tracked</span>
          <strong>{data.stock.variantCount}</strong>
        </div>
        <div className="staff-stat">
          <span>Locations</span>
          <strong>{data.stock.locationCount}</strong>
        </div>
      </div>

      {data.returns.byCurrency.length > 0 ? (
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>Returns & refunds</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th className="end">Returned value</th>
                  <th className="end">Returns</th>
                  <th className="end">Refunded</th>
                  <th className="end">Pending refund</th>
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
                        {formatMoney(row.acceptedReturnedValueMinor, row.currency)}
                      </td>
                      <td className="end">{row.returnCount}</td>
                      <td className="end">
                        {formatMoney(refunds?.succeededRefundMinor ?? 0, row.currency)}
                      </td>
                      <td className="end">
                        {formatMoney(refunds?.pendingRefundMinor ?? 0, row.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="staff-empty">Stock as of {fmtDateTime(data.inventoryAsOf)}.</p>
    </>
  );
}

function salesDimension(item: SalesReportItem, view: SalesView): string {
  switch (view) {
    case "trend":
      return fmtDate(item.bucketStart);
    case "channel":
      return item.channel === "pos" ? "In-store (POS)" : item.channel === "online" ? "Online" : "—";
    case "brand":
      return item.brandName ?? item.brandId ?? "—";
    case "pos_branch":
      return item.branchName ?? "All branches";
    case "pos_register":
      return item.registerName ?? "—";
    case "pos_operator":
      return item.operatorName ?? "Unattributed";
  }
}

const SALES_DIMENSION_LABEL: Record<SalesView, string> = {
  trend: "Period",
  channel: "Channel",
  brand: "Brand",
  pos_branch: "Branch",
  pos_register: "Register",
  pos_operator: "Operator",
};

function SalesReport({ data, view }: { data: SalesReportResponse; view: SalesView }) {
  if (data.items.length === 0) return <p className="staff-empty">No sales in this period.</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Sales · {SALES_DIMENSION_LABEL[data.view]}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{SALES_DIMENSION_LABEL[data.view]}</th>
              <th className="end">Gross</th>
              <th className="end">Discounts</th>
              <th className="end">Net</th>
              <th className="end">Orders</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, index) => (
              <tr key={`${salesDimension(item, view)}-${index}`}>
                <td>{salesDimension(item, view)}</td>
                <td className="end">{formatMoney(item.grossSalesMinor, item.currency)}</td>
                <td className="end muted">{formatMoney(item.discountsMinor, item.currency)}</td>
                <td className="end">
                  <strong>{formatMoney(item.netSalesMinor, item.currency)}</strong>
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
  if (data.items.length === 0)
    return <p className="staff-empty">No products match this report for the selected period.</p>;
  const noSales = data.view === "no_sales_with_current_stock";
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Products · {noSales ? "No sales, in stock" : "Best sellers"}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>Product</th>
              {noSales ? (
                <th className="end">On hand</th>
              ) : (
                <>
                  <th className="end">Units</th>
                  <th className="end">Gross</th>
                  <th className="end">Discounts</th>
                  <th className="end">Net</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.variantId ?? item.productId}>
                <td>
                  <strong>{item.productName}</strong>
                  {item.sku ? <small>SKU {item.sku}</small> : null}
                </td>
                {noSales ? (
                  <td className="end">
                    <strong>{item.onHandQuantity ?? 0}</strong>
                  </td>
                ) : (
                  <>
                    <td className="end">{item.unitsSold ?? 0}</td>
                    <td className="end">
                      {formatMoney(item.grossSalesMinor ?? 0, item.currency ?? "USD")}
                    </td>
                    <td className="end muted">
                      {formatMoney(item.allocatedDiscountsMinor ?? 0, item.currency ?? "USD")}
                    </td>
                    <td className="end">
                      <strong>
                        {formatMoney(item.netSalesMinor ?? 0, item.currency ?? "USD")}
                      </strong>
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
  if (data.items.length === 0)
    return <p className="staff-empty">No inventory rows for this view and period.</p>;
  const view = data.view;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Inventory · {view.charAt(0).toUpperCase() + view.slice(1)}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          {view === "balances" ? (
            <>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Location</th>
                  <th className="end">On hand</th>
                  <th className="end">Version</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.variantId ?? ""}-${item.inventoryLocationId ?? ""}-${index}`}>
                    <td>
                      <strong>{item.productName ?? "—"}</strong>
                      {item.sku ? <small>SKU {item.sku}</small> : null}
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
                  <th>When</th>
                  <th>Type</th>
                  <th>Product</th>
                  <th>Location</th>
                  <th className="end">Change</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.operationId ?? ""}-${index}`}>
                    <td>{fmtDateTime(item.occurredAt)}</td>
                    <td>{item.operationType ?? "—"}</td>
                    <td>
                      <strong>{item.productName ?? item.sku ?? "—"}</strong>
                      {item.sku ? <small>SKU {item.sku}</small> : null}
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
                  <th>When</th>
                  <th>Type</th>
                  <th>Supplier</th>
                  <th className="end">Lines</th>
                  <th className="end">In</th>
                  <th className="end">Out</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.operationId ?? ""}-${index}`}>
                    <td>{fmtDateTime(item.occurredAt)}</td>
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
  if (data.view === "summary") {
    const summary = data.summary;
    if (!summary || summary.byCurrency.length === 0)
      return <p className="staff-empty">No returns in this period.</p>;
    return (
      <>
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>Returns by currency</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th className="end">Returned value</th>
                  <th className="end">Returns</th>
                  <th className="end">Refunded</th>
                  <th className="end">Pending</th>
                </tr>
              </thead>
              <tbody>
                {summary.byCurrency.map((row) => (
                  <tr key={row.currency}>
                    <td>{row.currency}</td>
                    <td className="end">
                      {formatMoney(row.acceptedReturnedValueMinor, row.currency)}
                    </td>
                    <td className="end">{row.returnCount}</td>
                    <td className="end">{formatMoney(row.succeededRefundMinor, row.currency)}</td>
                    <td className="end muted">
                      {formatMoney(row.pendingRefundMinor, row.currency)}
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
              <h2>By disposition</h2>
            </div>
            <div className="staff-table-wrap">
              <table className="staff-table">
                <thead>
                  <tr>
                    <th>Disposition</th>
                    <th className="end">Units returned</th>
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
  if (items.length === 0) return <p className="staff-empty">No returns in this period.</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Returns · {data.view === "variants" ? "By variant" : "By product"}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>Product</th>
              <th className="end">Qty returned</th>
              <th className="end">Value</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={`${item.variantId ?? item.productId}-${index}`}>
                <td>
                  <strong>{item.productName}</strong>
                  {item.sku ? <small>SKU {item.sku}</small> : null}
                </td>
                <td className="end">{item.returnedQuantity}</td>
                <td className="end">{formatMoney(item.returnedValueMinor, item.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PromotionsReport({ data }: { data: PromotionsReportResponse }) {
  if (data.items.length === 0)
    return <p className="staff-empty">No promotions were redeemed in this period.</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Promotions</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>Promotion</th>
              <th>Code</th>
              <th className="end">Redemptions</th>
              <th className="end">Discount</th>
              <th className="end">Net sales</th>
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
                <td className="end">{formatMoney(item.discountAmountMinor, item.currency)}</td>
                <td className="end">{formatMoney(item.netSalesMinor, item.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SuppliersReport({ data }: { data: SuppliersReportResponse }) {
  if (data.items.length === 0)
    return <p className="staff-empty">No supplier receipts in this period.</p>;
  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Supplier receipts</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>Supplier</th>
              <th className="end">Receipts</th>
              <th className="end">Units received</th>
              <th className="end">Last receipt</th>
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
                <td className="end muted">{fmtDate(item.lastReceiptAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
