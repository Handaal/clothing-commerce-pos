// Shared offline desk-status contract.
//
// Every POS desk (cashier, orders, inventory, …) renders the *same* honest status derived from the
// one authoritative connectivity/sync signal the shell already owns (`syncStatus.networkOnline` +
// `offlineReadiness` + the durable `PendingSyncSummary`). Desks declare *what they can do offline*
// via a single `DeskOfflineCapability`; this module turns that plus the live signal into a concrete,
// localized status. No desk re-implements its own ad-hoc `navigator.onLine` check.
//
// Deliberately dependency-free (only the shared offline types) so it is trivially unit-testable and
// identical in the main/renderer/test hosts.

import type {
  OfflineReadiness,
  OfflineSyncStatus,
  OfflineUnavailableReason,
} from "../../shared/offline";

/**
 * What a desk is capable of while the device is offline. This is a *static* property of the desk
 * (does it have a durable local write path, a cached read snapshot, device-local data, …), not a
 * runtime state — the runtime state is computed from it plus the live signal.
 */
export type DeskOfflineCapability =
  // Durable local writes available offline: the desk persists signed commands to the outbox and the
  // server accepts/reconciles them on reconnect (cashier sale, attendance capture).
  | "offline-writes"
  // Read-only cached snapshot available offline; no offline mutation (orders re-open from cache).
  | "cached-read"
  // Device-local data that is fully available offline because it never needed the server to begin
  // with (the activity ledger; the local pending-sync report projection).
  | "local-only"
  // Requires live server authority; no safe offline path today (inventory ledger, suppliers AP,
  // server reports, device governance).
  | "online-only"
  // Intentionally unavailable offline and fails closed as a policy decision even when some data is
  // cached (returns without a server return-grant; applying promotions offline).
  | "blocked";

/**
 * The concrete runtime status a desk shows. One of six states the brief enumerates:
 *  - online                 — connected; authority is live
 *  - offline-ready          — offline, durable local writes available
 *  - cached-readonly        — offline, read-only snapshot (with age)
 *  - local-only             — offline, device-local data is complete for what it covers
 *  - queued                 — offline/online, provisional actions awaiting server acceptance
 *  - blocked-authority      — offline but the offline authority/data is missing or expired
 *  - online-only            — this desk's action needs a connection; carries a precise reason
 */
export type DeskStatusKind =
  | "online"
  | "offline-ready"
  | "cached-readonly"
  | "local-only"
  | "queued"
  | "blocked-authority"
  | "online-only";

export type DeskStatusTone = "good" | "info" | "warn" | "bad";

export interface DeskStatusInput {
  readonly capability: DeskOfflineCapability;
  readonly networkOnline: boolean;
  readonly readiness: OfflineReadiness;
  readonly sync: OfflineSyncStatus;
  /**
   * Precise reason this desk is online-only/blocked, as an i18n key. Required for `online-only`/
   * `blocked` desks so the UI never shows a bare "needs connection" without saying *why*.
   */
  readonly reasonKey?: string;
  /** For cached-read/local-only desks: when the shown snapshot was captured (ISO) — the age. */
  readonly snapshotAt?: string | null;
}

export interface DeskStatus {
  readonly kind: DeskStatusKind;
  readonly tone: DeskStatusTone;
  /** i18n key for the one-line status title (e.g. "desk.status.offlineReady"). */
  readonly titleKey: string;
  /** i18n key for the supporting detail line. */
  readonly detailKey: string;
  /** For online-only/blocked: the precise reason key the desk supplied. */
  readonly reasonKey?: string;
  /** For cached/local desks: snapshot capture time (ISO) so the UI can show "as of …". */
  readonly snapshotAt: string | null;
  /** Provisional local actions awaiting server acceptance (pending + leased + retry-waiting). */
  readonly pendingCount: number;
  /** Actions the server could not accept cleanly (needs reconciliation + permanently blocked sync). */
  readonly unresolvedCount: number;
  /** Last time a sync was attempted (success or failure), ISO, or null if never. */
  readonly lastSyncAt: string | null;
}

/** i18n key for a human reason behind a missing/expired offline authority. */
export function readinessReasonKey(reason: OfflineUnavailableReason): string {
  return `desk.reason.${reason}`;
}

function waitingCount(sync: OfflineSyncStatus): number {
  return sync.pending + sync.leased + sync.retryWait;
}

function unresolvedCount(sync: OfflineSyncStatus): number {
  return sync.needsReconciliation + sync.blocked;
}

/**
 * The single decision function. Given a desk's capability and the live signal, returns the honest
 * status to render. Pure and total — every branch returns a concrete `DeskStatus`.
 *
 * Invariants enforced here (so no desk can accidentally violate them):
 *  - An online-only or blocked desk is NEVER shown as "offline-ready" just because the device is
 *    offline — hiding the error is not the same as having an offline path.
 *  - Unresolved (needs-reconciliation / permanently-blocked) counts are surfaced in every state,
 *    online included, so a desk can point the operator at the cashier's reconciliation queue.
 *  - A missing/expired offline authority on a would-be offline-writes desk degrades to
 *    `blocked-authority` with the precise readiness reason, not a false "ready".
 */
export function deskStatus(input: DeskStatusInput): DeskStatus {
  const { capability, networkOnline, readiness, sync, reasonKey } = input;
  const pendingCount = waitingCount(sync);
  const unresolved = unresolvedCount(sync);
  const snapshotAt = input.snapshotAt ?? null;
  const base = {
    reasonKey,
    snapshotAt,
    pendingCount,
    unresolvedCount: unresolved,
    lastSyncAt: sync.lastAttemptAt,
  };

  // Connected: authority is live. We still surface pending/unresolved so the operator is never
  // told "all good" while provisional or unreconciled work exists.
  if (networkOnline) {
    if (unresolved > 0) {
      return {
        ...base,
        kind: "queued",
        tone: "warn",
        titleKey: "desk.status.needsAttention",
        detailKey: "desk.status.needsAttention.detail",
      };
    }
    if (pendingCount > 0) {
      return {
        ...base,
        kind: "queued",
        tone: "info",
        titleKey: "desk.status.syncing",
        detailKey: "desk.status.syncing.detail",
      };
    }
    return {
      ...base,
      kind: "online",
      tone: "good",
      titleKey: "desk.status.online",
      detailKey: "desk.status.online.detail",
    };
  }

  // Offline from here on.
  switch (capability) {
    case "offline-writes": {
      if (!readiness.ready) {
        return {
          ...base,
          kind: "blocked-authority",
          tone: "bad",
          titleKey: "desk.status.blockedAuthority",
          detailKey: "desk.status.blockedAuthority.detail",
          // The precise readiness reason always wins over any desk-supplied reason here.
          reasonKey: readinessReasonKey(readiness.reason),
        };
      }
      if (unresolved > 0) {
        return {
          ...base,
          kind: "queued",
          tone: "warn",
          titleKey: "desk.status.needsAttention",
          detailKey: "desk.status.needsAttention.detail",
        };
      }
      if (pendingCount > 0) {
        return {
          ...base,
          kind: "queued",
          tone: "info",
          titleKey: "desk.status.queued",
          detailKey: "desk.status.queued.detail",
        };
      }
      return {
        ...base,
        kind: "offline-ready",
        tone: "good",
        titleKey: "desk.status.offlineReady",
        detailKey: "desk.status.offlineReady.detail",
      };
    }
    case "cached-read":
      return {
        ...base,
        kind: "cached-readonly",
        tone: "info",
        titleKey: "desk.status.cachedReadonly",
        detailKey: "desk.status.cachedReadonly.detail",
      };
    case "local-only":
      return {
        ...base,
        kind: "local-only",
        tone: "info",
        titleKey: "desk.status.localOnly",
        detailKey: "desk.status.localOnly.detail",
      };
    case "blocked":
      return {
        ...base,
        kind: "online-only",
        tone: "bad",
        titleKey: "desk.status.blocked",
        detailKey: "desk.status.blocked.detail",
      };
    case "online-only":
    default:
      return {
        ...base,
        kind: "online-only",
        tone: "warn",
        titleKey: "desk.status.onlineOnly",
        detailKey: "desk.status.onlineOnly.detail",
      };
  }
}
