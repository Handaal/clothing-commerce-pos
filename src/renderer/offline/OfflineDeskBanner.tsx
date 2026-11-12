import type { OfflineReadiness, OfflineSyncStatus } from "../../shared/offline";
import { formatDateTime } from "../format";
import { useI18n } from "../shell/i18n";
import {
  deskStatus,
  type DeskOfflineCapability,
  type DeskStatus,
  type DeskStatusTone,
} from "./desk-status";

const TONE_CLASS: Record<DeskStatusTone, string> = {
  good: "desk-status--good",
  info: "desk-status--info",
  warn: "desk-status--warn",
  bad: "desk-status--bad",
};

export interface OfflineDeskBannerProps {
  readonly capability: DeskOfflineCapability;
  readonly networkOnline: boolean;
  readonly readiness: OfflineReadiness;
  readonly sync: OfflineSyncStatus;
  /** Precise reason this desk is online-only/blocked, as an i18n key. */
  readonly reasonKey?: string;
  /** For cached/local desks: when the shown snapshot was captured (ISO). */
  readonly snapshotAt?: string | null;
}

/**
 * The one banner every desk renders at the top of its body. It owns zero connectivity logic — it
 * derives the honest desk status from the shared `deskStatus()` contract and the shell's single
 * authoritative signal, then renders it localized (EN/AR) and accessibly.
 *
 * When connected with nothing pending it collapses to a single "connected — live data" line so it is
 * unobtrusive; it only grows when there is something honest to say (offline, queued, blocked).
 */
export function OfflineDeskBanner(props: OfflineDeskBannerProps) {
  const { t, locale } = useI18n();
  const status: DeskStatus = deskStatus({
    capability: props.capability,
    networkOnline: props.networkOnline,
    readiness: props.readiness,
    sync: props.sync,
    reasonKey: props.reasonKey,
    snapshotAt: props.snapshotAt,
  });

  const showReason = Boolean(status.reasonKey);
  const showSnapshot =
    (status.kind === "cached-readonly" || status.kind === "local-only") && status.snapshotAt;
  const showPending = status.pendingCount > 0;
  const showUnresolved = status.unresolvedCount > 0;
  const showLastSync = status.lastSyncAt !== null && status.kind !== "online";

  return (
    <div
      className={`desk-status ${TONE_CLASS[status.tone]}`}
      role="status"
      aria-live="polite"
      data-state={status.kind}
    >
      <div className="desk-status__head">
        <strong className="desk-status__title">{t(status.titleKey)}</strong>
        <span className="desk-status__detail">{t(status.detailKey)}</span>
      </div>
      {showReason ? (
        <p className="desk-status__reason">
          {/* status.reasonKey is always set when showReason is true. */}
          {t(status.reasonKey as string)}
        </p>
      ) : null}
      {showSnapshot ? (
        <p className="desk-status__meta">
          {t("desk.status.snapshotAge", {
            when: formatDateTime(status.snapshotAt, locale),
          })}
        </p>
      ) : null}
      {showPending || showUnresolved || showLastSync ? (
        <ul className="desk-status__counts">
          {showPending ? (
            <li data-count="pending">
              {t("desk.status.pendingCount", { count: status.pendingCount })}
            </li>
          ) : null}
          {showUnresolved ? (
            <li data-count="unresolved">
              {t("desk.status.unresolvedCount", { count: status.unresolvedCount })}
            </li>
          ) : null}
          {showLastSync ? (
            <li data-count="last-sync">
              {t("desk.status.lastSync", {
                when: formatDateTime(status.lastSyncAt, locale),
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
