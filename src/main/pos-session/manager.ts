import type {
  PosSessionLoginResult,
  PosSessionSnapshot,
  PosSessionVerifyResult,
} from "../../shared/pos-session";
import type { PosSessionStore, StoredPosSession } from "./store";

/** What the sign-in hands to the offline PIN refresh (main process only). */
export interface SignedInCredential {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly accessToken: string;
  readonly username: string;
  readonly pin: string;
}

// Narrow structural view of the SDK errors we map, so the manager never needs the ESM-only SDK error
// classes at the CJS boundary. `ApiNetworkError` surfaces as a name; `ApiHttpError` carries status+code.
interface SdkErrorLike {
  readonly name?: string;
  readonly status?: number;
  readonly code?: string;
}

/**
 * ADR-043 §4 — classify a failed online sign-in / step-up. Only a genuine "server unreachable" outcome may lead
 * to offline fallback (`OFFLINE`): no HTTP response at all, or a gateway/availability status (502/503/504) that
 * is not the server's own "not configured" answer. Every 4xx is a DEFINITIVE rejection (wrong PIN, unknown or
 * inactive account, malformed PIN, lockout, oversized request …) and must never fall back offline. Anything
 * else (500, a contract-violating body, an unknown error) is `ERROR`: not proven to be an outage, so callers
 * fail closed.
 */
export function classifyPosAuthFailure(
  error: unknown,
): Exclude<PosSessionLoginResult, { ok: true }>["reason"] {
  const like = (error ?? {}) as SdkErrorLike;
  if (like.name === "ApiNetworkError") return "OFFLINE";
  if (typeof like.status === "number") {
    if (like.code === "POS_AUTH_NOT_CONFIGURED") return "NOT_CONFIGURED";
    if (like.status === 502 || like.status === 503 || like.status === 504) return "OFFLINE";
    if (like.status >= 400 && like.status < 500) return "INVALID_CREDENTIALS";
  }
  return "ERROR";
}

/**
 * Owns the POS-native (pos_pin) session lifecycle in the main process: exchanges username + PIN for a
 * server access token via the SDK's public `posPinLogin`, caches it in the OS-encrypted
 * [[PosSessionStore]], and serves the token/operator back to the renderer. The SDK is imported lazily
 * (it is ESM; the main bundle is CJS) exactly as the offline bootstrap does.
 */
export class PosSessionManager {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly store: PosSessionStore,
    private readonly now: () => Date = () => new Date(),
    /**
     * Offline PIN v2 (same-PIN model): after a successful sign-in the main process prepares offline sign-in on
     * this till with the credential the server just accepted. Fire-and-forget: it never delays or fails the
     * sign-in, and the PIN never leaves the main process except as the server step-up.
     */
    private readonly onSignedIn?: (input: SignedInCredential) => Promise<unknown>,
  ) {}

  async login(username: string, pin: string): Promise<PosSessionLoginResult> {
    try {
      const { createCommerceClient, SDK_VERSION } = await import("@shifted/clothing-commerce-sdk");
      const client = createCommerceClient({
        baseUrl: this.apiBaseUrl,
        client: { type: "pos-desktop", version: SDK_VERSION },
        // The credential IS the authentication; no bearer is required for the public login endpoint.
        getToken: async () => null,
      });
      const response = await client.posPinLogin({ username, pin });
      const session: StoredPosSession = {
        accessToken: response.accessToken,
        expiresAt: response.expiresAt,
        operator: response.operator,
      };
      this.store.save(session);
      if (this.onSignedIn) {
        void this.onSignedIn({
          tenantId: response.operator.tenantId,
          membershipId: response.operator.membershipId,
          accessToken: response.accessToken,
          username,
          pin,
        }).catch(() => undefined);
      }
      return { ok: true, session: { operator: session.operator, expiresAt: session.expiresAt } };
    } catch (error) {
      return { ok: false, reason: classifyPosAuthFailure(error) };
    }
  }

  /**
   * Authoritative step-up check: verify username + PIN against the server via the same public
   * `posPinLogin`, but DISCARD the issued token instead of caching it — the live session is left
   * untouched. Used by the admin gate so a supervisor can approve an action on a cashier's till
   * without replacing the signed-in operator.
   */
  async verifyCredentials(username: string, pin: string): Promise<PosSessionVerifyResult> {
    try {
      const { createCommerceClient, SDK_VERSION } = await import("@shifted/clothing-commerce-sdk");
      const client = createCommerceClient({
        baseUrl: this.apiBaseUrl,
        client: { type: "pos-desktop", version: SDK_VERSION },
        getToken: async () => null,
      });
      const response = await client.posPinLogin({ username, pin });
      return { ok: true, role: response.operator.role };
    } catch (error) {
      return { ok: false, reason: classifyPosAuthFailure(error) };
    }
  }

  getSession(): PosSessionSnapshot | null {
    return this.store.getSnapshot(this.now());
  }

  getToken(): string | null {
    return this.store.getToken(this.now());
  }

  logout(): void {
    this.store.clear();
  }
}
