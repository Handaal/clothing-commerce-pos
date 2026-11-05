// POS-native (pos_pin) connected session: a username + numeric PIN authenticates against the Commerce
// API, which issues a short-lived access token the POS feeds to its own SDK client. The Electron main
// process owns that token (OS-encrypted on disk via safeStorage); the renderer only ever receives the
// operator to render plus the raw bearer for its own SDK client — exactly as the Clerk JWT crossed the
// boundary before the pos_pin cutover. This is the connected floor login that REPLACES Clerk for POS
// staff. Clerk is retained solely for owner/admin account provisioning (see PosUsersManager).
//
// When this bridge is absent (e.g. a non-Electron test host) the renderer behaves as a signed-out,
// offline-only shell exactly as it did when the Clerk bridge was absent.

export type PosOperatorRole = "admin" | "cashier";

/** The authoritative operator the server resolved at sign-in; drives the sidebar + audit attribution. */
export interface PosSessionOperator {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: PosOperatorRole;
  readonly permissions: readonly string[];
}

/** What the renderer learns about the live session — never the raw access token. */
export interface PosSessionSnapshot {
  readonly operator: PosSessionOperator;
  readonly expiresAt: string;
}

/**
 * Login outcome. Success carries the resolved session. Failure is collapsed so the UI cannot (and does
 * not) distinguish an unknown username from a wrong PIN; `OFFLINE`/`NOT_CONFIGURED` are separated only
 * so the floor can be steered to the offline PIN path or an owner told to finish provisioning.
 */
export type PosSessionLoginResult =
  | { readonly ok: true; readonly session: PosSessionSnapshot }
  | {
      readonly ok: false;
      readonly reason: "INVALID_CREDENTIALS" | "NOT_CONFIGURED" | "OFFLINE" | "ERROR";
    };

/**
 * Outcome of a step-up credential check (see `verifyCredentials`). Unlike `login` this never mints or
 * replaces the cached session, so it is safe for a supervisor to approve an action on a cashier's till
 * without hijacking the active session. Success carries the resolved role so the caller can require an
 * admin; failure mirrors `login`'s reasons so callers can fall back to the offline roster when the
 * server is unreachable.
 */
export type PosSessionVerifyResult =
  | { readonly ok: true; readonly role: PosOperatorRole }
  | {
      readonly ok: false;
      readonly reason: "INVALID_CREDENTIALS" | "NOT_CONFIGURED" | "OFFLINE" | "ERROR";
    };

/**
 * POS-native session bridge exposed to the renderer as `window.posSession`. The access token itself is
 * only returned by `getToken` (for the SDK client's `Authorization` header); `getSession` returns the
 * renderable operator without it.
 */
export interface PosSessionBridge {
  /** Verify username + PIN against the server; on success caches the access token in the main process. */
  login(username: string, pin: string): Promise<PosSessionLoginResult>;
  /**
   * Verify username + PIN against the server WITHOUT caching or replacing the live session — the
   * authoritative step-up check for admin-gated actions on a connected till.
   */
  verifyCredentials(username: string, pin: string): Promise<PosSessionVerifyResult>;
  /** The live session (operator + expiry) when a non-expired token is cached, else null. */
  getSession(): Promise<PosSessionSnapshot | null>;
  /** The cached access token for the renderer's SDK client; null when absent or expired. */
  getToken(): Promise<string | null>;
  /** Clear the cached session (sign out / lock). */
  logout(): Promise<void>;
}

export const POS_SESSION_IPC_CHANNELS = Object.freeze({
  login: "pos-session:login",
  verifyCredentials: "pos-session:verify-credentials",
  getSession: "pos-session:get-session",
  getToken: "pos-session:get-token",
  logout: "pos-session:logout",
});
