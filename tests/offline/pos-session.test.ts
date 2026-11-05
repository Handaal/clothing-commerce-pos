import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OsSecureStorage } from "../../src/main/offline/device-key";
import {
  POS_SESSION_FILENAME,
  PosSessionStore,
  type StoredPosSession,
} from "../../src/main/pos-session/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-session-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A reversible stand-in for Electron safeStorage: base64 round-trips so persistence can be exercised.
function secureStorage(available = true): OsSecureStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext: string) => Buffer.from(plaintext, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  };
}

const operator = {
  membershipId: "m1",
  tenantId: "t1",
  username: "sam",
  displayName: "Sam",
  role: "cashier" as const,
  permissions: ["orders"],
};

function session(expiresAt: string): StoredPosSession {
  return { accessToken: "tok", expiresAt, operator };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

describe("POS session store", () => {
  it("serves a live token + snapshot and clears on logout", () => {
    const store = new PosSessionStore(tempDir(), secureStorage());
    store.save(session(future()));
    const now = new Date();
    expect(store.getToken(now)).toBe("tok");
    expect(store.getSnapshot(now)?.operator.username).toBe("sam");
    expect(store.getSnapshot(now)?.operator.permissions).toEqual(["orders"]);
    store.clear();
    expect(store.getToken(now)).toBeNull();
    expect(store.getSnapshot(now)).toBeNull();
  });

  it("treats an expired session as absent and purges the file", () => {
    const directory = tempDir();
    const store = new PosSessionStore(directory, secureStorage());
    store.save(session(past()));
    expect(existsSync(path.join(directory, POS_SESSION_FILENAME))).toBe(true);
    const now = new Date();
    expect(store.getToken(now)).toBeNull();
    expect(store.getSnapshot(now)).toBeNull();
    expect(existsSync(path.join(directory, POS_SESSION_FILENAME))).toBe(false);
  });

  it("persists an encrypted session across store instances", () => {
    const directory = tempDir();
    new PosSessionStore(directory, secureStorage()).save(session(future()));
    const reopened = new PosSessionStore(directory, secureStorage());
    expect(reopened.getToken(new Date())).toBe("tok");
    expect(reopened.getSnapshot(new Date())?.operator.membershipId).toBe("m1");
  });

  it("holds the session in memory only when platform encryption is unavailable", () => {
    const directory = tempDir();
    const store = new PosSessionStore(directory, secureStorage(false));
    store.save(session(future()));
    // The live instance still serves it, but nothing is written to disk and a restart loses it.
    expect(store.getToken(new Date())).toBe("tok");
    expect(existsSync(path.join(directory, POS_SESSION_FILENAME))).toBe(false);
    expect(new PosSessionStore(directory, secureStorage(false)).getToken(new Date())).toBeNull();
  });
});
