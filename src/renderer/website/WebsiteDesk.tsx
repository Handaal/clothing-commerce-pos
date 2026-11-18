import type { MeContextResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { hasAnyWebsiteAccess, websiteAccess, type WebsiteAccess } from "./access";
import { CheckoutPanel } from "./CheckoutPanel";
import { describeWebsiteError } from "./errors";
import { HomePagePanel } from "./HomePagePanel";
import { OnlineOrdersPanel } from "./OnlineOrdersPanel";
import { PromotionsPanel } from "./PromotionsPanel";
import { PublicationPanel } from "./PublicationPanel";
import { SalesPanel } from "./SalesPanel";

export type WebsiteTab =
  "overview" | "orders" | "home" | "sales" | "publication" | "promotions" | "checkout";

interface TabDef {
  id: WebsiteTab;
  labelKey: string;
  descKey: string;
  visible: (access: WebsiteAccess) => boolean;
}

// Tab order follows Admin Mobile's Storefront hub, with the online-orders fulfilment queue first (the
// day-to-day work; Admin Mobile shows the same order data in its Orders section). Each tab is shown only when the operator's
// server-resolved access allows reading that area (the API still authorizes every request).
export const WEBSITE_TABS: readonly TabDef[] = [
  { id: "overview", labelKey: "website.tab.overview", descKey: "", visible: () => true },
  {
    id: "orders",
    labelKey: "website.tab.orders",
    descKey: "website.card.orders",
    visible: (a) => a.ordersRead,
  },
  {
    id: "home",
    labelKey: "website.tab.home",
    descKey: "website.card.home",
    visible: (a) => a.catalogRead,
  },
  {
    id: "sales",
    labelKey: "website.tab.sales",
    descKey: "website.card.sales",
    visible: (a) => a.promotionsRead,
  },
  {
    id: "publication",
    labelKey: "website.tab.publication",
    descKey: "website.card.publication",
    visible: (a) => a.catalogRead,
  },
  {
    id: "promotions",
    labelKey: "website.tab.promotions",
    descKey: "website.card.promotions",
    visible: (a) => a.promotionsRead,
  },
  {
    id: "checkout",
    labelKey: "website.tab.checkout",
    descKey: "website.card.checkout",
    visible: (a) => a.settingsRead,
  },
];

export function visibleWebsiteTabs(access: WebsiteAccess): readonly TabDef[] {
  return WEBSITE_TABS.filter((tab) => tab.visible(access));
}

export type WebsiteClient = TenantCommerceClient;

// Website Management: the POS counterpart of Admin Mobile's Storefront hub — online orders to fulfil,
// home-page content, item sales, catalog publication, promotions and per-brand checkout/returns. Online-only (see
// DESK_OFFLINE_PROFILES). Access is read from `/me/context` and fails closed if it cannot be loaded.
export function WebsiteDesk({
  client,
  onOpenVouchers,
}: {
  client: WebsiteClient;
  /** Navigate to the POS Vouchers desk (omitted when the operator cannot see it). */
  onOpenVouchers?: () => void;
}) {
  const { t } = useI18n();
  const [access, setAccess] = useState<WebsiteAccess | null>(null);
  const [context, setContext] = useState<MeContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WebsiteTab>("overview");

  const load = useCallback(async () => {
    setError(null);
    setAccess(null);
    try {
      const me = await client.getContext();
      setContext(me);
      setAccess(websiteAccess(me));
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const tabs = access ? visibleWebsiteTabs(access) : [];
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "overview";

  return (
    <main className="staff-shell website-desk">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("website.eyebrow")}</p>
          <h1>{t("nav.website")}</h1>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : access === null ? (
        <SkeletonLines lines={4} label={t("website.loadingAccess")} />
      ) : !hasAnyWebsiteAccess(access) ? (
        <div className="notice notice--warning" role="status" data-testid="website-no-access">
          {t("website.noAccess")}
        </div>
      ) : (
        <>
          <nav className="report-tabs" aria-label={t("nav.website")}>
            {tabs.map((item) => (
              <button
                key={item.id}
                className={`report-tab${activeTab === item.id ? " report-tab--active" : ""}`}
                aria-pressed={activeTab === item.id}
                onClick={() => setTab(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </nav>

          {activeTab === "overview" ? (
            <Overview client={client} access={access} tabs={tabs} onOpen={setTab} />
          ) : activeTab === "orders" ? (
            <OnlineOrdersPanel
              client={client}
              canFulfill={access.ordersFulfill}
              canCancel={access.ordersCancel}
            />
          ) : activeTab === "home" ? (
            <HomePagePanel client={client} />
          ) : activeTab === "sales" ? (
            <SalesPanel client={client} canManage={access.promotionsManage} />
          ) : activeTab === "publication" ? (
            <PublicationPanel client={client} />
          ) : activeTab === "promotions" ? (
            <PromotionsPanel
              client={client}
              canManage={access.promotionsManage}
              catalogRead={access.catalogRead}
              context={context}
              onOpenVouchers={onOpenVouchers}
            />
          ) : (
            <CheckoutPanel client={client} canManage={access.settingsManage} />
          )}
        </>
      )}
    </main>
  );
}

function Overview({
  client,
  access,
  tabs,
  onOpen,
}: {
  client: WebsiteClient;
  access: WebsiteAccess;
  tabs: readonly TabDef[];
  onOpen: (tab: WebsiteTab) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("website.overview.title")}</h2>
        </div>
        <p className="muted website-card-intro">{t("website.overview.body")}</p>
        <div className="website-cards">
          {tabs
            .filter((item) => item.id !== "overview")
            .map((item) => (
              <button
                key={item.id}
                className="website-card"
                data-testid={`website-open-${item.id}`}
                onClick={() => onOpen(item.id)}
              >
                <strong>{t(item.labelKey)}</strong>
                <span className="muted">{t(item.descKey)}</span>
              </button>
            ))}
        </div>
      </section>
      {access.settingsRead ? (
        <CheckoutSummary client={client} />
      ) : (
        <div className="notice notice--warning" role="status">
          {t("website.overview.checkoutNoAccess")}
        </div>
      )}
    </>
  );
}

// Read-only per-brand checkout snapshot on the overview (the hub's "Checkout" block in Admin Mobile).
function CheckoutSummary({ client }: { client: WebsiteClient }) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        rows: { brandId: string; brand: string; cod: boolean; currency: string }[];
      }
  >({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [settings, brands] = await Promise.all([
        client.listStorefrontSettings(),
        client.listBrands({ limit: 100 }),
      ]);
      const names = new Map(brands.items.map((brand) => [brand.id, brand.displayName]));
      setState({
        status: "ready",
        rows: settings.items.map((item) => ({
          brandId: item.brandId,
          brand: names.get(item.brandId) ?? item.brandId,
          cod: item.codEnabled,
          currency: item.currency,
        })),
      });
    } catch (err) {
      setState({ status: "error", message: describeWebsiteError(err, t) });
    }
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("website.overview.checkout")}</h2>
      </div>
      {state.status === "loading" ? (
        <SkeletonLines lines={2} label={t("website.checkout.loading")} />
      ) : state.status === "error" ? (
        <div className="notice notice--error" role="alert">
          <span>{state.message}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : state.rows.length === 0 ? (
        <p className="staff-empty">{t("website.checkout.empty")}</p>
      ) : (
        <div className="website-cards">
          {state.rows.map((row) => (
            <div
              key={row.brandId}
              className="website-card website-card--static"
              data-testid={`website-overview-brand-${row.brandId}`}
            >
              <strong>{row.brand}</strong>
              <span className="muted">
                {t("website.checkout.currency")}: {row.currency}
              </span>
              <span className={`pill${row.cod ? " pill--good" : ""}`}>
                {t("website.checkout.cod")}:{" "}
                {row.cod ? t("website.enabled") : t("website.disabled")}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
