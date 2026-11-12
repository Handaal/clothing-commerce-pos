import type { OfflineReadiness } from "../../shared/offline";

// How much offline runway must remain before we opportunistically top it up while connected, and how
// often an automatic refresh may be attempted. For a store with an intermittent connection the goal
// is that every window of connectivity silently extends the offline grant, so a later outage starts
// with a full runway instead of a grant that is about to lapse.
export const RUNWAY_REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1_000; // 2 hours
export const AUTO_REFRESH_MIN_INTERVAL_MS = 60 * 1_000; // at most once per minute

// A cached grant lapses for one of several reasons once its windows pass. These are the ones a fresh
// bootstrap actually fixes while connected (the grant/catalog simply expired or is gone). Others —
// never enrolled, bad key, clock rollback, policy exposure reached — are not resolved by refetching
// authority, so we never auto-bootstrap for them.
const AUTO_REFRESHABLE_REASONS: ReadonlySet<string> = new Set([
  "GRANT_EXPIRED",
  "CATALOG_EXPIRED",
  "GRANT_MISSING",
]);

export interface OfflineRunway {
  /** ISO instant the offline grant stops being usable: the earlier of accept/catalog windows. */
  readonly validUntil: string;
  /** Milliseconds until that instant; negative once the grant has lapsed. */
  readonly millisRemaining: number;
  /** True when the runway is within the refresh threshold (or already lapsed). */
  readonly low: boolean;
}

export function offlineRunway(readiness: OfflineReadiness, now: number): OfflineRunway | null {
  if (!readiness.ready) return null;
  const until = Math.min(
    Date.parse(readiness.acceptedUntil),
    Date.parse(readiness.catalogValidUntil),
  );
  const millisRemaining = until - now;
  return {
    validUntil: new Date(until).toISOString(),
    millisRemaining,
    low: millisRemaining < RUNWAY_REFRESH_THRESHOLD_MS,
  };
}

export type RunwayLabel =
  | { readonly kind: "hours"; readonly value: number }
  | { readonly kind: "minutes"; readonly value: number }
  | { readonly kind: "expired" };

export function runwayLabel(millisRemaining: number): RunwayLabel {
  if (millisRemaining <= 0) return { kind: "expired" };
  const minutes = Math.floor(millisRemaining / 60_000);
  if (minutes >= 60) return { kind: "hours", value: Math.floor(minutes / 60) };
  return { kind: "minutes", value: Math.max(1, minutes) };
}

export interface AutoRefreshInput {
  readonly readiness: OfflineReadiness;
  /** Signed in to Clerk with a tenant and register resolved, so an operator token is obtainable. */
  readonly connected: boolean;
  readonly networkOnline: boolean;
  /** A bootstrap (manual or automatic) is already in flight. */
  readonly refreshing: boolean;
  readonly now: number;
  readonly lastAttemptAt: number | null;
}

/**
 * Decide whether to opportunistically re-bootstrap the offline grant. Only while connected and online
 * (a fresh token is needed and the server must be reachable), throttled, and only when the runway is
 * low or the grant has lapsed for a reason a refetch can fix. Pure so the policy is unit-tested
 * without the React/IPC machinery around it.
 */
export function shouldAutoRefreshOffline(input: AutoRefreshInput): boolean {
  if (!input.connected || !input.networkOnline || input.refreshing) return false;
  if (
    input.lastAttemptAt !== null &&
    input.now - input.lastAttemptAt < AUTO_REFRESH_MIN_INTERVAL_MS
  ) {
    return false;
  }
  if (input.readiness.ready) {
    const runway = offlineRunway(input.readiness, input.now);
    return runway !== null && runway.low;
  }
  return AUTO_REFRESHABLE_REASONS.has(input.readiness.reason);
}
