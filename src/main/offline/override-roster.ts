import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { OsSecureStorage } from "./device-key";

/**
 * ADR-042 §6.3 — the till's copy of the qualifying admins' POS override-password verifiers.
 *
 * - Verifier v2 ("scrypt-hmac-sha256-v2"): the server keeps only a one-way verifier V = scrypt(password, salt)
 *   and sends this till salt + cost + tag = HMAC-SHA256(V, "pos-override-v2" ‖ deviceId ‖ membershipId ‖
 *   verifierVersion). The till recomputes the tag from the typed password. Neither side holds plaintext or a
 *   recoverable copy, and a tag is useless on another device, for another admin or after a version bump.
 *   Must stay byte-identical to `clothing-commerce-api/src/pos/override-password-crypto.ts`. Any other
 *   algorithm (including the retired v1 device-bound scrypt hash) is ignored: fail closed.
 * - The roster is sealed with the OS key store (Electron safeStorage) and written to its own file in the
 *   user-data folder. It is never stored in SQLite.
 * - Verification runs in the main process only. 5 failures for a username lock that username for 5 minutes,
 *   and the lockout survives a restart (it is part of the sealed file).
 * - A successful check returns a one-use assertion bound to one command. The command carries only that.
 */
export type OverridePermission = "promotions.manage" | "payments.refund";

export interface OverrideRosterEntry {
  readonly membershipId: string;
  readonly username: string;
  readonly displayName: string;
  readonly permissions: ReadonlyArray<OverridePermission>;
  readonly verifierVersion: number;
  readonly verifier: {
    readonly algorithm: typeof OVERRIDE_VERIFIER_ALGORITHM;
    readonly saltBase64: string;
    readonly deviceTagBase64: string;
    readonly n: number;
    readonly r: number;
    readonly p: number;
    readonly keyLength: number;
  };
  readonly expiresAt: string;
}

export const OVERRIDE_VERIFIER_ALGORITHM = "scrypt-hmac-sha256-v2" as const;
const DEVICE_TAG_CONTEXT = "pos-override-v2";

function deviceTag(
  serverVerifier: Buffer,
  deviceId: string,
  membershipId: string,
  verifierVersion: number,
): Buffer {
  return createHmac("sha256", serverVerifier)
    .update(
      [DEVICE_TAG_CONTEXT, deviceId, membershipId, String(verifierVersion)].join("\u0000"),
      "utf8",
    )
    .digest();
}

/**
 * Test/fixture helper mirroring the SERVER side: derive the v2 device verifier from a password. Production
 * tills never call this (they only receive the tag); it exists so tests use the real wire format.
 */
export function deriveOverrideDeviceVerifierForTest(options: {
  readonly password: string;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly verifierVersion: number;
  readonly n?: number;
}): OverrideRosterEntry["verifier"] {
  const n = options.n ?? 16_384;
  const salt = randomBytes(16);
  const serverVerifier = scryptSync(options.password, salt, 32, {
    N: n,
    r: 8,
    p: 1,
    maxmem: maxmem(n, 8),
  });
  return {
    algorithm: OVERRIDE_VERIFIER_ALGORITHM,
    saltBase64: salt.toString("base64"),
    deviceTagBase64: deviceTag(
      serverVerifier,
      options.deviceId,
      options.membershipId,
      options.verifierVersion,
    ).toString("base64"),
    n,
    r: 8,
    p: 1,
    keyLength: 32,
  };
}

export interface OverrideAssertion {
  readonly assertionId: string;
  readonly adminMembershipId: string;
  readonly permission: OverridePermission;
  readonly verifierVersion: number;
  readonly commandId: string;
  readonly offlineGrantId: string;
}

export type OverrideCheckResult =
  | { readonly ok: true; readonly assertion: OverrideAssertion; readonly displayName: string }
  | {
      readonly ok: false;
      readonly reason: "INVALID" | "THROTTLED" | "NOT_AUTHORIZED" | "UNAVAILABLE";
    };

interface SealedState {
  readonly version: 2;
  readonly offlineGrantId: string | null;
  readonly deviceId: string | null;
  readonly entries: ReadonlyArray<OverrideRosterEntry>;
  readonly lockouts: Record<string, { failures: number; lockedUntil: number }>;
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;
const DUMMY_SALT = Buffer.alloc(16, 9);
const EMPTY: SealedState = {
  version: 2,
  offlineGrantId: null,
  deviceId: null,
  entries: [],
  lockouts: {},
};

function normalize(username: string): string {
  return username.trim().toLowerCase();
}
function maxmem(n: number, r: number): number {
  return 256 * n * r + 1024 * 1024;
}

export function overrideRosterPath(userDataPath: string): string {
  return join(userDataPath, "offline", "override-roster.sealed");
}

export class OverrideRosterStore {
  constructor(
    private readonly path: string,
    private readonly secureStorage: OsSecureStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Replace the roster with the one delivered by a fresh bootstrap (lockouts are kept). */
  install(
    offlineGrantId: string,
    deviceId: string,
    entries: ReadonlyArray<OverrideRosterEntry>,
  ): void {
    const current = this.read();
    this.write({
      version: 2,
      offlineGrantId,
      deviceId,
      // Only v2 verifiers are kept; anything else (e.g. a retired v1 hash) is dropped: fail closed.
      entries: entries
        .filter((entry) => entry.verifier?.algorithm === OVERRIDE_VERIFIER_ALGORITHM)
        .map((entry) => ({ ...entry, username: normalize(entry.username) })),
      lockouts: current.lockouts,
    });
  }

  /** Admins who can approve the given permission at this till right now (names only, no secrets). */
  listApprovers(
    permission: OverridePermission,
  ): ReadonlyArray<{ username: string; displayName: string }> {
    const state = this.read();
    const now = this.now().valueOf();
    return state.entries
      .filter(
        (entry) => entry.permissions.includes(permission) && Date.parse(entry.expiresAt) > now,
      )
      .map((entry) => ({ username: entry.username, displayName: entry.displayName }));
  }

  /**
   * Check an admin's POS username + override password for one command. Constant-ish timing for an unknown
   * username; failures are counted per username and persisted.
   */
  check(input: {
    readonly username: string;
    readonly password: string;
    readonly permission: OverridePermission;
    readonly commandId: string;
  }): OverrideCheckResult {
    if (!this.secureStorage.isEncryptionAvailable()) return { ok: false, reason: "UNAVAILABLE" };
    const state = this.read();
    if (state.offlineGrantId === null || state.deviceId === null) {
      return { ok: false, reason: "UNAVAILABLE" };
    }
    const username = normalize(input.username);
    if (username === "" || input.password === "") return { ok: false, reason: "INVALID" };
    const now = this.now().valueOf();
    const lock = state.lockouts[username];
    if (lock && now < lock.lockedUntil) return { ok: false, reason: "THROTTLED" };

    const entry = state.entries.find((item) => item.username === username);
    if (!entry) {
      scryptSync(input.password, DUMMY_SALT, 32, {
        N: 16_384,
        r: 8,
        p: 1,
        maxmem: maxmem(16_384, 8),
      });
      this.recordFailure(state, username, now);
      return { ok: false, reason: "INVALID" };
    }
    if (entry.verifier.algorithm !== OVERRIDE_VERIFIER_ALGORITHM) {
      this.recordFailure(state, username, now);
      return { ok: false, reason: "INVALID" };
    }
    const derived = scryptSync(
      input.password,
      Buffer.from(entry.verifier.saltBase64, "base64"),
      entry.verifier.keyLength,
      {
        N: entry.verifier.n,
        r: entry.verifier.r,
        p: entry.verifier.p,
        maxmem: maxmem(entry.verifier.n, entry.verifier.r),
      },
    );
    const candidate = deviceTag(derived, state.deviceId, entry.membershipId, entry.verifierVersion);
    const expected = Buffer.from(entry.verifier.deviceTagBase64, "base64");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      this.recordFailure(state, username, now);
      return { ok: false, reason: "INVALID" };
    }
    // Correct password: clear the counter before checking authority, so a valid admin is not locked out.
    if (state.lockouts[username]) {
      const lockouts = { ...state.lockouts };
      delete lockouts[username];
      this.write({ ...state, lockouts });
    }
    if (!entry.permissions.includes(input.permission) || Date.parse(entry.expiresAt) <= now) {
      return { ok: false, reason: "NOT_AUTHORIZED" };
    }
    return {
      ok: true,
      displayName: entry.displayName,
      assertion: {
        assertionId: randomUUID(),
        adminMembershipId: entry.membershipId,
        permission: input.permission,
        verifierVersion: entry.verifierVersion,
        commandId: input.commandId,
        offlineGrantId: state.offlineGrantId,
      },
    };
  }

  private recordFailure(state: SealedState, username: string, now: number): void {
    const current = state.lockouts[username] ?? { failures: 0, lockedUntil: 0 };
    const failures = current.failures + 1;
    const next =
      failures >= MAX_FAILURES
        ? { failures: 0, lockedUntil: now + LOCKOUT_MS }
        : { failures, lockedUntil: 0 };
    this.write({ ...state, lockouts: { ...state.lockouts, [username]: next } });
  }

  private read(): SealedState {
    if (!existsSync(this.path)) return EMPTY;
    try {
      const plain = this.secureStorage.decryptString(readFileSync(this.path));
      const parsed = JSON.parse(plain) as
        SealedState | { version: 1; lockouts?: SealedState["lockouts"] };
      if (parsed.version === 2) return parsed;
      // A v1 file (retired verifier format): keep only the persisted lockouts so an upgrade cannot reset
      // a running lockout; the roster stays empty until the next online bootstrap delivers v2 verifiers.
      if (parsed.version === 1) return { ...EMPTY, lockouts: parsed.lockouts ?? {} };
      return EMPTY;
    } catch {
      // Unreadable (key store changed, file damaged): fail closed with an empty roster.
      return EMPTY;
    }
  }

  private write(state: SealedState): void {
    if (!this.secureStorage.isEncryptionAvailable()) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, this.secureStorage.encryptString(JSON.stringify(state)), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}
