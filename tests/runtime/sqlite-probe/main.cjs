/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const databasePath = path.join(app.getPath("userData"), "sqlite-runtime-probe.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  database.exec("CREATE TABLE IF NOT EXISTS probe (value TEXT NOT NULL)");
  database.exec("DELETE FROM probe");
  database.prepare("INSERT INTO probe (value) VALUES (?)").run("electron-node-sqlite-ok");
  const row = database.prepare("SELECT value FROM probe").get();
  const result = {
    packaged: app.isPackaged,
    databasePath,
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    journalMode: database.prepare("PRAGMA journal_mode").get().journal_mode,
    synchronous: database.prepare("PRAGMA synchronous").get().synchronous,
    foreignKeys: database.prepare("PRAGMA foreign_keys").get().foreign_keys,
    value: row.value,
  };
  database.close();
  fs.writeFileSync(
    path.join(app.getPath("userData"), "sqlite-runtime-probe.json"),
    JSON.stringify(result),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
