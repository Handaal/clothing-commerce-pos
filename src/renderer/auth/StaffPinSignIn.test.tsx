// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";

// Mock the classic custom-flow hook the component drives. vi.hoisted lets the assertions reach the spies.
const clerk = vi.hoisted(() => ({
  create: vi.fn(),
  setActive: vi.fn(async () => undefined),
  isLoaded: true,
}));

vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({
    isLoaded: clerk.isLoaded,
    signIn: { create: clerk.create },
    setActive: clerk.setActive,
  }),
}));

import { StaffPinSignIn } from "./StaffPinSignIn";

function renderSignIn() {
  return render(
    <I18nProvider>
      <StaffPinSignIn />
    </I18nProvider>,
  );
}

// Pad digits are ASCII and identical in every locale, so the flow is asserted through them and the
// mocked Clerk calls rather than localized button text (the app defaults to Arabic).
function enterPin(digits: string) {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

afterEach(() => {
  cleanup();
  clerk.create.mockReset();
  clerk.setActive.mockReset();
  clerk.isLoaded = true;
});

describe("StaffPinSignIn", () => {
  it("signs in with the username and tapped PIN, then activates the session", async () => {
    clerk.create.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
    const { container } = renderSignIn();

    // Step 1: username, then continue to the PIN pad.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "dana" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    // Step 2: tap a 4-digit PIN; the display masks it to one dot per digit.
    enterPin("1234");
    expect(screen.getByRole("status").textContent).toBe("••••");

    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() =>
      expect(clerk.create).toHaveBeenCalledWith({ identifier: "dana", password: "1234" }),
    );
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_1" });
  });

  it("shows one error and clears the PIN when the credentials are rejected", async () => {
    clerk.create.mockRejectedValue(new Error("bad"));
    const { container } = renderSignIn();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "dana" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    enterPin("9999");
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(clerk.setActive).not.toHaveBeenCalled();
    // The PIN is wiped after a failure so the next attempt starts clean.
    expect(screen.getByRole("status").textContent).not.toContain("•");
  });

  it("does not attempt a sign-in with an empty PIN", () => {
    const { container } = renderSignIn();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "dana" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(clerk.create).not.toHaveBeenCalled();
  });
});
