// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PosSessionBridge, PosSessionVerifyResult } from "../../shared/pos-session";
import { AdminGate } from "./AdminGate";
import { I18nProvider } from "./i18n";

// ADR-043 admin step-up: verified by the server WITHOUT replacing the session; never via a device-local store;
// fails closed when the server is unreachable (offline device verifiers carry no POS role).

function mountWith(result: PosSessionVerifyResult) {
  const bridge = {
    login: vi.fn(),
    verifyCredentials: vi.fn().mockResolvedValue(result),
    getSession: vi.fn(),
    getToken: vi.fn(),
    logout: vi.fn(),
  } satisfies PosSessionBridge;
  const roster = { count: vi.fn(), roster: vi.fn(), replaceRosterCache: vi.fn() };
  Object.defineProperty(window, "posSession", { value: bridge, configurable: true });
  Object.defineProperty(window, "posAuth", { value: roster, configurable: true });
  const onVerified = vi.fn();
  render(
    <I18nProvider>
      <AdminGate onVerified={onVerified} onCancel={() => undefined} />
    </I18nProvider>,
  );
  return { bridge, roster, onVerified };
}

function enter(username: string, pin: string) {
  fireEvent.change(screen.getByLabelText("Admin username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Admin PIN"), { target: { value: pin } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
}

beforeEach(() => window.localStorage.setItem("pos.lang", "en"));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "posSession");
  Reflect.deleteProperty(window, "posAuth");
});

describe("AdminGate", () => {
  it("approves an admin verified by the server without touching the live session", async () => {
    const { bridge, onVerified } = mountWith({ ok: true, role: "admin" });
    const long = "9".repeat(30);
    enter("mariam", long);
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(bridge.verifyCredentials).toHaveBeenCalledWith("mariam", long);
    expect(bridge.login).not.toHaveBeenCalled();
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it("denies a valid cashier", async () => {
    const { onVerified } = mountWith({ ok: true, role: "cashier" });
    enter("omar", "4821");
    expect((await screen.findByRole("alert")).textContent).toContain("not an admin");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("denies a definitive rejection", async () => {
    const { onVerified } = mountWith({ ok: false, reason: "INVALID_CREDENTIALS" });
    enter("mariam", "4821");
    expect((await screen.findByRole("alert")).textContent).toContain("not an admin");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("fails closed when the server is unreachable — never consults any local store", async () => {
    const { roster, onVerified } = mountWith({ ok: false, reason: "OFFLINE" });
    enter("mariam", "4821");
    expect((await screen.findByRole("alert")).textContent).toContain("needs a connection");
    expect(onVerified).not.toHaveBeenCalled();
    expect(roster.count).not.toHaveBeenCalled();
    expect(roster.roster).not.toHaveBeenCalled();
  });

  it("rejects a malformed PIN locally without calling the server", async () => {
    const { bridge } = mountWith({ ok: true, role: "admin" });
    enter("mariam", "12a");
    expect((await screen.findByRole("alert")).textContent).toContain("at least 4 digits");
    expect(bridge.verifyCredentials).not.toHaveBeenCalled();
  });
});
