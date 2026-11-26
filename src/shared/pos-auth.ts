// POS operator shapes + the display-only roster-cache bridge (ADR-043). The API is the ONLY POS credential
// authority: online sign-in and admin step-up go through `window.posSession` (server), offline sign-in through
// the device-bound offline verifier (`window.offline.verifyStaffPin`). There is no device-local account store
// any more: `pos_users` caches who appears on the pre-auth roster picker (no PIN, no hash). Clerk plays no
// part in the POS.

export type PosRole = "admin" | "cashier";

/** Public operator shape (never carries the PIN hash). */
export interface PosUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly role: PosRole;
  /** Granted section ids for a cashier; null = role default (selling only). Admins ignore this. */
  readonly permissions: readonly string[] | null;
  readonly active: boolean;
}

/** One entry in the login-screen roster picker (active, login-capable accounts only). */
export interface PosRosterEntry {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly role: PosRole;
}

/**
 * A roster-cache entry mirrored from the server's pos_pin accounts (via the admin Team desk). Since
 * pos_pin accounts are verified by the server (online) or the device-bound `staff_roster` (offline), this
 * device-local cache is DISPLAY-ONLY — it populates the pre-auth floor roster picker, which runs before
 * any session exists and so cannot query the server. No PIN crosses this boundary.
 */
export interface PosRosterCacheEntry {
  readonly username: string;
  readonly name: string;
  readonly role: PosRole;
  readonly active: boolean;
}

/**
 * Display-only roster-cache bridge exposed to the renderer as `window.posAuth`. It never authenticates: it has
 * no login, PIN or verify method. When absent (a non-Electron test host) the floor login stays inactive.
 */
export interface PosAuthBridge {
  /** Number of cached roster entries (active or not) — 0 means a fresh till with no cached roster yet. */
  count(): Promise<number>;
  /** Active cached accounts for the username picker (inactive accounts never appear). */
  roster(): Promise<readonly PosRosterEntry[]>;
  /**
   * Replace the display-only roster cache with the server's pos_pin accounts (called by the admin Team desk
   * after a server read/write). Entries carry no secret.
   */
  replaceRosterCache(entries: readonly PosRosterCacheEntry[]): Promise<void>;
}

export const POS_AUTH_IPC_CHANNELS = Object.freeze({
  count: "pos-auth:count",
  roster: "pos-auth:roster",
  replaceRosterCache: "pos-auth:replace-roster",
});

/**
 * ADR-043 §6 — THE POS PIN rule (mirrors the API's `PosPinSchema`): ASCII digits 0-9 only, at least 4, and NO
 * product maximum. Nothing may truncate a PIN.
 */
export const POS_PIN_MIN_LENGTH = 4;

/**
 * Transport ceiling for a credential string crossing IPC — the same bound as the API's 16 KiB request body for
 * credential routes (a PIN that cannot fit that request could never be verified). An INFRASTRUCTURE limit
 * against oversized messages, NOT a PIN-length rule; exceeding it is a malformed message, never a truncation.
 */
export const POS_CREDENTIAL_MAX_CHARS = 16_384;

/** True for a well-formed POS PIN (digits only, min 4, no product maximum). */
export function isPosPinFormat(value: unknown): value is string {
  return typeof value === "string" && value.length >= POS_PIN_MIN_LENGTH && /^[0-9]+$/.test(value);
}

/** True when `value` is a well-formed POS PIN that also fits the credential transport ceiling. */
export function isTransportablePosPin(value: unknown): value is string {
  return isPosPinFormat(value) && value.length <= POS_CREDENTIAL_MAX_CHARS;
}
