import { randomBytes, scryptSync } from "node:crypto";

import type { OfflineStaffPinInput, OfflineStaffPinResult } from "../../shared/offline";
import { LocalDatabase } from "./database";
import type { OfflinePinEnrollmentStore } from "./offline-pin-enrollment";

// Offline PIN v2: persistent per-username lockout, survives restarts. After MAX_FAILURES wrong PINs the
// username is locked for LOCKOUT_MS; the counter resets on success. Kept in SQLite (`offline_pin_lockout`)
// AND in the OS-sealed enrollment file; the stricter copy wins, so deleting the SQLite row does not reset it.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

interface AuthorizationRow {
  membership_id: string;
  username: string;
  display_name: string;
  enrollment_id: string;
  verifier_version: number;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

// scrypt memory ceiling must comfortably exceed 128 * N * r (plus internal overhead) or node throws.
function scryptMaxMem(n: number, r: number): number {
  return 256 * n * r + 1024 * 1024;
}

/**
 * Offline (no-connection) till unlock. v2: the latest online bootstrap says WHO may unlock this device and at
 * which enrollment version (`offline_pin_authorization`); the verifier itself is device-local and OS-sealed
 * (OfflinePinEnrollmentStore). Server-minted verifiers from KEK-sealed PINs are retired (local schema v23).
 * Verification happens only here, in the main process; the renderer only ever sees the result.
 */
export class StaffRosterStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly enrollments?: OfflinePinEnrollmentStore,
  ) {}

  /** Authorised enrollments on the active snapshot that also have a local sealed verifier. */
  countActive(): number {
    if (!this.enrollments?.isAvailable()) return 0;
    const enrolled = new Set(this.enrollments.enrolledMemberships());
    const rows = this.database.connection
      .prepare(
        `SELECT a.membership_id FROM offline_pin_authorization a
         JOIN catalog_snapshot c ON c.snapshot_id = a.snapshot_id AND c.state = 'active'`,
      )
      .all() as Array<{ membership_id: string }>;
    return rows.filter((row) => enrolled.has(row.membership_id)).length;
  }

  /**
   * After an online bootstrap: drop every local verifier the server no longer authorises for this device
   * (revoked, superseded, membership/permission removed). Exact enrollment id + version must match.
   */
  pruneToAuthorized(): void {
    if (!this.enrollments?.isAvailable()) return;
    const rows = this.database.connection
      .prepare(
        `SELECT a.membership_id, a.enrollment_id, a.verifier_version FROM offline_pin_authorization a
         JOIN catalog_snapshot c ON c.snapshot_id = a.snapshot_id AND c.state = 'active'`,
      )
      .all() as Array<{ membership_id: string; enrollment_id: string; verifier_version: number }>;
    this.enrollments.retainOnly(
      rows.map((row) => ({
        membershipId: row.membership_id,
        enrollmentId: row.enrollment_id,
        verifierVersion: Number(row.verifier_version),
      })),
    );
  }

  verifyPin(input: OfflineStaffPinInput): OfflineStaffPinResult {
    const username = normalizeUsername(input.username);
    const pin = input.pin;
    if (username.length === 0 || pin.length === 0) return { ok: false, reason: "INVALID" };
    if (!this.enrollments?.isAvailable()) return { ok: false, reason: "UNAVAILABLE" };

    const now = this.now().valueOf();
    const lock = this.lockout(username);
    if (lock.lockedUntil !== null && now < Date.parse(lock.lockedUntil)) {
      return { ok: false, reason: "THROTTLED" };
    }
    const deviceId = this.activeDeviceId();
    if (!deviceId || !this.leaseActive(now)) return { ok: false, reason: "UNAVAILABLE" };

    const row = this.lookup(username);
    const match = this.enrollments.matches({
      membershipId: row?.membership_id ?? "",
      enrollmentId: row?.enrollment_id ?? "",
      verifierVersion: row ? Number(row.verifier_version) : 0,
      deviceId,
      pin,
    });
    if (!row || !match) {
      this.recordFailure(username, lock.failures, now);
      return { ok: false, reason: "INVALID" };
    }
    this.clearLockout(username);
    return {
      ok: true,
      operator: {
        membershipId: row.membership_id,
        username: row.username,
        displayName: row.display_name,
      },
    };
  }

  private lookup(username: string): AuthorizationRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT a.membership_id, a.username, a.display_name, a.enrollment_id, a.verifier_version
         FROM offline_pin_authorization a
         JOIN catalog_snapshot c ON c.snapshot_id = a.snapshot_id AND c.state = 'active'
         WHERE a.username = ?`,
      )
      .get(username) as AuthorizationRow | undefined;
  }

  /** Offline unlock never outlives the lease the authorization came with. */
  private leaseActive(now: number): boolean {
    const row = this.database.connection
      .prepare(
        `SELECT g.accepted_until, g.operator_expires_at FROM catalog_snapshot c
         JOIN offline_grant g ON g.grant_id = c.grant_id WHERE c.state = 'active'`,
      )
      .get() as { accepted_until: string; operator_expires_at: string } | undefined;
    return (
      row !== undefined &&
      now <= Date.parse(row.accepted_until) &&
      now <= Date.parse(row.operator_expires_at)
    );
  }

  private activeDeviceId(): string | undefined {
    const row = this.database.connection
      .prepare("SELECT device_id FROM device_state WHERE singleton_id = 1 AND status = 'active'")
      .get() as { device_id: string | null } | undefined;
    return row?.device_id ?? undefined;
  }

  private lockout(username: string): { failures: number; lockedUntil: string | null } {
    const row = this.database.connection
      .prepare("SELECT failures, locked_until FROM offline_pin_lockout WHERE username = ?")
      .get(username) as { failures: number; locked_until: string | null } | undefined;
    const sealed = this.enrollments?.lockout(username) ?? null;
    const failures = Math.max(Number(row?.failures ?? 0), Number(sealed?.failures ?? 0));
    const candidates = [row?.locked_until ?? null, sealed?.lockedUntil ?? null].filter(
      (value): value is string => value !== null && !Number.isNaN(Date.parse(value)),
    );
    const lockedUntil =
      candidates.length === 0
        ? null
        : candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    return { failures, lockedUntil };
  }

  private clearLockout(username: string): void {
    this.database.connection
      .prepare("DELETE FROM offline_pin_lockout WHERE username = ?")
      .run(username);
    this.enrollments?.setLockout(username, null);
  }

  private recordFailure(username: string, previous: number, now: number): void {
    const failures = previous + 1;
    const locked = failures >= MAX_FAILURES;
    // Sealed copy first: if it cannot be written the attempt still counts in SQLite below.
    try {
      this.enrollments?.setLockout(username, {
        failures: locked ? 0 : failures,
        lockedUntil: locked ? new Date(now + LOCKOUT_MS).toISOString() : null,
      });
    } catch {
      /* OS key store unavailable: verifyPin already answers UNAVAILABLE in that case */
    }
    this.database.connection
      .prepare(
        `INSERT INTO offline_pin_lockout(username, failures, locked_until) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
      )
      .run(
        username,
        locked ? 0 : failures,
        locked ? new Date(now + LOCKOUT_MS).toISOString() : null,
      );
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
