// ADR-042 §6.3 security review (2026-11-14) — the till side of override-password verifier v2.
// The server keeps only a one-way scrypt verifier; the till receives a device-, admin- and version-bound HMAC
// tag. These tests pin the properties the review relies on, using the real sealed-file store.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OverrideRosterStore,
  deriveOverrideDeviceVerifierForTest,
  type OverrideRosterEntry,
} from "../../src/main/offline/override-roster";
import { TestSecureStorage } from "./fixtures";

const DEVICE = "70000000-0000-4000-8000-000000000001";
const OTHER_DEVICE = "70000000-0000-4000-8000-000000000002";
const GRANT = "71000000-0000-4000-8000-000000000001";
const ADMIN = "72000000-0000-4000-8000-000000000001";
const PASSWORD = "Blue-Harbour-71";
const NOW = () => new Date("2026-11-14T10:00:00.000Z");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function store(now = NOW) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "override-v2-"));
  directories.push(directory);
  const file = path.join(directory, "override-roster.sealed");
  return { file, roster: new OverrideRosterStore(file, new TestSecureStorage(), now) };
}

function entry(
  overrides: Partial<OverrideRosterEntry> = {},
  tagDevice = DEVICE,
): OverrideRosterEntry {
  return {
    membershipId: ADMIN,
    username: "Boss",
    displayName: "The Boss",
    permissions: ["promotions.manage", "payments.refund"],
    verifierVersion: 4,
    verifier: deriveOverrideDeviceVerifierForTest({
      password: PASSWORD,
      deviceId: tagDevice,
      membershipId: overrides.membershipId ?? ADMIN,
      verifierVersion: overrides.verifierVersion ?? 4,
      n: 1024,
    }),
    expiresAt: "2026-11-14T22:00:00.000Z",
    ...overrides,
  };
}

const check = (roster: OverrideRosterStore, password = PASSWORD) =>
  roster.check({ username: "boss", password, permission: "promotions.manage", commandId: "cmd-1" });

describe("override roster verifier v2 (till)", () => {
  it("accepts the right password and binds a one-use assertion to the command, admin, version and grant", () => {
    const { roster } = store();
    roster.install(GRANT, DEVICE, [entry()]);
    const first = check(roster);
    const second = check(roster);
    expect(first).toMatchObject({
      ok: true,
      assertion: {
        adminMembershipId: ADMIN,
        permission: "promotions.manage",
        verifierVersion: 4,
        commandId: "cmd-1",
        offlineGrantId: GRANT,
      },
    });
    // Each check mints a fresh assertion id: the server accepts each id once.
    expect(
      first.ok && second.ok && first.assertion.assertionId !== second.assertion.assertionId,
    ).toBe(true);
    expect(check(roster, "Blue-Harbour-72")).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("a tag minted for another device does not verify here (device-bound)", () => {
    const { roster } = store();
    roster.install(GRANT, DEVICE, [entry({}, OTHER_DEVICE)]);
    expect(check(roster)).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("a tag for another verifier version does not verify (password change / clear takes effect at bootstrap)", () => {
    const { roster } = store();
    const stale = entry();
    roster.install(GRANT, DEVICE, [{ ...stale, verifierVersion: 5 }]);
    expect(check(roster)).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("ignores any non-v2 verifier at install (the retired device-bound scrypt hash fails closed)", () => {
    const { roster } = store();
    const legacy = {
      ...entry(),
      verifier: {
        saltBase64: "c2FsdA==",
        hashBase64: "aGFzaA==",
        n: 1024,
        r: 8,
        p: 1,
        keyLength: 32,
      },
    } as unknown as OverrideRosterEntry;
    roster.install(GRANT, DEVICE, [legacy]);
    expect(roster.listApprovers("promotions.manage")).toEqual([]);
    expect(check(roster)).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("expires with the lease: no approver is offered and the right password is NOT_AUTHORIZED", () => {
    const { file } = store();
    const late = new OverrideRosterStore(
      file,
      new TestSecureStorage(),
      () => new Date("2026-11-15T00:00:00Z"),
    );
    late.install(GRANT, DEVICE, [entry()]);
    expect(late.listApprovers("promotions.manage")).toEqual([]);
    expect(check(late)).toMatchObject({ ok: false, reason: "NOT_AUTHORIZED" });
  });

  it("the sealed file holds neither the password nor the tag in the clear", () => {
    const { file, roster } = store();
    const installed = entry();
    roster.install(GRANT, DEVICE, [installed]);
    const raw = readFileSync(file).toString("utf8");
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(installed.verifier.deviceTagBase64);
    check(roster, "wrong-password-1");
    expect(readFileSync(file).toString("utf8")).not.toContain("wrong-password-1");
  });

  it("a lockout persisted by the retired v1 file format survives the upgrade; the v1 roster is dropped", () => {
    const { file } = store();
    const v1 = JSON.stringify({
      version: 1,
      offlineGrantId: GRANT,
      deviceId: DEVICE,
      entries: [entry()],
      lockouts: { boss: { failures: 0, lockedUntil: NOW().valueOf() + 60_000 } },
    });
    writeFileSync(file, new TestSecureStorage().encryptString(v1));
    const upgraded = new OverrideRosterStore(file, new TestSecureStorage(), NOW);
    expect(upgraded.listApprovers("promotions.manage")).toEqual([]);
    upgraded.install(GRANT, DEVICE, [entry()]);
    expect(check(upgraded)).toMatchObject({ ok: false, reason: "THROTTLED" });
  });
});
