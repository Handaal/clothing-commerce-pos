import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { OfflineStaffPinInput, OfflineStaffPinResult } from "../../shared/offline";
import { LocalDatabase } from "./database";

// Per-username failure throttle. Verification is local and the PIN space is small, so a stolen or
// shoulder-surfed device could otherwise be brute-forced offline; after a short burst of failures we
// lock that username for a cooldown. State is in-memory (per main-process lifetime) by design — a
// restart is itself a meaningful reset, and no secret is persisted to widen an attack surface.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;

// Timing-equalisation parameters for the unknown-username path: a throwaway scrypt derivation so a
// probe cannot distinguish "no such user" (fast) from "wrong PIN" (slow) by response latency.
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_KEY_LENGTH = 32;
const DUMMY_SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

interface RosterRow {
  membership_id: string;
  username: string;
  display_name: string;
  pin_salt_base64: string;
  pin_hash_base64: string;
  scrypt_n: number;
  scrypt_r: number;
  scrypt_p: number;
  key_length: number;
}

interface ThrottleState {
  failures: number;
  lockedUntil: number;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

// scrypt memory ceiling must comfortably exceed 128 * N * r (plus internal overhead) or node throws.
function scryptMaxMem(n: number, r: number): number {
  return 256 * n * r + 1024 * 1024;
}

export class StaffRosterStore {
  private readonly attempts = new Map<string, ThrottleState>();

  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Count of roster entries attached to the currently active grant snapshot. */
  countActive(): number {
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count
         FROM staff_roster r
         JOIN catalog_snapshot c ON c.snapshot_id = r.snapshot_id AND c.state = 'active'`,
      )
      .get() as { count: number };
    return Number(row.count);
  }

  verifyPin(input: OfflineStaffPinInput): OfflineStaffPinResult {
    const username = normalizeUsername(input.username);
    const pin = input.pin;
    if (username.length === 0 || pin.length === 0) return { ok: false, reason: "INVALID" };

    const now = this.now().valueOf();
    const throttle = this.attempts.get(username);
    if (throttle && now < throttle.lockedUntil) return { ok: false, reason: "THROTTLED" };

    const deviceId = this.activeDeviceId();
    if (!deviceId) return { ok: false, reason: "UNAVAILABLE" };

    const row = this.lookup(username);
    if (!row) {
      // Equalise timing against the found-user path, then fail with the same collapsed reason.
      scryptSync(pin, DUMMY_SALT, DUMMY_KEY_LENGTH, {
        ...DUMMY_SCRYPT,
        maxmem: scryptMaxMem(DUMMY_SCRYPT.N, DUMMY_SCRYPT.r),
      });
      this.recordFailure(username, now);
      return { ok: false, reason: "INVALID" };
    }

    // Device binding: the server derives the verifier over (salt || deviceId), so a roster copied to
    // another install cannot be verified there even with the correct PIN.
    const salt = Buffer.concat([
      Buffer.from(row.pin_salt_base64, "base64"),
      Buffer.from(deviceId, "utf8"),
    ]);
    const derived = scryptSync(pin, salt, row.key_length, {
      N: row.scrypt_n,
      r: row.scrypt_r,
      p: row.scrypt_p,
      maxmem: scryptMaxMem(row.scrypt_n, row.scrypt_r),
    });
    const expected = Buffer.from(row.pin_hash_base64, "base64");
    const match = derived.length === expected.length && timingSafeEqual(derived, expected);
    if (!match) {
      this.recordFailure(username, now);
      return { ok: false, reason: "INVALID" };
    }

    this.attempts.delete(username);
    return {
      ok: true,
      operator: {
        membershipId: row.membership_id,
        username: row.username,
        displayName: row.display_name,
      },
    };
  }

  private lookup(username: string): RosterRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT r.membership_id, r.username, r.display_name, r.pin_salt_base64, r.pin_hash_base64,
          r.scrypt_n, r.scrypt_r, r.scrypt_p, r.key_length
         FROM staff_roster r
         JOIN catalog_snapshot c ON c.snapshot_id = r.snapshot_id AND c.state = 'active'
         WHERE r.username = ?`,
      )
      .get(username) as RosterRow | undefined;
  }

  private activeDeviceId(): string | undefined {
    const row = this.database.connection
      .prepare("SELECT device_id FROM device_state WHERE singleton_id = 1 AND status = 'active'")
      .get() as { device_id: string | null } | undefined;
    return row?.device_id ?? undefined;
  }

  private recordFailure(username: string, now: number): void {
    const current = this.attempts.get(username) ?? { failures: 0, lockedUntil: 0 };
    const failures = current.failures + 1;
    if (failures >= MAX_FAILURES) {
      this.attempts.set(username, { failures: 0, lockedUntil: now + LOCKOUT_MS });
    } else {
      this.attempts.set(username, { failures, lockedUntil: 0 });
    }
  }
}

// Exposed so callers (and tests) that mint a verifier use the exact binding the store expects. The
// server implements the equivalent of this; keeping one definition documents the contract precisely.
export function deriveStaffPinVerifier(options: {
  readonly pin: string;
  readonly deviceId: string;
  readonly saltBase64?: string;
  readonly n?: number;
  readonly r?: number;
  readonly p?: number;
  readonly keyLength?: number;
}): {
  readonly saltBase64: string;
  readonly hashBase64: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
} {
  const n = options.n ?? 16_384;
  const r = options.r ?? 8;
  const p = options.p ?? 1;
  const keyLength = options.keyLength ?? 32;
  const saltBase64 = options.saltBase64 ?? randomBytes(16).toString("base64");
  const salt = Buffer.concat([
    Buffer.from(saltBase64, "base64"),
    Buffer.from(options.deviceId, "utf8"),
  ]);
  const hashBase64 = scryptSync(options.pin, salt, keyLength, {
    N: n,
    r,
    p,
    maxmem: scryptMaxMem(n, r),
  }).toString("base64");
  return { saltBase64, hashBase64, n, r, p, keyLength };
}
