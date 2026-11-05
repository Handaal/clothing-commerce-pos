import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseOfflineBootstrapInput, parseOfflineSaleInput } from "../../src/main/offline/ipc";
import { OFFLINE_IPC_CHANNELS } from "../../src/shared/offline";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = path.join(directory, entry);
    return statSync(filePath).isDirectory() ? sourceFiles(filePath) : [filePath];
  });
}

describe("offline IPC and process boundary", () => {
  it("exposes only the fixed allowlisted offline channels", () => {
    expect(Object.values(OFFLINE_IPC_CHANNELS).sort()).toEqual([
      "offline:accept-cash-sale",
      "offline:acknowledge-sale",
      "offline:bootstrap",
      "offline:get-cached-catalog",
      "offline:get-local-receipt",
      "offline:get-offline-customers",
      "offline:get-pending-sync-summary",
      "offline:get-projected-inventory",
      "offline:get-readiness",
      "offline:get-sync-status",
      "offline:get-unacknowledged-sales",
      "offline:record-customer-payment",
      "offline:request-sync",
      "offline:verify-staff-pin",
    ]);
    const preload = readFileSync(path.join(process.cwd(), "src", "preload", "preload.ts"), "utf8");
    expect(preload).not.toMatch(/executeSql|execute\s*\(|filesystem|database.*path|private.*key/i);
  });

  it("validates malformed sale and bootstrap inputs in main", () => {
    expect(() => parseOfflineSaleInput(null)).toThrow(TypeError);
    expect(() =>
      parseOfflineSaleInput({
        lines: [{ variantId: idsLike(), quantity: 0 }],
        cashReceivedMinor: 0,
      }),
    ).toThrow(TypeError);
    expect(() => parseOfflineBootstrapInput({})).toThrow(TypeError);
    expect(() =>
      parseOfflineBootstrapInput({
        tenantId: "tenant",
        registerId: "register",
        displayName: "Register",
        accessToken: "",
      }),
    ).toThrow(TypeError);
  });

  it("keeps SQLite, filesystem, Electron, and key material out of renderer source", () => {
    const source = sourceFiles(path.join(process.cwd(), "src", "renderer"))
      .filter((file) => !file.includes(".test."))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/node:sqlite|DatabaseSync|node:fs|from ["']electron["']/);
    expect(source).not.toMatch(/privateKey|encryptedPrivateKey|signatureBase64/);
  });

  it("acquires the single-instance lock before local runtime initialization", () => {
    const main = readFileSync(path.join(process.cwd(), "src", "main", "main.ts"), "utf8");
    expect(main.indexOf("requestSingleInstanceLock")).toBeLessThan(
      main.indexOf("OfflineRuntime.initialize"),
    );
  });
});

function idsLike(): string {
  return "10000000-0000-4000-8000-000000000012";
}
