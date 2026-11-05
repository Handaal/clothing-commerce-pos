// Device-local POS floor-staff auth (the shifted-cafe model): username + numeric PIN accounts stored
// and verified entirely in the main process, independent of Clerk. This is the visible login gate and
// per-operator section access; the underlying API session (Clerk) is untouched. The renderer never
// receives a PIN hash — only public user shapes cross this boundary.

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
 * Login outcome. Success carries the public operator. Failure is collapsed to a single shape so the
 * UI cannot (and does not) distinguish an unknown username from a wrong PIN.
 */
export type PosLoginResult = { readonly ok: true; readonly user: PosUser } | { readonly ok: false };

export interface PosUserInput {
  readonly username: string;
  readonly name: string;
  readonly role: PosRole;
  readonly pin: string;
  readonly permissions?: readonly string[] | null;
}

export interface PosUserUpdate {
  readonly name?: string;
  readonly role?: PosRole;
  readonly permissions?: readonly string[] | null;
  readonly active?: boolean;
}

/**
 * Local-auth bridge exposed to the renderer as `window.posAuth`. When this bridge is absent (e.g. a
 * non-Electron test host), the renderer leaves the local gate inactive and behaves exactly as before.
 */
export interface PosAuthBridge {
  /** Number of local accounts that exist — 0 means first-run (seed the first admin). */
  count(): Promise<number>;
  /** Active, login-capable accounts for the username picker. */
  roster(): Promise<readonly PosRosterEntry[]>;
  /** Verify username + PIN entirely in the main process. */
  login(username: string, pin: string): Promise<PosLoginResult>;
  /** Full account list for the admin management screen (no PIN hashes). */
  listUsers(): Promise<readonly PosUser[]>;
  /** Create an account. The very first account (count === 0) must be an admin. */
  createUser(input: PosUserInput): Promise<PosUser>;
  /** Edit name/role/permissions/active. Cannot demote or deactivate the last active admin. */
  updateUser(id: string, update: PosUserUpdate): Promise<PosUser>;
  /** Reset an account's PIN. */
  setPin(id: string, pin: string): Promise<void>;
  /** Re-verify a specific account's PIN — used for admin approval of sensitive actions. */
  verifyPin(id: string, pin: string): Promise<boolean>;
  /**
   * Replace the display-only roster cache with the server's pos_pin accounts (called by the admin Team
   * desk after a server read/write), so the pre-auth floor picker stays populated and offline-capable.
   */
  replaceRosterCache(entries: readonly PosRosterCacheEntry[]): Promise<void>;
}

export const POS_AUTH_IPC_CHANNELS = Object.freeze({
  count: "pos-auth:count",
  roster: "pos-auth:roster",
  login: "pos-auth:login",
  listUsers: "pos-auth:list-users",
  createUser: "pos-auth:create-user",
  updateUser: "pos-auth:update-user",
  setPin: "pos-auth:set-pin",
  verifyPin: "pos-auth:verify-pin",
  replaceRosterCache: "pos-auth:replace-roster",
});

/** Error codes thrown by management mutations (surfaced to the admin screen). */
export type PosAuthErrorCode =
  | "USERNAME_TAKEN"
  | "INVALID_USERNAME"
  | "INVALID_NAME"
  | "INVALID_PIN"
  | "INVALID_ROLE"
  | "USER_NOT_FOUND"
  | "LAST_ADMIN"
  | "FIRST_USER_MUST_BE_ADMIN";

export const POS_PIN_MIN_LENGTH = 4;
export const POS_PIN_MAX_LENGTH = 8;
