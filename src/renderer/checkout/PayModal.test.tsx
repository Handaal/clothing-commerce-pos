// @vitest-environment jsdom

import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../shell/i18n";
import { PayModal } from "./PayModal";

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}
afterEach(cleanup);

describe("PayModal offline tender truthfulness", () => {
  it("lets the cashier correct a matched name while keeping that customer's phone fixed", async () => {
    render(
      <PayModal
        netMinor={5_000}
        currency="EGP"
        submitting={false}
        lookupCustomer={async () => ({ name: "Old Name" })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const phone = screen.getByRole("textbox", { name: "Customer phone" }) as HTMLInputElement;
    fireEvent.change(phone, { target: { value: "+201001234567" } });
    await waitFor(() => expect(phone.readOnly).toBe(true));
    const name = screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "New Name" } });
    expect(name.value).toBe("New Name");
    expect(phone.value).toBe("+201001234567");
    fireEvent.click(screen.getByRole("button", { name: "Use another phone" }));
    expect(phone.readOnly).toBe(false);
    expect(phone.value).toBe("");
  });

  it("states that offline non-cash tenders are recorded, not captured or settled", () => {
    render(
      <PayModal
        netMinor={5_000}
        currency="USD"
        submitting={false}
        disableFreeformCustomer
        offlineTenderNotice
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Cash only: no notice needed.
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(screen.getByRole("note").textContent).toMatch(/recorded by the cashier/);
    expect(screen.getByRole("note").textContent).toMatch(/not connected to a payment gateway/);
  });

  it("never shows the offline notice on the connected checkout", () => {
    render(
      <PayModal
        netMinor={5_000}
        currency="USD"
        submitting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
