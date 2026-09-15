import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { applyLocalMigrations, LOCAL_SCHEMA_VERSION } from "../../src/main/offline/migrations";

const directories: string[] = [];
function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-migration-test-"));
  directories.push(directory);
  return path.join(directory, "ledger.sqlite3");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("local database and migrations", () => {
  it("migrates an empty database to the current schema with required durability settings", () => {
    const database = new LocalDatabase(temporaryDatabasePath());
    const connection = database.connection;
    expect(connection.prepare("PRAGMA user_version").get()).toEqual({
      user_version: LOCAL_SCHEMA_VERSION,
    });
    expect(connection.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(connection.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(connection.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "app_metadata",
        "catalog_snapshot",
        "device_state",
        "local_sale",
        "local_sale_line",
        "local_cash_tender",
        "outbox",
      ]),
    );
    database.close();
  });

  it("upgrades a prior-version database transactionally", () => {
    const databasePath = temporaryDatabasePath();
    const old = new DatabaseSync(databasePath);
    applyLocalMigrations(old, { targetVersion: 1 });
    expect(old.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    old.close();

    const upgraded = new LocalDatabase(databasePath);
    expect(upgraded.connection.prepare("PRAGMA user_version").get()).toEqual({
      user_version: LOCAL_SCHEMA_VERSION,
    });
    expect(
      upgraded.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'outbox'").get(),
    ).toBeDefined();
    upgraded.close();
  });

  it("rolls back a failed migration and refuses to initialize", () => {
    const databasePath = temporaryDatabasePath();
    expect(
      () =>
        new LocalDatabase(databasePath, {
          migrations: {
            beforeMigration(version) {
              if (version === 2) throw new Error("injected migration failure");
            },
          },
        }),
    ).toThrow(/migration 2/);
    const inspection = new DatabaseSync(databasePath);
    expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      inspection.prepare("SELECT name FROM sqlite_master WHERE name = 'outbox'").get(),
    ).toBeUndefined();
    inspection.close();
  });
});
