// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { PayModal, quickCashAmounts } from "./PayModal";

afterEach(cleanup);

describe("quick cash amounts", () => {
  it("offers the exact amount plus up to three distinct banknote round-ups", () => {
    expect(quickCashAmounts(43_700)).toEqual([43_700, 45_000, 50_000, 60_000]);
    expect(quickCashAmounts(50_000)).toEqual([50_000, 60_000, 100_000]);
    expect(quickCashAmounts(0)).toEqual([]);
  });

  it("fills cash received with one tap and shows the change", () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider>
        <PayModal
          netMinor={43_700}
          currency="EGP"
          submitting={false}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    );
    const group = screen.getByRole("group", { name: "Quick cash amounts" });
    const buttons = group.querySelectorAll("button");
    expect(buttons[0].textContent).toBe("Exact");
    fireEvent.click(buttons[2]); // 500.00
    expect(screen.getByText(/63\.00/)).toBeTruthy(); // change 500 − 437
  });
});
