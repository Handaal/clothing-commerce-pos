// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfflineBridge, OfflineStaffPinResult } from "../../shared/offline";
import type { PosAuthBridge, PosRosterEntry } from "../../shared/pos-auth";
import type { PosSessionLoginResult } from "../../shared/pos-session";
import { I18nProvider } from "../shell/i18n";
import { LocalLogin } from "./LocalLogin";

// ADR-043 floor login: roster-first, numeric PIN (digits, min 4, NO max, never truncated), generic credential
// failure, and offline fallback ONLY on a genuine outage through the device-bound verifier.

const ROSTER: PosRosterEntry[] = [
  { id: "r1", username: "mariam", name: "Mariam", role: "admin" },
  { id: "r2", username: "omar", name: "Omar", role: "cashier" },
];

function rosterBridge(entries: PosRosterEntry[] = ROSTER, count = entries.length): PosAuthBridge {
  return {
    count: vi.fn().mockResolvedValue(count),
    roster: vi.fn().mockResolvedValue(entries),
    replaceRosterCache: vi.fn(),
  };
}

function offlineBridge(result: OfflineStaffPinResult) {
  return { verifyStaffPin: vi.fn().mockResolvedValue(result) } as unknown as OfflineBridge & {
    verifyStaffPin: ReturnType<typeof vi.fn>;
  };
}

function setup(options: {
  login: PosSessionLoginResult;
  offline?: ReturnType<typeof offlineBridge>;
  roster?: PosAuthBridge;
}) {
  const onSignIn = vi.fn().mockResolvedValue(options.login);
  const onOfflineSignedIn = vi.fn();
  render(
    <I18nProvider>
      <LocalLogin
        rosterBridge={options.roster ?? rosterBridge()}
        onSignIn={onSignIn}
        offlineBridge={options.offline}
        onOfflineSignedIn={onOfflineSignedIn}
      />
    </I18nProvider>,
  );
  return { onSignIn, onOfflineSignedIn };
}

async function pickOmar() {
  fireEvent.click(await screen.findByRole("button", { name: /Omar/ }));
}

function typeDigits(digits: string) {
  for (const digit of digits) fireEvent.keyDown(window, { key: digit });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => window.localStorage.setItem("pos.lang", "en"));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("LocalLogin — PIN entry", () => {
  it("passes a PIN longer than the retired 8/12-digit caps through EXACTLY (no truncation)", async () => {
    const pin = "1234567890".repeat(4) + "12";
    const { onSignIn } = setup({ login: { ok: true, session: {} as never } });
    await pickOmar();
    typeDigits(pin.slice(0, 20));
    for (const digit of pin.slice(20)) fireEvent.click(screen.getByRole("button", { name: digit }));
    submit();
    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith("omar", pin));
  });

  it("rejects fewer than 4 digits locally with a format message, without calling the server", async () => {
    const { onSignIn } = setup({ login: { ok: true, session: {} as never } });
    await pickOmar();
    typeDigits("123");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("at least 4 digits");
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it("ignores non-digit keys and masks the PIN", async () => {
    setup({ login: { ok: true, session: {} as never } });
    await pickOmar();
    typeDigits("12a4b5");
    expect(screen.getByRole("status").textContent).toContain("••••");
    expect(screen.getByRole("status").textContent).not.toMatch(/[0-9]{2}/);
  });

  it("Escape clears the PIN, then a second Escape returns to the roster", async () => {
    setup({ login: { ok: true, session: {} as never } });
    await pickOmar();
    typeDigits("1234");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("status").textContent).toContain("PIN");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Who's on the till?")).toBeTruthy();
  });
});

describe("LocalLogin — online vs offline semantics", () => {
  it.each(["INVALID_CREDENTIALS", "NOT_CONFIGURED", "ERROR"] as const)(
    "a %s result NEVER falls back to the offline verifier and clears the PIN",
    async (reason) => {
      const offline = offlineBridge({ ok: true, operator: {} as never });
      const { onOfflineSignedIn } = setup({ login: { ok: false, reason }, offline });
      await pickOmar();
      typeDigits("4821");
      submit();
      await screen.findByRole("alert");
      expect(offline.verifyStaffPin).not.toHaveBeenCalled();
      expect(onOfflineSignedIn).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain("PIN");
    },
  );

  it("wrong PIN and unknown user show the same generic message", async () => {
    setup({ login: { ok: false, reason: "INVALID_CREDENTIALS" } });
    await pickOmar();
    typeDigits("4821");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Incorrect username or PIN.");
  });

  it("a genuine outage falls back to the device-bound verifier with the same PIN", async () => {
    const operator = { membershipId: "m-2", username: "omar", displayName: "Omar" };
    const offline = offlineBridge({ ok: true, operator });
    const { onOfflineSignedIn } = setup({ login: { ok: false, reason: "OFFLINE" }, offline });
    await pickOmar();
    typeDigits("4821");
    submit();
    await waitFor(() => expect(onOfflineSignedIn).toHaveBeenCalledWith(operator));
    expect(offline.verifyStaffPin).toHaveBeenCalledWith({ username: "omar", pin: "4821" });
  });

  it("an outage with offline authority unavailable fails closed with a recovery hint", async () => {
    const offline = offlineBridge({ ok: false, reason: "UNAVAILABLE" });
    const { onOfflineSignedIn } = setup({ login: { ok: false, reason: "OFFLINE" }, offline });
    await pickOmar();
    typeDigits("4821");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("offline sign-in isn't ready");
    expect(onOfflineSignedIn).not.toHaveBeenCalled();
  });

  it("an outage with offline sign-in not armed on this till never signs in", async () => {
    const { onOfflineSignedIn } = setup({ login: { ok: false, reason: "OFFLINE" } });
    await pickOmar();
    typeDigits("4821");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Reconnect to sign in");
    expect(onOfflineSignedIn).not.toHaveBeenCalled();
  });

  it("an offline wrong PIN shows the generic message; throttling is explained", async () => {
    const offline = offlineBridge({ ok: false, reason: "INVALID" });
    setup({ login: { ok: false, reason: "OFFLINE" }, offline });
    await pickOmar();
    typeDigits("4821");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Incorrect username or PIN.");
    offline.verifyStaffPin.mockResolvedValueOnce({ ok: false, reason: "THROTTLED" });
    typeDigits("4821");
    submit();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Too many attempts"),
    );
  });
});

describe("LocalLogin — roster", () => {
  it("a fresh till (empty roster cache) asks for a username and points the owner at the Admin app", async () => {
    const { onSignIn } = setup({
      login: { ok: false, reason: "INVALID_CREDENTIALS" },
      roster: rosterBridge([], 0),
    });
    expect(await screen.findByText("No accounts on this till yet")).toBeTruthy();
    expect(screen.getByText(/Admin app/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), {
      target: { value: " Mariam " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    typeDigits("2468");
    submit();
    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith("mariam", "2468"));
  });

  it("offers 'not on the list' manual username entry from the roster", async () => {
    setup({ login: { ok: false, reason: "INVALID_CREDENTIALS" } });
    fireEvent.click(await screen.findByRole("button", { name: /Not on the list/ }));
    expect(screen.getByRole("textbox", { name: "Username" })).toBeTruthy();
  });

  it("there is no Clerk or owner-setup affordance anywhere on the floor login", async () => {
    setup({ login: { ok: false, reason: "INVALID_CREDENTIALS" } });
    await screen.findByText("Who's on the till?");
    expect(document.body.textContent ?? "").not.toMatch(/owner setup|clerk/i);
  });
});
