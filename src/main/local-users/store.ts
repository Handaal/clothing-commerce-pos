import { randomUUID } from "node:crypto";

import type {
  PosLoginResult,
  PosRosterCacheEntry,
  PosRosterEntry,
  PosUser,
  PosUserInput,
  PosUserUpdate,
} from "../../shared/pos-auth";
import { POS_PIN_MAX_LENGTH, POS_PIN_MIN_LENGTH } from "../../shared/pos-auth";
import type { LocalDatabase } from "../offline/database";
import { hashPin, verifyPin } from "./pin-crypto";

// Device-local POS user store mirroring the shifted-cafe `auth.service`: a roster-picked username +
// numeric PIN, verified in the main process, with locally-managed admin/cashier accounts. All access
// is through this store; the renderer never sees a PIN hash.

/** Thrown by management mutations; `code` is a `PosAuthErrorCode`. */
export class PosAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PosAuthError";
  }
}

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: "admin" | "cashier";
  pin_hash: string;
  permissions_json: string | null;
  active: number;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw new PosAuthError("INVALID_USERNAME");
  const username = value.trim().toLowerCase();
  // Keep usernames terminal-friendly: letters, digits, dot, underscore, hyphen.
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new PosAuthError("INVALID_USERNAME");
  return username;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new PosAuthError("INVALID_NAME");
  const name = value.trim();
  if (name.length < 1 || name.length > 60) throw new PosAuthError("INVALID_NAME");
  return name;
}

function normalizeRole(value: unknown): "admin" | "cashier" {
  if (value !== "admin" && value !== "cashier") throw new PosAuthError("INVALID_ROLE");
  return value;
}

function assertPin(value: unknown): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9]{${POS_PIN_MIN_LENGTH},${POS_PIN_MAX_LENGTH}}$`).test(value)
  ) {
    throw new PosAuthError("INVALID_PIN");
  }
  return value;
}

// Permissions are an optional subset of section ids; null means "role default". Stored as JSON.
function normalizePermissions(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new PosAuthError("INVALID_ROLE");
  const sections = value.filter((item): item is string => typeof item === "string");
  return Array.from(new Set(sections));
}

function toPublicUser(row: UserRow): PosUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    permissions: row.permissions_json ? (JSON.parse(row.permissions_json) as string[]) : null,
    active: row.active === 1,
  };
}

export class LocalUserStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  count(): number {
    const row = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM pos_users")
      .get() as { count: number };
    return Number(row.count);
  }

  roster(): readonly PosRosterEntry[] {
    return (
      this.database.connection
        .prepare(
          `SELECT id, username, name, role FROM pos_users
           WHERE active = 1 ORDER BY role, name`,
        )
        .all() as unknown as Array<Pick<UserRow, "id" | "username" | "name" | "role">>
    ).map((row) => ({ id: row.id, username: row.username, name: row.name, role: row.role }));
  }

  login(username: string, pin: string): PosLoginResult {
    const normalized = typeof username === "string" ? username.trim().toLowerCase() : "";
    if (normalized === "" || typeof pin !== "string" || pin === "") return { ok: false };
    const row = this.database.connection
      .prepare("SELECT * FROM pos_users WHERE username = ? AND active = 1")
      .get(normalized) as UserRow | undefined;
    if (!row || !verifyPin(pin, row.pin_hash)) return { ok: false };
    return { ok: true, user: toPublicUser(row) };
  }

  listUsers(): readonly PosUser[] {
    return (
      this.database.connection
        .prepare("SELECT * FROM pos_users ORDER BY role, name")
        .all() as unknown as UserRow[]
    ).map(toPublicUser);
  }

  getById(id: string): PosUser | null {
    const row = this.database.connection.prepare("SELECT * FROM pos_users WHERE id = ?").get(id) as
      UserRow | undefined;
    return row ? toPublicUser(row) : null;
  }

  createUser(input: PosUserInput): PosUser {
    const username = normalizeUsername(input.username);
    const name = normalizeName(input.name);
    const role = normalizeRole(input.role);
    const pin = assertPin(input.pin);
    const permissions = normalizePermissions(input.permissions);
    // Bootstrap rule: the first account on a fresh terminal must be an admin, so the terminal is never
    // left with only cashiers and no one who can manage users.
    if (this.count() === 0 && role !== "admin") throw new PosAuthError("FIRST_USER_MUST_BE_ADMIN");

    return this.database.transaction(() => {
      const existing = this.database.connection
        .prepare("SELECT 1 FROM pos_users WHERE username = ?")
        .get(username);
      if (existing) throw new PosAuthError("USERNAME_TAKEN");
      const id = randomUUID();
      const timestamp = this.now().toISOString();
      this.database.connection
        .prepare(
          `INSERT INTO pos_users(id, username, name, role, pin_hash, permissions_json, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          username,
          name,
          role,
          hashPin(pin),
          permissions ? JSON.stringify(permissions) : null,
          timestamp,
          timestamp,
        );
      const created = this.getById(id);
      if (!created) throw new PosAuthError("USER_NOT_FOUND");
      return created;
    });
  }

  updateUser(id: string, update: PosUserUpdate): PosUser {
    return this.database.transaction(() => {
      const current = this.getById(id);
      if (!current) throw new PosAuthError("USER_NOT_FOUND");

      const nextRole = update.role === undefined ? current.role : normalizeRole(update.role);
      const nextActive = update.active === undefined ? current.active : update.active === true;
      // Never leave the terminal without an active admin: block demoting/deactivating the last one.
      const losesAdmin =
        current.role === "admin" && current.active && (nextRole !== "admin" || !nextActive);
      if (losesAdmin && this.activeAdminCount() <= 1) throw new PosAuthError("LAST_ADMIN");

      const nextName = update.name === undefined ? current.name : normalizeName(update.name);
      const nextPermissions =
        update.permissions === undefined
          ? current.permissions
          : normalizePermissions(update.permissions);

      this.database.connection
        .prepare(
          `UPDATE pos_users SET name = ?, role = ?, permissions_json = ?, active = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextName,
          nextRole,
          nextPermissions ? JSON.stringify(nextPermissions) : null,
          nextActive ? 1 : 0,
          this.now().toISOString(),
          id,
        );
      const updated = this.getById(id);
      if (!updated) throw new PosAuthError("USER_NOT_FOUND");
      return updated;
    });
  }

  setPin(id: string, pin: string): void {
    const verified = assertPin(pin);
    const result = this.database.connection
      .prepare("UPDATE pos_users SET pin_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPin(verified), this.now().toISOString(), id);
    if (Number(result.changes) === 0) throw new PosAuthError("USER_NOT_FOUND");
  }

  verifyUserPin(id: string, pin: string): boolean {
    if (typeof pin !== "string" || pin === "") return false;
    const row = this.database.connection
      .prepare("SELECT pin_hash FROM pos_users WHERE id = ? AND active = 1")
      .get(id) as { pin_hash: string } | undefined;
    return row ? verifyPin(pin, row.pin_hash) : false;
  }

  // Replace the display-only roster cache with the server's pos_pin accounts. pos_pin accounts are
  // verified by the server (online) or the device-bound staff_roster (offline), so these rows are never
  // authenticated against — `pin_hash` is left empty. This keeps the pre-auth floor picker populated and
  // offline-capable without a PIN crossing the boundary.
  replaceRosterCache(entries: readonly PosRosterCacheEntry[]): void {
    this.database.transaction(() => {
      this.database.connection.prepare("DELETE FROM pos_users").run();
      const insert = this.database.connection.prepare(
        `INSERT INTO pos_users(id, username, name, role, pin_hash, permissions_json, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', NULL, ?, ?, ?)`,
      );
      const seen = new Set<string>();
      for (const entry of entries) {
        const username = normalizeUsername(entry.username);
        if (seen.has(username)) continue;
        seen.add(username);
        const timestamp = this.now().toISOString();
        insert.run(
          randomUUID(),
          username,
          normalizeName(entry.name),
          normalizeRole(entry.role),
          entry.active ? 1 : 0,
          timestamp,
          timestamp,
        );
      }
    });
  }

  private activeAdminCount(): number {
    const row = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM pos_users WHERE role = 'admin' AND active = 1")
      .get() as { count: number };
    return Number(row.count);
  }
}
