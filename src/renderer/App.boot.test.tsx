// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PosAuthBridge } from "../shared/pos-auth";
import type { PosSessionBridge } from "../shared/pos-session";
import { App } from "./App";
import { I18nProvider } from "./shell/i18n";
import { ThemeProvider } from "./shell/theme";
import { ToastProvider } from "./shell/Toast";

// ADR-043 acceptance #1 (renderer level): the REAL root (`App` → `PosRoot`) renders with no Clerk provider, no
// Clerk key and no Clerk session, reaches the POS-native floor login, and signs in through the POS session
// bridge only. Any Clerk hook would throw here because there is no ClerkProvider in the tree.

function installBridges() {
  const session: PosSessionBridge = {
    login: vi.fn().mockResolvedValue({ ok: false, reason: "INVALID_CREDENTIALS" }),
    verifyCredentials: vi.fn(),
    getSession: vi.fn().mockResolvedValue(null),
    getToken: vi.fn().mockResolvedValue(null),
    logout: vi.fn(),
  };
  const roster: PosAuthBridge = {
    count: vi.fn().mockResolvedValue(1),
    roster: vi
      .fn()
      .mockResolvedValue([{ id: "r1", username: "omar", name: "Omar", role: "cashier" }]),
    replaceRosterCache: vi.fn(),
  };
  Object.defineProperty(window, "posSession", { value: session, configurable: true });
  Object.defineProperty(window, "posAuth", { value: roster, configurable: true });
  return { session, roster };
}

beforeEach(() => window.localStorage.setItem("pos.lang", "en"));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "posSession");
  Reflect.deleteProperty(window, "posAuth");
  vi.unstubAllEnvs();
});

describe("POS boot without Clerk", () => {
  it("reaches the native floor login and signs in via the POS session bridge with no Clerk config", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { session } = installBridges();
    render(
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Omar/ }));
    for (const digit of "4821") fireEvent.keyDown(window, { key: digit });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(session.login).toHaveBeenCalledWith("omar", "4821"));
    expect(document.body.textContent ?? "").not.toMatch(/clerk/i);
    const clerkCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("clerk"));
    expect(clerkCalls).toEqual([]);
    fetchSpy.mockRestore();
  });
});
