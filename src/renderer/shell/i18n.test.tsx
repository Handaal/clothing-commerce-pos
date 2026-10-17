// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { I18nProvider, useI18n } from "./i18n";

afterEach(cleanup);

function Probe() {
  const { lang, dir, locale, t, toggleLang } = useI18n();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="locale">{locale}</span>
      <span data-testid="greeting">{t("pay.existing", { name: "Sara" })}</span>
      <span data-testid="missing">{t("does.not.exist")}</span>
      <button onClick={toggleLang}>toggle</button>
    </div>
  );
}

describe("i18n provider", () => {
  // The global test-setup pins pos.lang to "en"; clear it so each test controls the stored value.
  beforeEach(() => window.localStorage.clear());

  it("defaults a fresh install to Arabic (RTL) with the ar-EG locale", () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("ar");
    expect(screen.getByTestId("dir").textContent).toBe("rtl");
    expect(screen.getByTestId("locale").textContent).toBe("ar-EG-u-nu-latn");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("honours a stored English choice", () => {
    window.localStorage.setItem("pos.lang", "en");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("locale").textContent).toBe("en-US");
  });

  it("interpolates {name} placeholders and falls back to the key for missing entries", () => {
    window.localStorage.setItem("pos.lang", "en");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("greeting").textContent).toBe("Existing customer: Sara");
    expect(screen.getByTestId("missing").textContent).toBe("does.not.exist");
  });

  it("toggles language and persists the choice", () => {
    window.localStorage.setItem("pos.lang", "en");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      screen.getByText("toggle").click();
    });
    expect(screen.getByTestId("lang").textContent).toBe("ar");
    expect(window.localStorage.getItem("pos.lang")).toBe("ar");
  });
});
