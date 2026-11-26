import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

import type { OsSecureStorage } from "./device-key";

/**
 * Offline PIN v2 — device-local enrollment (server migration 20261115170000).
 *
 * After a SUCCESSFUL online sign-in on this till, the person's SIGN-IN PIN (same PIN, shifted-cafe model) is
 * turned into a device-bound verifier here. The server records only that an enrollment exists (id + version)
 * and stores nothing derived from the PIN. Here, in
 * the trusted main process, the PIN becomes a device-bound scrypt verifier — scrypt(pin, salt || deviceId) —
 * sealed with the OS key store (Electron safeStorage: DPAPI on Windows, Keychain on macOS) in its own file.
 * The plaintext PIN is never persisted, logged, written to SQLite, the outbox or telemetry.
 *
 * Threat model (ACCEPTED by the owner 2026-11-15; docs/pos/offline-pin-v2.md). This design is NOT resistant
 * to malware running as the till's Windows user:
 *   - A 4–8 digit PIN has little entropy. Such malware can unseal this file (DPAPI releases it to any process of
 *     the user) and brute-force 10^4–10^8 candidates; because the offline PIN IS the sign-in PIN, recovering it
 *     also reveals that person's online POS sign-in PIN (online use stays subject to the server lockout).
 *   - The seal stops the verifier being read from a copied disk/ledger on another machine or OS account.
 *   - Guessing at the till is limited by a persistent lockout kept in TWO places: SQLite and inside this
 *     OS-sealed file. The stricter of the two applies, so editing or deleting the SQLite row does not reset
 *     it. Someone who can run code as this OS user can still roll the sealed file back or brute-force the
 *     verifier directly — the lockout is a keyboard-guessing control, not a malware control.
 *   - Authority is short-lived: the verifier is usable only while the latest online bootstrap still lists this
 *     exact enrollment id + version for a currently-authorised seller AND that lease has not expired.
 */

const SCRYPT = { n: 32_768, r: 8, p: 1, keyLength: 32 } as const;
// The offline PIN IS the POS sign-in PIN (ADR-043 §6): ASCII digits only, at least 4, NO product maximum. The
// same rule as the server, so any PIN the server accepts can be enrolled for offline sign-in (never truncated).
export const OFFLINE_PIN_PATTERN = /^[0-9]{4,}$/;

interface SealedEntry {
  readonly enrollmentId: string;
  readonly verifierVersion: number;
  readonly deviceId: string;
  readonly saltBase64: string;
  readonly hashBase64: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly enrolledAt: string;
}
export interface SealedLockout {
  readonly failures: number;
  readonly lockedUntil: string | null;
}
interface SealedState {
  readonly version: 1;
  readonly entries: Readonly<Record<string, SealedEntry>>;
  /** Per-username offline unlock lockout, mirrored from SQLite (tamper-resistant copy). */
  readonly lockouts?: Readonly<Record<string, SealedLockout>>;
}
const EMPTY: SealedState = { version: 1, entries: {} };

const maxmem = (n: number, r: number) => 256 * n * r + 1024 * 1024;

export function offlinePinEnrollmentPath(userDataPath: string): string {
  return join(userDataPath, "offline-pin-enrollments.sealed");
}

export class OfflinePinEnrollmentStore {
  constructor(
    private readonly path: string,
    private readonly secureStorage: OsSecureStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isAvailable(): boolean {
    return this.secureStorage.isEncryptionAvailable();
  }

  /** Seal a new device-bound verifier for a server-issued enrollment. Replaces any older one for the member. */
  enroll(input: {
    readonly membershipId: string;
    readonly enrollmentId: string;
    readonly verifierVersion: number;
    readonly deviceId: string;
    readonly pin: string;
  }): void {
    if (!this.isAvailable()) throw new Error("OS-protected storage is unavailable on this device.");
    if (!OFFLINE_PIN_PATTERN.test(input.pin))
      throw new Error("The offline PIN must be at least 4 digits (0-9 only).");
    const salt = randomBytes(16);
    const hash = scryptSync(
      input.pin,
      Buffer.concat([salt, Buffer.from(input.deviceId, "utf8")]),
      SCRYPT.keyLength,
      { N: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p, maxmem: maxmem(SCRYPT.n, SCRYPT.r) },
    );
    const state = this.read();
    this.write({
      ...state,
      entries: {
        ...state.entries,
        [input.membershipId]: {
          enrollmentId: input.enrollmentId,
          verifierVersion: input.verifierVersion,
          deviceId: input.deviceId,
          saltBase64: salt.toString("base64"),
          hashBase64: hash.toString("base64"),
          ...SCRYPT,
          enrolledAt: this.now().toISOString(),
        },
      },
    });
  }

  /** Drop a member's local verifier (revoked, superseded, forgotten PIN). */
  remove(membershipId: string): void {
    const state = this.read();
    if (!state.entries[membershipId]) return;
    const entries = { ...state.entries };
    delete entries[membershipId];
    this.write({ ...state, entries });
  }

  /** Keep only verifiers the latest bootstrap still authorises (exact id + version). */
  retainOnly(
    authorized: ReadonlyArray<{
      membershipId: string;
      enrollmentId: string;
      verifierVersion: number;
    }>,
  ): void {
    const state = this.read();
    const keep = new Map(authorized.map((a) => [a.membershipId, a]));
    const entries: Record<string, SealedEntry> = {};
    for (const [membershipId, entry] of Object.entries(state.entries)) {
      const a = keep.get(membershipId);
      if (a && a.enrollmentId === entry.enrollmentId && a.verifierVersion === entry.verifierVersion)
        entries[membershipId] = entry;
    }
    if (Object.keys(entries).length !== Object.keys(state.entries).length)
      this.write({ ...state, entries });
  }

  /** Constant-work check of a PIN against the member's sealed verifier for exactly this enrollment. */
  matches(input: {
    readonly membershipId: string;
    readonly enrollmentId: string;
    readonly verifierVersion: number;
    readonly deviceId: string;
    readonly pin: string;
  }): boolean {
    const entry = this.read().entries[input.membershipId];
    const usable =
      entry !== undefined &&
      entry.enrollmentId === input.enrollmentId &&
      entry.verifierVersion === input.verifierVersion &&
      entry.deviceId === input.deviceId;
    const params = usable
      ? entry
      : { ...SCRYPT, saltBase64: Buffer.alloc(16, 7).toString("base64") };
    const derived = scryptSync(
      input.pin,
      Buffer.concat([
        Buffer.from(params.saltBase64, "base64"),
        Buffer.from(input.deviceId, "utf8"),
      ]),
      params.keyLength,
      { N: params.n, r: params.r, p: params.p, maxmem: maxmem(params.n, params.r) },
    );
    if (!usable) return false;
    const expected = Buffer.from(entry.hashBase64, "base64");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  /** The sealed enrollment identity for a member (never the verifier itself). */
  entryFor(
    membershipId: string,
  ): { enrollmentId: string; verifierVersion: number; deviceId: string } | null {
    const entry = this.read().entries[membershipId];
    return entry
      ? {
          enrollmentId: entry.enrollmentId,
          verifierVersion: entry.verifierVersion,
          deviceId: entry.deviceId,
        }
      : null;
  }

  /** The sealed lockout copy for a username (null when none or the store is unreadable). */
  lockout(username: string): SealedLockout | null {
    return this.read().lockouts?.[username] ?? null;
  }

  /** Persist (or clear, with null) the sealed lockout copy. Throws if the OS key store is unavailable. */
  setLockout(username: string, value: SealedLockout | null): void {
    const state = this.read();
    const lockouts = { ...(state.lockouts ?? {}) };
    if (value === null) {
      if (!(username in lockouts)) return;
      delete lockouts[username];
    } else lockouts[username] = value;
    this.write({ ...state, lockouts });
  }

  enrolledMemberships(): ReadonlyArray<string> {
    return Object.keys(this.read().entries);
  }

  private read(): SealedState {
    if (!existsSync(this.path)) return EMPTY;
    try {
      const parsed = JSON.parse(
        this.secureStorage.decryptString(readFileSync(this.path)),
      ) as SealedState;
      return parsed.version === 1 && parsed.entries ? parsed : EMPTY;
    } catch {
      return EMPTY; // unreadable (key store changed / damaged): fail closed
    }
  }

  private write(state: SealedState): void {
    if (!this.isAvailable()) throw new Error("OS-protected storage is unavailable on this device.");
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, this.secureStorage.encryptString(JSON.stringify(state)), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}
