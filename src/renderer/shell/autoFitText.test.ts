// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { fitTextToWidth } from "./autoFitText";

/** jsdom has no layout, so fake a value whose rendered width scales with its font size. */
function fakeValue(available: number, widthAtBase: number, base = 24) {
  const el = document.createElement("strong");
  el.textContent = "EGP 1,234,567.89";
  el.style.fontSize = `${base}px`;
  document.body.append(el);
  const current = () => parseFloat(el.style.fontSize || `${base}px`);
  Object.defineProperty(el, "clientWidth", { get: () => available });
  Object.defineProperty(el, "scrollWidth", {
    get: () => Math.ceil((widthAtBase * current()) / base),
  });
  // fitTextToWidth clears the inline size first, then reads the designed size from computed style.
  const original = window.getComputedStyle;
  window.getComputedStyle = ((node: Element) =>
    node === el
      ? ({ fontSize: `${base}px` } as CSSStyleDeclaration)
      : original(node)) as typeof window.getComputedStyle;
  return { el, current, restore: () => (window.getComputedStyle = original) };
}

describe("fitTextToWidth", () => {
  it("leaves a value that already fits at its designed size", () => {
    const { el, restore } = fakeValue(200, 150);
    fitTextToWidth(el);
    expect(el.style.fontSize).toBe("");
    expect(el.title).toBe("");
    restore();
  });

  it("shrinks an overflowing value until it fits the card", () => {
    const { el, current, restore } = fakeValue(150, 200);
    fitTextToWidth(el);
    expect(current()).toBeLessThan(24);
    expect(el.scrollWidth).toBeLessThanOrEqual(150);
    expect(el.title).toBe("");
    restore();
  });

  it("stops at the minimum size and exposes the full value as a tooltip", () => {
    const { el, current, restore } = fakeValue(50, 400);
    fitTextToWidth(el);
    expect(current()).toBeCloseTo(24 * 0.55, 1);
    expect(el.title).toBe("EGP 1,234,567.89");
    restore();
  });
});
