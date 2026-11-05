import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDatabase } from "../../src/main/offline/database";
import { LocalUserStore, PosAuthError } from "../../src/main/local-users/store";

// Each store gets its own throwaway on-disk ledger (WAL needs a real file), cleaned up after the test.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeStore(): LocalUserStore {
  const directory = mkdtempSync(path.join(os.tmpdir(), "commerce-pos-users-test-"));
  const database = new LocalDatabase(path.join(directory, "ledger.sqlite3"));
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return new LocalUserStore(database);
}

describe("local POS user store", () => {
  it("starts empty and requires the first account to be an admin", () => {
    const store = makeStore();
    expect(store.count()).toBe(0);
    expect(() =>
      store.createUser({ username: "dana", name: "Dana", role: "cashier", pin: "1234" }),
    ).toThrow(PosAuthError);
  });

  it("creates an account and signs in with the correct PIN only", () => {
    const store = makeStore();
    const admin = store.createUser({
      username: "Owner",
      name: "Owner",
      role: "admin",
      pin: "4321",
    });
    expect(admin.role).toBe("admin");
    // Username is normalised to lower-case; the stored hash is never exposed on the public user.
    expect(admin.username).toBe("owner");
    expect(store.login("owner", "4321")).toEqual({ ok: true, user: admin });
    expect(store.login("  OWNER ", "4321").ok).toBe(true);
    expect(store.login("owner", "0000")).toEqual({ ok: false });
    expect(store.login("ghost", "4321")).toEqual({ ok: false });
  });

  it("rejects a duplicate username and an out-of-range PIN", () => {
    const store = makeStore();
    store.createUser({ username: "dana", name: "Dana", role: "admin", pin: "1234" });
    expect(() =>
      store.createUser({ username: "dana", name: "Other", role: "cashier", pin: "5678" }),
    ).toThrow(new PosAuthError("USERNAME_TAKEN"));
    expect(() =>
      store.createUser({ username: "sam", name: "Sam", role: "cashier", pin: "12" }),
    ).toThrow(new PosAuthError("INVALID_PIN"));
  });

  it("only lists active accounts in the roster and verifies a specific account's PIN", () => {
    const store = makeStore();
    const admin = store.createUser({ username: "dana", name: "Dana", role: "admin", pin: "1234" });
    const cashier = store.createUser({
      username: "sam",
      name: "Sam",
      role: "cashier",
      pin: "5678",
      permissions: ["orders", "reports"],
    });
    expect(
      store
        .roster()
        .map((entry) => entry.username)
        .sort(),
    ).toEqual(["dana", "sam"]);
    expect(store.verifyUserPin(cashier.id, "5678")).toBe(true);
    expect(store.verifyUserPin(cashier.id, "0000")).toBe(false);

    store.updateUser(cashier.id, { active: false });
    expect(store.roster().map((entry) => entry.username)).toEqual(["dana"]);
    // A deactivated account can no longer sign in even with the right PIN.
    expect(store.login("sam", "5678")).toEqual({ ok: false });
    expect(admin.permissions).toBeNull();
  });

  it("keeps a cashier's granted sections and resets a PIN", () => {
    const store = makeStore();
    store.createUser({ username: "dana", name: "Dana", role: "admin", pin: "1111" });
    const cashier = store.createUser({
      username: "sam",
      name: "Sam",
      role: "cashier",
      pin: "2222",
      permissions: ["orders"],
    });
    expect(store.getById(cashier.id)?.permissions).toEqual(["orders"]);
    store.setPin(cashier.id, "9999");
    expect(store.login("sam", "2222").ok).toBe(false);
    expect(store.login("sam", "9999").ok).toBe(true);
  });

  it("replaces the roster display cache from the server list (display-only, no usable PIN)", () => {
    const store = makeStore();
    store.createUser({ username: "old", name: "Old", role: "admin", pin: "1234" });
    store.replaceRosterCache([
      { username: "Dana", name: "Dana", role: "admin", active: true },
      { username: "sam", name: "Sam", role: "cashier", active: true },
      { username: "gone", name: "Gone", role: "cashier", active: false },
    ]);
    // The prior local account is wiped; the cache is a full replacement of the server's pos_pin accounts.
    expect(store.count()).toBe(3);
    expect(
      store
        .roster()
        .map((entry) => entry.username)
        .sort(),
    ).toEqual(["dana", "sam"]);
    // Cache rows never authenticate — verification is the server (online) or staff_roster (offline).
    expect(store.login("dana", "1234").ok).toBe(false);
    expect(store.login("old", "1234").ok).toBe(false);
  });

  it("refuses to demote or deactivate the last active admin", () => {
    const store = makeStore();
    const admin = store.createUser({ username: "dana", name: "Dana", role: "admin", pin: "1234" });
    expect(() => store.updateUser(admin.id, { role: "cashier" })).toThrow(
      new PosAuthError("LAST_ADMIN"),
    );
    expect(() => store.updateUser(admin.id, { active: false })).toThrow(
      new PosAuthError("LAST_ADMIN"),
    );
    // With a second admin present, the first may be demoted.
    store.createUser({ username: "sam", name: "Sam", role: "admin", pin: "5678" });
    expect(store.updateUser(admin.id, { role: "cashier" }).role).toBe("cashier");
  });
});
