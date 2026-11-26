// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { ClearCartButton } from "./ClearCartButton";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ClearCartButton", () => {
  it("needs a second tap to clear and disarms after a few seconds", () => {
    vi.useFakeTimers();
    const onClear = vi.fn();
    render(
      <I18nProvider>
        <ClearCartButton disabled={false} onClear={onClear} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3_100));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap again to clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
