import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { LocalUserStore } from "../../src/main/local-users/store";
import { parseRosterCache } from "../../src/main/local-users/ipc";
import { LocalDatabase } from "../../src/main/offline/database";
import { applyLocalMigrations } from "../../src/main/offline/migrations";

// ADR-043: `pos_users` is a DISPLAY-ONLY roster cache. It must never authenticate, never hold a PIN hash, and an
// upgrade must erase any hash a retired cafe-style local account left behind.
const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-roster-test-"));
  directories.push(directory);
  return path.join(directory, "ledger.sqlite3");
}

function open(file = databasePath()): { store: LocalUserStore; database: LocalDatabase } {
  const database = new LocalDatabase(file);
  closers.push(() => database.close());
  return { store: new LocalUserStore(database), database };
}

describe("display-only POS roster cache", () => {
  it("exposes no credential capability at all", () => {
    const { store } = open();
    for (const method of [
      "login",
      "createUser",
      "updateUser",
      "setPin",
      "verifyUserPin",
      "verifyPin",
    ]) {
      expect((store as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it("mirrors the server roster without any secret and offers only active accounts", () => {
    const { store, database } = open();
    expect(store.count()).toBe(0);
    store.replaceRosterCache([
      { username: "Mariam", name: "Mariam", role: "admin", active: true },
      { username: "omar", name: "Omar", role: "cashier", active: true },
      { username: "gone", name: "Gone", role: "cashier", active: false },
    ]);
    expect(store.count()).toBe(3);
    expect(store.roster().map((entry) => entry.username)).toEqual(["mariam", "omar"]);
    const rows = database.connection.prepare("SELECT pin_hash FROM pos_users").all() as Array<{
      pin_hash: string;
    }>;
    expect(rows.every((row) => row.pin_hash === "")).toBe(true);
    // Replacing again drops anyone the server no longer lists.
    store.replaceRosterCache([{ username: "omar", name: "Omar", role: "cashier", active: true }]);
    expect(store.roster().map((entry) => entry.username)).toEqual(["omar"]);
  });

  it("refuses to store a PIN hash even through a direct write (v24 triggers)", () => {
    const { database } = open();
    const now = new Date().toISOString();
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO pos_users(id, username, name, role, pin_hash, permissions_json, active, created_at, updated_at)
           VALUES ('x', 'evil', 'Evil', 'admin', 'aa:bb', NULL, 1, ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/display-only/);
    database.connection
      .prepare(
        `INSERT INTO pos_users(id, username, name, role, pin_hash, permissions_json, active, created_at, updated_at)
         VALUES ('y', 'ok', 'Ok', 'cashier', '', NULL, 1, ?, ?)`,
      )
      .run(now, now);
    expect(() =>
      database.connection.prepare("UPDATE pos_users SET pin_hash = 'aa:bb' WHERE id = 'y'").run(),
    ).toThrow(/display-only/);
  });

  it("upgrade from v23 erases legacy device-local PIN hashes (no second credential store survives)", () => {
    const file = databasePath();
    const legacy = new DatabaseSync(file);
    applyLocalMigrations(legacy, { targetVersion: 23 });
    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO pos_users(id, username, name, role, pin_hash, permissions_json, active, created_at, updated_at)
         VALUES ('legacy', 'oldadmin', 'Old Admin', 'admin', 'deadbeef:cafebabe', NULL, 1, ?, ?)`,
      )
      .run(now, now);
    legacy.close();

    const { store, database } = open(file);
    const row = database.connection
      .prepare("SELECT pin_hash FROM pos_users WHERE id = 'legacy'")
      .get() as { pin_hash: string };
    expect(row.pin_hash).toBe("");
    // The account still appears on the picker (display only) — signing in goes to the server.
    expect(store.roster().map((entry) => entry.username)).toEqual(["oldadmin"]);
  });

  it("IPC parsing keeps only display fields (a stray pin on the payload is dropped)", () => {
    const parsed = parseRosterCache([
      { username: "omar", name: "Omar", role: "cashier", active: true, pin: "1234", pinHash: "x" },
    ]);
    expect(parsed).toEqual([{ username: "omar", name: "Omar", role: "cashier", active: true }]);
    expect(JSON.stringify(parsed)).not.toContain("1234");
  });
});
