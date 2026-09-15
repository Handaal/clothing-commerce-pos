import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { localDatabasePath } from "../../src/main/offline/database";
import { OfflineRuntime } from "../../src/main/offline/runtime";
import { TestSecureStorage } from "./fixtures";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("offline runtime fail-closed boundary", () => {
  it("preserves a corrupt ledger and blocks offline acceptance without crashing connected mode", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-corrupt-ledger-test-"));
    directories.push(directory);
    const databasePath = localDatabasePath(directory);
    const corruptBytes = Buffer.from("not-a-sqlite-ledger");
    writeFileSync(databasePath, corruptBytes);

    const runtime = await OfflineRuntime.initialize(
      directory,
      new TestSecureStorage(),
      "https://commerce.example.test",
    );
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      reason: "DATABASE_UNHEALTHY",
    });
    expect(() =>
      runtime.acceptCashSale({
        lines: [{ variantId: "variant", quantity: 1 }],
        cashReceivedMinor: 1,
      }),
    ).toThrow();
    expect(readFileSync(databasePath)).toEqual(corruptBytes);
    runtime.close();
  });
});
