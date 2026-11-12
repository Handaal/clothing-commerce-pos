import { afterEach, describe, expect, it } from "vitest";

import type { OfflineBootstrapResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { StaffRosterStore, deriveStaffPinVerifier } from "../../src/main/offline/staff-roster";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const NOW = () => new Date("2026-09-08T12:00:00.000Z");

// Build a bootstrap whose roster carries one cashier, with a PIN verifier bound to the enrolled
// device (ids.device) exactly as the server would compute it. `staffRoster` is a forward-compatible
// field not yet in the pinned SDK type, so it is attached after the typed fixture.
function rosterBootstrap(options: {
  readonly pin: string;
  readonly username?: string;
  readonly deviceId?: string;
}): OfflineBootstrapResponse {
  const verifier = deriveStaffPinVerifier({
    pin: options.pin,
    deviceId: options.deviceId ?? ids.device,
  });
  return {
    ...bootstrapFixture(),
    staffRoster: [
      {
        membershipId: ids.membership,
        username: options.username ?? "dana",
        displayName: "Dana Cashier",
        pinVerifier: { algorithm: "scrypt", ...verifier },
      },
    ],
  } as unknown as OfflineBootstrapResponse;
}

describe("offline staff roster PIN verification", () => {
  it("installs the roster and makes offline login available in readiness", () => {
    const harness = makeHarness({ bootstrap: rosterBootstrap({ pin: "2468" }), now: NOW });
    harnesses.push(harness);
    expect(harness.sales.getReadiness()).toMatchObject({
      ready: true,
      offlineLoginAvailable: true,
    });
    expect(new StaffRosterStore(harness.database, NOW).countActive()).toBe(1);
  });

  it("verifies the correct username and PIN, returning the operator identity", () => {
    const harness = makeHarness({ bootstrap: rosterBootstrap({ pin: "2468" }), now: NOW });
    harnesses.push(harness);
    const roster = new StaffRosterStore(harness.database, NOW);
    expect(roster.verifyPin({ username: "dana", pin: "2468" })).toEqual({
      ok: true,
      operator: { membershipId: ids.membership, username: "dana", displayName: "Dana Cashier" },
    });
  });

  it("accepts the username case-insensitively", () => {
    const harness = makeHarness({ bootstrap: rosterBootstrap({ pin: "2468" }), now: NOW });
    harnesses.push(harness);
    const roster = new StaffRosterStore(harness.database, NOW);
    expect(roster.verifyPin({ username: "  DANA ", pin: "2468" }).ok).toBe(true);
  });

  it("collapses a wrong PIN and an unknown username to the same INVALID reason", () => {
    const harness = makeHarness({ bootstrap: rosterBootstrap({ pin: "2468" }), now: NOW });
    harnesses.push(harness);
    const roster = new StaffRosterStore(harness.database, NOW);
    expect(roster.verifyPin({ username: "dana", pin: "9999" })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(roster.verifyPin({ username: "ghost", pin: "2468" })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("rejects the correct PIN when the verifier was bound to a different device", () => {
    const harness = makeHarness({
      bootstrap: rosterBootstrap({ pin: "2468", deviceId: "some-other-device" }),
      now: NOW,
    });
    harnesses.push(harness);
    const roster = new StaffRosterStore(harness.database, NOW);
    expect(roster.verifyPin({ username: "dana", pin: "2468" })).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("throttles a username after repeated failures", () => {
    const harness = makeHarness({ bootstrap: rosterBootstrap({ pin: "2468" }), now: NOW });
    harnesses.push(harness);
    const roster = new StaffRosterStore(harness.database, NOW);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(roster.verifyPin({ username: "dana", pin: "0000" }).ok).toBe(false);
    }
    // The next attempt — even with the correct PIN — is locked out for the cooldown window.
    expect(roster.verifyPin({ username: "dana", pin: "2468" })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
  });

  it("leaves offline login unavailable when the bootstrap carried no roster", () => {
    const harness = makeHarness({ bootstrap: bootstrapFixture(), now: NOW });
    harnesses.push(harness);
    expect(harness.sales.getReadiness()).toMatchObject({
      ready: true,
      offlineLoginAvailable: false,
    });
    expect(
      new StaffRosterStore(harness.database, NOW).verifyPin({ username: "dana", pin: "2468" }),
    ).toEqual({ ok: false, reason: "INVALID" });
  });
});
