// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";
import { I18nProvider } from "./i18n";
import { SECTIONS } from "./sections";
import { ThemeProvider } from "./theme";

afterEach(cleanup);

function renderShell(onSignOut = vi.fn()) {
  render(
    <ThemeProvider>
      <I18nProvider>
        <AppShell
          sections={SECTIONS}
          active="pos"
          onNavigate={vi.fn()}
          userName="Mona"
          onSignOut={onSignOut}
        >
          <p>content</p>
        </AppShell>
      </I18nProvider>
    </ThemeProvider>,
  );
  return onSignOut;
}

describe("AppShell", () => {
  it("groups the sidebar into labelled sections", () => {
    renderShell();
    for (const label of ["Selling", "Store", "Insights", "Team & till"])
      expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("keeps theme, language and sign-out in the account menu", () => {
    const onSignOut = renderShell();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("menuitem").at(-1)!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
