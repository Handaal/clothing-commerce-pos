import { useCallback, useEffect, useState, type ReactNode } from "react";

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
import { Icons } from "../shell/icons";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";

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
type Tone = "good" | "warn" | "bad" | "neutral";

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
  const items = report?.items ?? [];
  const openCount = report ? report.summary.open : null;
  const showSkeleton = online && loading && !report;

  return (
    <section
      className="conflicts"
      aria-labelledby="sync-conflicts-title"
      data-testid="sync-conflicts"
    >
      <header className="conflicts__head">
        <div className="conflicts__heading">
          <span className="conflicts__icon" aria-hidden="true">
            <Icons.sync />
          </span>
          <div className="conflicts__titles">
            <h2 id="sync-conflicts-title">{t("conflicts.title")}</h2>
            <p className="conflicts__intro">{t("conflicts.intro")}</p>
          </div>
        </div>
        <div className="conflicts__toolbar">
          <Select<PosSyncConflictKind | "all">
            ariaLabel={t("conflicts.filterKind")}
            value={kind}
            onChange={setKind}
            disabled={!online}
            options={KINDS.map((value) => ({ value, label: t(`conflicts.kind.${value}`) }))}
          />
          <button
            type="button"
            className="button button--quiet conflicts__refresh"
            disabled={!online || loading}
            aria-busy={loading}
            onClick={load}
          >
            <span className={loading ? "conflicts__spin" : undefined} aria-hidden="true">
              <Icons.sync />
            </span>
            {t("conflicts.refresh")}
          </button>
        </div>
      </header>

      <dl className="conflicts__stats" aria-live="polite">
        <Stat label={t("conflicts.connection")} tone={online ? "good" : "warn"}>
          <span className="conflicts__dot" aria-hidden="true" />
          <span data-testid="conflicts-connection">
            {online ? t("conflicts.online") : t("conflicts.offline")}
          </span>
        </Stat>
        <Stat
          label={t("conflicts.unresolved")}
          tone={openCount === null ? "neutral" : openCount > 0 ? "bad" : "good"}
        >
          <span data-testid="conflicts-open">{openCount ?? "—"}</span>
        </Stat>
        <Stat
          label={t("conflicts.pendingUploads")}
          tone={syncStatus.pending > 0 ? "warn" : "neutral"}
        >
          <span data-testid="conflicts-pending">{syncStatus.pending}</span>
        </Stat>
        <Stat
          label={t("conflicts.transportBlocked")}
          tone={syncStatus.blocked > 0 ? "bad" : "neutral"}
        >
          <span>{syncStatus.blocked}</span>
        </Stat>
        <Stat label={t("conflicts.lastAttempt")} tone="neutral" small>
          <span>
            {syncStatus.lastAttemptAt ? formatDateTime(syncStatus.lastAttemptAt, locale) : "—"}
          </span>
        </Stat>
      </dl>

      {!online ? (
        <p className="notice notice--warning conflicts__notice" role="status">
          {t("conflicts.needsConnection")}
        </p>
      ) : null}
      {syncStatus.lastError ? (
        <p className="notice notice--warning conflicts__notice" role="status">
          {t("conflicts.transportError")}
        </p>
      ) : null}
      {error ? (
        <p className="notice notice--error conflicts__notice" role="alert">
          {error}
        </p>
      ) : null}

      {showSkeleton ? <SkeletonLines lines={3} label={t("conflicts.loading")} /> : null}

      {report && items.length === 0 ? (
        <div className="conflicts__empty">
          <span className="conflicts__empty-mark" aria-hidden="true">
            ✓
          </span>
          <strong>{t("conflicts.none")}</strong>
          <span>{t("conflicts.noneHint")}</span>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="conflicts__list" aria-busy={loading}>
          {items.map((item) => (
            <ConflictCard key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      {report ? (
        <p className="conflicts__fetched">
          {t("conflicts.fetchedAt", { at: formatDateTime(report.generatedAt, locale) })}
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  tone,
  small = false,
  children,
}: {
  label: string;
  tone: Tone;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`conflicts-stat conflicts-stat--${tone}${small ? " conflicts-stat--small" : ""}`}
    >
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ConflictCard({ item }: { item: PosSyncConflict }) {
  const { t, locale } = useI18n();
  const reason = t(`conflicts.reason.${item.reasonCode}`);
  const open = item.status === "open";
  return (
    <li
      className={`conflict-card ${open ? "conflict-card--open" : "conflict-card--info"}`}
      data-testid="sync-conflict"
    >
      <div className="conflict-card__head">
        <strong className="conflict-card__kind">{t(`conflicts.kind.${item.kind}`)}</strong>
        <span className={`review-status ${open ? "review-status--warn" : "review-status--info"}`}>
          {t(`conflicts.status.${item.status}`)}
        </span>
        <time className="conflict-card__when" dateTime={item.detectedAt}>
          {formatDateTime(item.detectedAt, locale)}
        </time>
      </div>
      <p className="conflict-card__reason">
        {reason.startsWith("conflicts.reason.") ? item.reasonCode : reason}
      </p>
      <dl className="conflict-card__facts">
        {item.kind === "stock_shortfall" ? (
          <>
            <Fact label={t("conflicts.sku")} mono>
              {String(item.localEvidence.sku ?? item.references.variantId ?? "—")}
            </Fact>
            <Fact label={t("conflicts.quantities")}>
              {t("conflicts.stockFacts", {
                requested: String(item.localEvidence.requestedQuantity ?? "—"),
                cached: String(item.localEvidence.cachedOnHand ?? "—"),
                server: String(item.serverEvidence.canonicalOnHandAtSync ?? "—"),
                short: String(item.quantity ?? "—"),
              })}
            </Fact>
          </>
        ) : null}
        {item.kind === "voucher" &&
        ("observedRemaining" in item.localEvidence || "serverRemaining" in item.serverEvidence) ? (
          <Fact label={t("conflicts.voucherUsage")}>
            {t("conflicts.voucherFacts", {
              observed: remainingLabel(item.localEvidence.observedRemaining, t),
              server: remainingLabel(item.serverEvidence.serverRemaining, t),
            })}
          </Fact>
        ) : null}
        {item.amountMinor !== null && item.currency ? (
          <Fact label={t("conflicts.amount")}>
            {formatMoney(item.amountMinor, item.currency, locale)}
          </Fact>
        ) : null}
        <Fact label={t("conflicts.reference")} mono>
          {item.localReference ?? item.syncCommandId ?? "—"}
        </Fact>
        {item.references.orderId ? (
          <Fact label={t("conflicts.order")} mono>
            {item.references.orderId}
          </Fact>
        ) : null}
        <Fact label={t("conflicts.timeline")}>
          {t("conflicts.timelineValue", {
            local: item.localEventAt ? formatDateTime(item.localEventAt, locale) : "—",
            detected: formatDateTime(item.detectedAt, locale),
          })}
        </Fact>
      </dl>
      <p className="conflict-card__next">{t(`conflicts.next.${item.kind}`)}</p>
    </li>
  );
}

function Fact({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="conflict-card__fact">
      <dt>{label}</dt>
      <dd className={mono ? "conflict-card__mono" : undefined}>{children}</dd>
    </div>
  );
}

/** Remaining-usage evidence: absent ⇒ "—", JSON null ⇒ no finite limit. */
function remainingLabel(value: unknown, t: (key: string) => string): string {
  if (value === undefined) return "—";
  if (value === null) return t("conflicts.unlimited");
  return String(value);
}
