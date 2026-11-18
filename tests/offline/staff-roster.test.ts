// Offline PIN v2 on a REAL SQLite file + a sealed enrollment file (server migration 20261115170000, local v23).
// The server never mints or receives a PIN verifier: the till enrols locally after a fresh online sign-in, and
// each online bootstrap says which enrollment (id + version) may unlock this device offline.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OfflineBootstrapResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { LocalDatabase } from "../../src/main/offline/database";
import { OfflinePinEnroller } from "../../src/main/offline/offline-pin-enroller";
import {
  OfflinePinEnrollmentStore,
  offlinePinEnrollmentPath,
} from "../../src/main/offline/offline-pin-enrollment";
import { StaffRosterStore, deriveStaffPinVerifier } from "../../src/main/offline/staff-roster";
import {
  bootstrapFixture,
  ids,
  makeHarness,
  TestSecureStorage,
  type OfflineHarness,
} from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

let clock = Date.parse("2026-09-08T12:00:00.000Z");
const NOW = () => new Date(clock);
const ENROLLMENT = "90000000-0000-4000-8000-000000000001";
const PIN = "246813";

function bootstrapWith(
  authorizations: unknown[] | undefined,
  legacyRoster = false,
): OfflineBootstrapResponse {
  return {
    ...bootstrapFixture(),
    ...(authorizations ? { offlinePinAuthorizations: authorizations } : {}),
    ...(legacyRoster
      ? {
          staffRoster: [
            {
              membershipId: ids.membership,
              username: "dana",
              displayName: "Dana Cashier",
              pinVerifier: {
                algorithm: "scrypt",
                ...deriveStaffPinVerifier({ pin: "2468", deviceId: ids.device }),
              },
            },
          ],
        }
      : {}),
  } as unknown as OfflineBootstrapResponse;
}
const authorization = (version = 1, enrollmentId = ENROLLMENT) => ({
  membershipId: ids.membership,
  username: "Dana",
  displayName: "Dana Cashier",
  enrollmentId,
  verifierVersion: version,
});

function setup(authorizations: unknown[] | undefined = [authorization()], legacyRoster = false) {
  clock = Date.parse("2026-09-08T12:00:00.000Z");
  const harness = makeHarness({ bootstrap: bootstrapWith(authorizations, legacyRoster), now: NOW });
  harnesses.push(harness);
  const storage = new TestSecureStorage();
  const enrollments = new OfflinePinEnrollmentStore(
    offlinePinEnrollmentPath(harness.directory),
    storage,
    NOW,
  );
  const roster = new StaffRosterStore(harness.database, NOW, enrollments);
  return { harness, storage, enrollments, roster };
}
const enrol = (
  enrollments: OfflinePinEnrollmentStore,
  version = 1,
  deviceId: string = ids.device,
) =>
  enrollments.enroll({
    membershipId: ids.membership,
    enrollmentId: ENROLLMENT,
    verifierVersion: version,
    deviceId,
    pin: PIN,
  });

describe("offline PIN v2 — device-local enrollment and offline unlock", () => {
  it("verifies an enrolled PIN for an authorised enrollment and reports offline login available", () => {
    const { harness, enrollments, roster } = setup();
    enrol(enrollments);
    expect(harness.sales.getReadiness()).toMatchObject({
      ready: true,
      offlineLoginAvailable: true,
    });
    expect(roster.countActive()).toBe(1);
    expect(roster.verifyPin({ username: " DANA ", pin: PIN })).toEqual({
      ok: true,
      operator: { membershipId: ids.membership, username: "dana", displayName: "Dana Cashier" },
    });
  });

  it("never persists the PIN in plaintext: not in SQLite, not in the sealed file", () => {
    const { harness, enrollments } = setup();
    enrol(enrollments);
    const sealed = readFileSync(offlinePinEnrollmentPath(harness.directory));
    expect(sealed.toString("utf8")).not.toContain(PIN);
    const ledger = readFileSync(path.join(harness.directory, "ledger.sqlite3"));
    expect(ledger.includes(Buffer.from(PIN))).toBe(false);
  });

  it("collapses wrong PIN, unknown user and not-enrolled-here to the same INVALID", () => {
    const { enrollments, roster } = setup();
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    enrol(enrollments);
    expect(roster.verifyPin({ username: "dana", pin: "999999" })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(roster.verifyPin({ username: "nobody", pin: PIN })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("a verifier sealed for another device does not verify here (device binding)", () => {
    const { enrollments, roster } = setup();
    enrol(enrollments, 1, "00000000-0000-4000-8000-0000000000ff");
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("an old verifier version is rejected once the server authorises a newer one (superseded / re-enrolled)", () => {
    const { enrollments, roster } = setup([authorization(2)]);
    enrol(enrollments, 1);
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("revocation or permission removal: no authorization ⇒ no unlock, and the local verifier is pruned", () => {
    const { enrollments, roster } = setup([]);
    enrol(enrollments);
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    roster.pruneToAuthorized();
    expect(enrollments.enrolledMemberships()).toEqual([]);
  });

  it("lockout persists across a restart (5 failures ⇒ locked; correct PIN refused while locked)", () => {
    const { harness, storage, enrollments, roster } = setup();
    enrol(enrollments);
    for (let n = 0; n < 5; n += 1) roster.verifyPin({ username: "dana", pin: "000000" });
    harness.database.close();
    const reopened = new LocalDatabase(path.join(harness.directory, "ledger.sqlite3"), {
      now: NOW,
    });
    try {
      const restarted = new StaffRosterStore(
        reopened,
        NOW,
        new OfflinePinEnrollmentStore(offlinePinEnrollmentPath(harness.directory), storage, NOW),
      );
      expect(restarted.verifyPin({ username: "dana", pin: PIN })).toEqual({
        ok: false,
        reason: "THROTTLED",
      });
      clock += 16 * 60_000;
      expect(restarted.verifyPin({ username: "dana", pin: PIN })).toMatchObject({ ok: true });
    } finally {
      reopened.close();
    }
  });

  it("deleting or editing the SQLite lockout row does not reset the lock (sealed copy wins)", () => {
    const { harness, enrollments, roster } = setup();
    enrol(enrollments);
    for (let n = 0; n < 5; n += 1) roster.verifyPin({ username: "dana", pin: "000000" });
    harness.database.connection.exec("DELETE FROM offline_pin_lockout");
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
    // Partial failures are also kept in the sealed copy: 4 wrong, SQLite counter zeroed, 1 more ⇒ locked.
    clock += 16 * 60_000;
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toMatchObject({ ok: true });
    for (let n = 0; n < 4; n += 1) roster.verifyPin({ username: "dana", pin: "000000" });
    harness.database.connection.exec("UPDATE offline_pin_lockout SET failures = 0");
    roster.verifyPin({ username: "dana", pin: "000000" });
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
    // The sealed file holds no PIN or verifier-derived lockout material in plaintext.
    expect(enrollments.lockout("dana")).toMatchObject({ failures: 0 });
  });

  it("offline unlock never outlives the lease", () => {
    const { enrollments, roster } = setup();
    enrol(enrollments);
    clock = Date.parse("2026-09-08T20:00:01.000Z"); // fixture accepted_until 20:00
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("fails closed without OS-protected storage", () => {
    const { harness } = setup();
    const unavailable = new OfflinePinEnrollmentStore(
      offlinePinEnrollmentPath(harness.directory),
      { ...new TestSecureStorage(), isEncryptionAvailable: () => false } as never,
      NOW,
    );
    expect(() => enrol(unavailable)).toThrow(/unavailable/);
    expect(
      new StaffRosterStore(harness.database, NOW, unavailable).verifyPin({
        username: "dana",
        pin: PIN,
      }),
    ).toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("ignores a retired server-minted roster from an older server (KEK-derived verifiers are never installed)", () => {
    const { harness, roster } = setup([], true);
    expect(
      Number(
        (
          harness.database.connection.prepare("SELECT COUNT(*) AS n FROM staff_roster").get() as {
            n: number;
          }
        ).n,
      ),
    ).toBe(0);
    expect(() =>
      harness.database.connection.exec(
        `INSERT INTO staff_roster VALUES ('x','m','u','d','scrypt','s','h',16384,8,1,32)`,
      ),
    ).toThrow(/retired/);
    expect(harness.sales.getReadiness()).toMatchObject({ offlineLoginAvailable: false });
    expect(roster.verifyPin({ username: "dana", pin: "2468" })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  const signIn = (pin = PIN) => ({
    tenantId: ids.tenant,
    accessToken: "token",
    username: "dana",
    pin,
    membershipId: ids.membership,
  });
  const serverOk =
    (calls: Array<Record<string, unknown>>, version = 1) =>
    async (input: never) => {
      calls.push(input);
      return {
        membershipId: ids.membership,
        enrollmentId: ENROLLMENT,
        verifierVersion: version,
        enrolledAt: "2026-09-08T12:00:00.000Z",
      };
    };

  it("same-PIN model: the server records the enrollment FIRST (step-up = the sign-in credential), then the SAME PIN is sealed and unlocks", async () => {
    const { harness, enrollments, roster } = setup();
    const calls: Array<Record<string, unknown>> = [];
    const enroller = new OfflinePinEnroller(
      harness.database,
      enrollments,
      "http://127.0.0.1:1",
      async (input) => {
        expect(enrollments.enrolledMemberships()).toEqual([]); // nothing sealed before the server answers
        return serverOk(calls)(input as never);
      },
    );
    await expect(enroller.refreshAfterSignIn(signIn())).resolves.toEqual({
      status: "enrolled",
      verifierVersion: 1,
    });
    expect(calls[0]).toMatchObject({
      deviceId: ids.device,
      registerId: ids.register,
      tenantId: ids.tenant,
      stepUp: { username: "dana", pin: PIN },
    });
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toMatchObject({ ok: true });
    expect(existsSync(offlinePinEnrollmentPath(harness.directory))).toBe(true);
  });

  it("a later sign-in with the same PIN does not re-enrol; a changed sign-in PIN re-enrols and the old PIN stops working", async () => {
    const { harness, enrollments, roster } = setup([authorization(2)]);
    const calls: Array<Record<string, unknown>> = [];
    let version = 2;
    const enroller = new OfflinePinEnroller(
      harness.database,
      enrollments,
      "http://127.0.0.1:1",
      async (input) => serverOk(calls, version)(input as never),
    );
    await enroller.refreshAfterSignIn(signIn());
    await expect(enroller.refreshAfterSignIn(signIn())).resolves.toEqual({ status: "current" });
    expect(calls).toHaveLength(1);
    version = 3;
    await expect(enroller.refreshAfterSignIn(signIn("97531"))).resolves.toEqual({
      status: "enrolled",
      verifierVersion: 3,
    });
    expect(calls).toHaveLength(2);
    // Authorization for v3 arrives with the next bootstrap; until then neither PIN unlocks (v2 is replaced).
    expect(roster.verifyPin({ username: "dana", pin: PIN })).toMatchObject({ ok: false });
  });

  it("ADR-043: accepts any POS PIN of 4+ ASCII digits (no maximum) and skips anything else without calling the server", async () => {
    const { harness, enrollments } = setup();
    const calls: Array<Record<string, unknown>> = [];
    const enroller = new OfflinePinEnroller(
      harness.database,
      enrollments,
      "http://127.0.0.1:1",
      async (input) => serverOk(calls)(input as never),
    );
    for (const pin of ["123", "12a4", "١٢٣٤", " 1234", ""])
      await expect(enroller.refreshAfterSignIn(signIn(pin))).resolves.toEqual({
        status: "skipped",
        reason: "PIN_FORMAT",
      });
    expect(calls).toHaveLength(0);
    await expect(enroller.refreshAfterSignIn(signIn("4821"))).resolves.toMatchObject({
      status: "enrolled",
    });
  });

  it("ADR-043: a PIN longer than the retired 8/12-digit caps enrols and unlocks offline with the exact digits (no truncation)", async () => {
    const LONG = "4821".repeat(10) + "73"; // 42 digits
    const { harness, enrollments, roster } = setup();
    const calls: Array<Record<string, unknown>> = [];
    const enroller = new OfflinePinEnroller(
      harness.database,
      enrollments,
      "http://127.0.0.1:1",
      async (input) => serverOk(calls)(input as never),
    );
    await expect(enroller.refreshAfterSignIn(signIn(LONG))).resolves.toMatchObject({
      status: "enrolled",
    });
    expect(calls[0]).toMatchObject({ stepUp: { username: "dana", pin: LONG } });
    expect(roster.verifyPin({ username: "dana", pin: LONG })).toMatchObject({ ok: true });
    for (const truncated of [LONG.slice(0, 8), LONG.slice(0, 12), LONG.slice(0, -1)])
      expect(roster.verifyPin({ username: "dana", pin: truncated })).toEqual({
        ok: false,
        reason: "INVALID",
      });
  });

  it("a server refusal or lost connection never throws into sign-in and leaves nothing sealed", async () => {
    const { harness, enrollments } = setup();
    for (const [thrown, expected] of [
      [
        Object.assign(new Error("x"), { code: "OFFLINE_PIN_STEP_UP_FAILED" }),
        "OFFLINE_PIN_STEP_UP_FAILED",
      ],
      [Object.assign(new Error("x"), { code: "OFFLINE_PIN_DISABLED" }), "OFFLINE_PIN_DISABLED"],
      [
        Object.assign(new Error("x"), { code: "OFFLINE_PIN_ENROLLMENT_DENIED" }),
        "OFFLINE_PIN_ENROLLMENT_DENIED",
      ],
      [Object.assign(new Error("x"), { code: "ACCOUNT_LOCKED" }), "OFFLINE_PIN_ACCOUNT_LOCKED"],
      [new Error("fetch failed"), "OFFLINE_PIN_NETWORK"],
    ] as const) {
      const enroller = new OfflinePinEnroller(
        harness.database,
        enrollments,
        "http://127.0.0.1:1",
        async () => {
          throw thrown;
        },
      );
      await expect(enroller.refreshAfterSignIn(signIn())).resolves.toEqual({
        status: "failed",
        code: expected,
      });
    }
    expect(enrollments.enrolledMemberships()).toEqual([]);
  });

  it("skips without OS-protected storage (never seals in the clear)", async () => {
    const { harness } = setup();
    const unavailable = new OfflinePinEnrollmentStore(
      offlinePinEnrollmentPath(harness.directory),
      { ...new TestSecureStorage(), isEncryptionAvailable: () => false } as never,
      NOW,
    );
    const enroller = new OfflinePinEnroller(
      harness.database,
      unavailable,
      "http://127.0.0.1:1",
      async () => {
        throw new Error("must not be called");
      },
    );
    await expect(enroller.refreshAfterSignIn(signIn())).resolves.toEqual({
      status: "skipped",
      reason: "STORAGE_UNAVAILABLE",
    });
  });
});
