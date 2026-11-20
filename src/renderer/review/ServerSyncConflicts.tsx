import { useCallback, useEffect, useState } from "react";

import type {
  ListPosSyncConflictsResponse,
  PosSyncConflict,
  PosSyncConflictKind,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";

import type { OfflineSyncStatus } from "../../shared/offline";
import { formatDateTime } from "../format";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";

const KINDS: ReadonlyArray<PosSyncConflictKind | "all"> = [
  "all",
  "stock_shortfall",
  "voucher",
  "customer_duplicate",
  "customer_debt",
  "attendance",
  "dependency",
  "sync_integrity",
];

type Client = Pick<TenantCommerceClient, "listPosSyncConflicts">;

/**
 * ADR-042 §13.5 — the server's post-sync conflict report for THIS register. It is a report, not an approval
 * queue: nothing here edits, reprices, approves or retries a business conflict. Conflicts are resolved in the
 * normal online workflows (inventory, orders, customers, attendance). Offline it shows the connection state
 * and the till's pending uploads only; the server report needs a connection.
 */
export function ServerSyncConflicts({
  client,
  registerId,
  syncStatus,
}: {
  client: Client | null;
  registerId: string | null;
  syncStatus: Pick<
    OfflineSyncStatus,
    "networkOnline" | "pending" | "blocked" | "needsReconciliation" | "lastAttemptAt" | "lastError"
  >;
}) {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<PosSyncConflictKind | "all">("all");
  const [report, setReport] = useState<ListPosSyncConflictsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const online = syncStatus.networkOnline;

  const fetchReport = useCallback(
    () =>
      client && registerId && online
        ? client.listPosSyncConflicts({
            registerId,
            ...(kind === "all" ? {} : { kind }),
            limit: 100,
          })
        : null,
    [client, registerId, online, kind],
  );

  // State changes happen only in the async callbacks (never synchronously in the effect body).
  useEffect(() => {
    const pending = fetchReport();
    if (!pending) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (!cancelled) setLoading(true);
        return pending;
      })
      .then(
        (next) => {
          if (cancelled) return;
          setReport(next);
          setError(null);
        },
        () => {
          if (!cancelled) setError(t("conflicts.loadFailed"));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchReport, nonce, t]);

  const load = () => setNonce((value) => value + 1);

  return (
    <section
      className="review-center"
      aria-labelledby="sync-conflicts-title"
      data-testid="sync-conflicts"
    >
      <h2 id="sync-conflicts-title">{t("conflicts.title")}</h2>
      <p className="muted">{t("conflicts.intro")}</p>
      <dl className="conflict-status" aria-live="polite">
        <div>
          <dt>{t("conflicts.connection")}</dt>
          <dd data-testid="conflicts-connection">
            {online ? t("conflicts.online") : t("conflicts.offline")}
          </dd>
        </div>
        <div>
          <dt>{t("conflicts.lastAttempt")}</dt>
          <dd>
            {syncStatus.lastAttemptAt ? formatDateTime(syncStatus.lastAttemptAt, locale) : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("conflicts.pendingUploads")}</dt>
          <dd data-testid="conflicts-pending">{syncStatus.pending}</dd>
        </div>
        <div>
          <dt>{t("conflicts.transportBlocked")}</dt>
          <dd>{syncStatus.blocked}</dd>
        </div>
        <div>
          <dt>{t("conflicts.unresolved")}</dt>
          <dd data-testid="conflicts-open">{report ? report.summary.open : "—"}</dd>
        </div>
      </dl>
      {!online ? (
        <p className="notice" role="status">
          {t("conflicts.needsConnection")}
        </p>
      ) : null}
      {syncStatus.lastError ? (
        <p className="notice notice--warn" role="status">
          {t("conflicts.transportError")}
        </p>
      ) : null}
      <div className="review-filters">
        <label>
          {t("conflicts.filterKind")}
          <Select<PosSyncConflictKind | "all">
            ariaLabel={t("conflicts.filterKind")}
            value={kind}
            onChange={setKind}
            options={KINDS.map((value) => ({ value, label: t(`conflicts.kind.${value}`) }))}
          />
        </label>
        <button
          type="button"
          className="button button--quiet"
          disabled={!online || loading}
          onClick={load}
        >
          {t("conflicts.refresh")}
        </button>
      </div>
      {error ? (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      ) : null}
      {report && report.items.length === 0 ? <p>{t("conflicts.none")}</p> : null}
      <ul className="review-list">
        {(report?.items ?? []).map((item) => (
          <ConflictRow key={item.id} item={item} />
        ))}
      </ul>
      {report ? (
        <p className="muted">
          {t("conflicts.fetchedAt", { at: formatDateTime(report.generatedAt, locale) })}
        </p>
      ) : null}
    </section>
  );
}

function ConflictRow({ item }: { item: PosSyncConflict }) {
  const { t, locale } = useI18n();
  const reason = t(`conflicts.reason.${item.reasonCode}`);
  return (
    <li className="review-item" data-testid="sync-conflict">
      <div className="review-item__head">
        <strong>{t(`conflicts.kind.${item.kind}`)}</strong>
        <span
          className={`review-status ${item.status === "open" ? "review-status--bad" : "review-status--info"}`}
        >
          {t(`conflicts.status.${item.status}`)}
        </span>
      </div>
      <p>{reason.startsWith("conflicts.reason.") ? item.reasonCode : reason}</p>
      <dl className="review-item__facts">
        {item.kind === "stock_shortfall" ? (
          <>
            <dt>{t("conflicts.sku")}</dt>
            <dd>{String(item.localEvidence.sku ?? item.references.variantId ?? "—")}</dd>
            <dt>{t("conflicts.quantities")}</dt>
            <dd>
              {t("conflicts.stockFacts", {
                requested: String(item.localEvidence.requestedQuantity ?? "—"),
                cached: String(item.localEvidence.cachedOnHand ?? "—"),
                server: String(item.serverEvidence.canonicalOnHandAtSync ?? "—"),
                short: String(item.quantity ?? "—"),
              })}
            </dd>
          </>
        ) : null}
        {item.kind === "voucher" &&
        ("observedRemaining" in item.localEvidence || "serverRemaining" in item.serverEvidence) ? (
          <>
            <dt>{t("conflicts.voucherUsage")}</dt>
            <dd>
              {t("conflicts.voucherFacts", {
                observed: remainingLabel(item.localEvidence.observedRemaining, t),
                server: remainingLabel(item.serverEvidence.serverRemaining, t),
              })}
            </dd>
          </>
        ) : null}
        {item.amountMinor !== null && item.currency ? (
          <>
            <dt>{t("conflicts.amount")}</dt>
            <dd>{formatMoney(item.amountMinor, item.currency, locale)}</dd>
          </>
        ) : null}
        <dt>{t("conflicts.reference")}</dt>
        <dd>{item.localReference ?? item.syncCommandId ?? "—"}</dd>
        {item.references.orderId ? (
          <>
            <dt>{t("conflicts.order")}</dt>
            <dd>{item.references.orderId}</dd>
          </>
        ) : null}
        <dt>{t("conflicts.timeline")}</dt>
        <dd>
          {t("conflicts.timelineValue", {
            local: item.localEventAt ? formatDateTime(item.localEventAt, locale) : "—",
            detected: formatDateTime(item.detectedAt, locale),
          })}
        </dd>
      </dl>
      <p className="muted">{t(`conflicts.next.${item.kind}`)}</p>
    </li>
  );
}

/** Remaining-usage evidence: absent ⇒ "—", JSON null ⇒ no finite limit. */
function remainingLabel(value: unknown, t: (key: string) => string): string {
  if (value === undefined) return "—";
  if (value === null) return t("conflicts.unlimited");
  return String(value);
}
