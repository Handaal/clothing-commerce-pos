import { useEffect, useState } from "react";

import type { OfflineBridge, OfflineLocalReport as LocalReport } from "../../shared/offline";
import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";

// The on-device operational summary shown on the Reports desk. It is sourced entirely from durable
// local state via `window.offline.getLocalReport()` — accepted sales, the sync outbox, local customer
// payments — so it works offline. It is deliberately framed as *this till only*, never as a
// company-wide report or a financial close: the server-built reports above remain canonical.
export function OfflineLocalReport({
  bridge = typeof window === "undefined" ? undefined : window.offline,
}: {
  bridge?: OfflineBridge;
}) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<LocalReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge
      .getLocalReport()
      .then((value) => {
        if (active) setReport(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  // Outside Electron (no bridge) there is no on-device data source at all; render nothing rather than
  // an empty card.
  if (!bridge) return null;
  if (failed) {
    return (
      <section className="local-report" aria-label={t("reports.local.title")}>
        <h3>{t("reports.local.title")}</h3>
        <p className="local-report__note">{t("reports.local.unavailable")}</p>
      </section>
    );
  }
  if (!report) return null;

  const currency = report.currency;
  const money = (minor: number) =>
    currency ? formatMoney(minor, currency, locale) : String(minor);
  const hasActivity = report.sales.count > 0 || report.customerPayments.count > 0;

  return (
    <section className="local-report" aria-label={t("reports.local.title")}>
      <div className="local-report__head">
        <h3>{t("reports.local.title")}</h3>
        <span className="pill">{t("reports.local.deviceOnly")}</span>
      </div>
      <p className="local-report__note">{t("reports.local.disclaimer")}</p>
      <dl className="local-report__meta">
        <div>
          <dt>{t("reports.local.coverage")}</dt>
          <dd>
            {report.coverageFrom
              ? t("reports.local.coverageRange", {
                  from: formatDateTime(report.coverageFrom, locale),
                  to: formatDateTime(report.coverageTo, locale),
                })
              : t("reports.local.coverageNone")}
          </dd>
        </div>
        <div>
          <dt>{t("reports.local.asOf")}</dt>
          <dd>{formatDateTime(report.generatedAt, locale)}</dd>
        </div>
      </dl>

      {hasActivity ? (
        <div className="local-report__grid">
          <Figure label={t("reports.local.salesCount")} value={String(report.sales.count)} />
          <Figure label={t("reports.local.gross")} value={money(report.sales.grossMinor)} />
          <Figure label={t("reports.local.collected")} value={money(report.sales.collectedMinor)} />
          <Figure
            label={t("reports.local.outstanding")}
            value={money(report.sales.outstandingMinor)}
          />
          <Figure
            label={t("reports.local.payments")}
            value={`${report.customerPayments.count} · ${money(report.customerPayments.totalMinor)}`}
          />
        </div>
      ) : (
        <p className="local-report__note" data-empty="true">
          {t("reports.local.empty")}
        </p>
      )}

      <div className="local-report__lifecycle">
        <h4>{t("reports.local.confirmation")}</h4>
        <ul>
          <li>
            {t("reports.local.pendingSync", { count: report.lifecycle.acceptedPendingSync })}
          </li>
          <li>{t("reports.local.synced", { count: report.lifecycle.synced })}</li>
          <li>
            {t("reports.local.needsReconciliation", {
              count: report.lifecycle.needsReconciliation,
            })}
          </li>
          {report.blocked > 0 ? (
            <li data-tone="bad">{t("reports.local.blocked", { count: report.blocked })}</li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="local-report__figure">
      <span className="local-report__figure-label">{label}</span>
      <strong className="local-report__figure-value">{value}</strong>
    </div>
  );
}
