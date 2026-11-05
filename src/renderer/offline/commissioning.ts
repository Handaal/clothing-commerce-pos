import type { OfflineReadiness } from "../../shared/offline";

// Offline selling is a server-issued capability that must be armed at least once over a connection
// before a later outage can be survived. These are the readiness reasons that mean the device has
// simply never been commissioned (or had its grant cleared): a first connected arming fully resolves
// them. They are distinct from lapsed grants (GRANT_EXPIRED/CATALOG_EXPIRED — the opportunistic
// auto-refresh keeps those topped up) and from genuine faults (key/binding/clock/policy), which
// arming does not fix.
const COMMISSIONING_PENDING_REASONS: ReadonlySet<string> = new Set([
  "DEVICE_NOT_ENROLLED",
  "GRANT_MISSING",
]);

/**
 * True when offline selling has never been established on this install and a one-time connected
 * arming would establish it. Drives the first-run commissioning prompt: the operator is nudged to
 * arm the register for offline while connected, so the till keeps selling if the connection is down
 * at opening. Pure so the policy is unit-tested without the connected-shell machinery.
 */
export function needsCommissioning(readiness: OfflineReadiness): boolean {
  if (readiness.ready) return false;
  return COMMISSIONING_PENDING_REASONS.has(readiness.reason);
}
