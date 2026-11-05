import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PosSessionOperator, PosSessionSnapshot } from "../../shared/pos-session";
import type { OsSecureStorage } from "../offline/device-key";

export const POS_SESSION_FILENAME = "pos-session.protected.json";

/** The full record held in the main process — includes the bearer the renderer never sees unbidden. */
export interface StoredPosSession {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly operator: PosSessionOperator;
}

interface ProtectedSessionFile {
  readonly version: 1;
  readonly encryptedSessionBase64: string;
}

const ROLES = new Set(["admin", "cashier"]);

function isOperator(value: unknown): value is PosSessionOperator {
  if (!value || typeof value !== "object") return false;
  const operator = value as Record<string, unknown>;
  return (
    typeof operator.membershipId === "string" &&
    typeof operator.tenantId === "string" &&
    typeof operator.username === "string" &&
    typeof operator.displayName === "string" &&
    typeof operator.role === "string" &&
    ROLES.has(operator.role) &&
    Array.isArray(operator.permissions) &&
    operator.permissions.every((item) => typeof item === "string")
  );
}

function isStoredSession(value: unknown): value is StoredPosSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.accessToken === "string" &&
    typeof session.expiresAt === "string" &&
    isOperator(session.operator)
  );
}

/**
 * Durable, OS-encrypted store for the POS-native (pos_pin) session. The access token is encrypted with
 * the platform key store (Electron `safeStorage`) and written atomically to the user-data directory so a
 * cashier who restarts the app mid-shift stays signed in until the token expires. When the platform key
 * store is unavailable (e.g. a headless Linux `basic_text` backend) the session is held in memory only —
 * the cashier simply re-enters their PIN after a restart, which is acceptable and keeps the token off a
 * plaintext disk. All reads honour `expiresAt`: an expired session is treated as absent and purged.
 */
export class PosSessionStore {
  private cached: StoredPosSession | null = null;
  private loaded = false;

  constructor(
    private readonly directory: string,
    private readonly secureStorage: OsSecureStorage,
  ) {}

  private get filePath(): string {
    return path.join(this.directory, POS_SESSION_FILENAME);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.secureStorage.isEncryptionAvailable() || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as Partial<ProtectedSessionFile>;
      if (parsed.version !== 1 || typeof parsed.encryptedSessionBase64 !== "string") return;
      const decrypted = this.secureStorage.decryptString(
        Buffer.from(parsed.encryptedSessionBase64, "base64"),
      );
      const session = JSON.parse(decrypted) as unknown;
      if (isStoredSession(session)) this.cached = session;
    } catch {
      // A corrupt or undecryptable file is treated as no session; purge it so it cannot wedge sign-in.
      this.purgeFile();
    }
  }

  private purgeFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // Best-effort cleanup; an undeletable stale file is ignored (expiry still gates every read).
    }
  }

  save(session: StoredPosSession): void {
    this.loaded = true;
    this.cached = session;
    if (!this.secureStorage.isEncryptionAvailable()) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      const encrypted = this.secureStorage.encryptString(JSON.stringify(session));
      const file: ProtectedSessionFile = {
        version: 1,
        encryptedSessionBase64: encrypted.toString("base64"),
      };
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(file), "utf8");
      renameSync(temporaryPath, this.filePath);
    } catch {
      // If persistence fails the in-memory session still serves this run; the next restart re-logs.
    }
  }

  clear(): void {
    this.loaded = true;
    this.cached = null;
    this.purgeFile();
  }

  private current(now: Date): StoredPosSession | null {
    this.ensureLoaded();
    if (!this.cached) return null;
    if (Date.parse(this.cached.expiresAt) <= now.getTime()) {
      this.clear();
      return null;
    }
    return this.cached;
  }

  getToken(now: Date): string | null {
    return this.current(now)?.accessToken ?? null;
  }

  getSnapshot(now: Date): PosSessionSnapshot | null {
    const session = this.current(now);
    if (!session) return null;
    return { operator: session.operator, expiresAt: session.expiresAt };
  }
}
