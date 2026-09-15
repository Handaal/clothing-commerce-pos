import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyLocalMigrations, type MigrationOptions } from "./migrations";

export const LOCAL_DATABASE_FILENAME = "commerce-pos-ledger.sqlite3";

export interface LocalDatabaseOptions {
  readonly now?: () => Date;
  readonly migrations?: MigrationOptions;
}

function receiptPrefix(installationId: string): string {
  return createHash("sha256").update(installationId).digest("hex").slice(0, 4).toUpperCase();
}

export class LocalDatabase {
  readonly connection: DatabaseSync;
  readonly path: string;
  private readonly now: () => Date;
  private acceptingRequests = true;

  constructor(databasePath: string, options: LocalDatabaseOptions = {}) {
    this.path = databasePath;
    this.now = options.now ?? (() => new Date());
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.connection = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000,
    });
    try {
      this.configure();
      applyLocalMigrations(this.connection, options.migrations);
      this.assertIntegrity();
      this.ensureInstallationMetadata();
      this.connection
        .prepare(
          "UPDATE app_metadata SET last_startup_at = ?, last_clean_shutdown_at = NULL WHERE singleton_id = 1",
        )
        .run(this.now().toISOString());
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  private configure(): void {
    this.connection.exec("PRAGMA foreign_keys = ON");
    const journal = this.connection.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    if (journal.journal_mode.toLowerCase() !== "wal") {
      throw new Error(`SQLite WAL mode is unavailable (received ${journal.journal_mode}).`);
    }
    this.connection.exec("PRAGMA synchronous = FULL");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA trusted_schema = OFF");
    const settings = {
      foreignKeys: (
        this.connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
      ).foreign_keys,
      synchronous: (this.connection.prepare("PRAGMA synchronous").get() as { synchronous: number })
        .synchronous,
      busyTimeout: (this.connection.prepare("PRAGMA busy_timeout").get() as { timeout: number })
        .timeout,
    };
    if (
      settings.foreignKeys !== 1 ||
      settings.synchronous !== 2 ||
      settings.busyTimeout !== 5_000
    ) {
      throw new Error("Required SQLite durability settings could not be applied.");
    }
  }

  private assertIntegrity(): void {
    const row = this.connection.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (row.integrity_check !== "ok") {
      throw new Error(`Local ledger integrity check failed: ${row.integrity_check}`);
    }
  }

  private ensureInstallationMetadata(): void {
    const existing = this.connection
      .prepare("SELECT installation_id FROM app_metadata WHERE singleton_id = 1")
      .get();
    if (existing) return;
    const installationId = randomUUID();
    this.connection
      .prepare(
        `INSERT INTO app_metadata(
          singleton_id, installation_id, receipt_prefix, next_receipt_number
        ) VALUES (1, ?, ?, 1)`,
      )
      .run(installationId, receiptPrefix(installationId));
  }

  assertAccepting(): void {
    if (!this.acceptingRequests) throw new Error("Local persistence is shutting down.");
  }

  transaction<T>(operation: () => T): T {
    this.assertAccepting();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (!this.acceptingRequests) return;
    this.acceptingRequests = false;
    this.connection
      .prepare("UPDATE app_metadata SET last_clean_shutdown_at = ? WHERE singleton_id = 1")
      .run(this.now().toISOString());
    this.connection.close();
  }
}

export function localDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, LOCAL_DATABASE_FILENAME);
}
