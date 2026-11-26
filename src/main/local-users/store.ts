import { randomUUID } from "node:crypto";

import type { PosRosterCacheEntry, PosRosterEntry } from "../../shared/pos-auth";
import type { LocalDatabase } from "../offline/database";

// ADR-043: the device-local `pos_users` table is a DISPLAY-ONLY roster cache for the pre-auth floor picker. The
// API is the only POS credential authority (online), and the device-bound offline verifier is the only offline
// one. This store therefore has no login, PIN, hash or verify capability at all; local schema v24 erased every
// legacy device-local hash and refuses new ones. Entries are mirrored from the server by the admin Team desk.

/** Thrown when a roster entry is malformed; `code` is a `PosAuthErrorCode`. */
export class PosAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PosAuthError";
  }
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw new PosAuthError("INVALID_USERNAME");
  const username = value.trim().toLowerCase();
  // Server usernames: letters, digits, dot, underscore, hyphen.
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new PosAuthError("INVALID_USERNAME");
  return username;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new PosAuthError("INVALID_NAME");
  const name = value.trim();
  if (name.length < 1 || name.length > 120) throw new PosAuthError("INVALID_NAME");
  return name;
}

function normalizeRole(value: unknown): "admin" | "cashier" {
  if (value !== "admin" && value !== "cashier") throw new PosAuthError("INVALID_ROLE");
  return value;
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

  /** Active cached accounts only — an inactive account is never offered as a sign-in choice. */
  roster(): readonly PosRosterEntry[] {
    return (
      this.database.connection
        .prepare(
          `SELECT id, username, name, role FROM pos_users
           WHERE active = 1 ORDER BY role, name`,
        )
        .all() as unknown as Array<{
        id: string;
        username: string;
        name: string;
        role: "admin" | "cashier";
      }>
    ).map((row) => ({ id: row.id, username: row.username, name: row.name, role: row.role }));
  }

  /** Replace the display-only roster cache with the server's pos_pin accounts (no secret crosses here). */
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
}
