import { beforeEach } from "vitest";

// The app now defaults to Arabic (RTL) on a fresh install. The behavioural UI tests assert against
// English labels, so we pin the test environment to English before each test. Tests that need to
// exercise the Arabic/default behaviour clear or override `pos.lang` themselves.
beforeEach(() => {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem("pos.lang", "en");
  }
});
