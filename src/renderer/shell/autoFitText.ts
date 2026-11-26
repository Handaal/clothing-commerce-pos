/**
 * Auto-fit for the big figures shown inside cards (stat tiles, totals, money summaries).
 *
 * A card's value is laid out on one line at its designed size. When the value is wider than the card
 * (a long money amount, a big count, a narrow column), its font size is scaled down just enough to fit,
 * never below MIN_SCALE of the designed size. Past that floor the CSS ellipsis takes over and the full
 * value is put in the element's `title` so it can still be read on hover.
 *
 * It is installed once at the root and applies to every element matching FIT_TEXT_SELECTOR, so desks
 * keep rendering plain `<strong>` values. The matching CSS (one line, `min-width: 0`, ellipsis) lives
 * in styles.css under "Card figures that shrink to fit". Add a selector to both places, or put
 * `data-fit` on any element to opt it in.
 */
export const FIT_TEXT_SELECTOR = [
  "[data-fit]",
  ".staff-stat > strong",
  ".voucher-stat > strong",
  ".local-report__figure-value",
  ".supplier-money-summary strong",
  ".total-row > strong",
  ".pay-due > strong",
  ".pay-remaining > strong",
  ".pay-change > strong",
].join(",");

const MIN_SCALE = 0.55;

const lastText = new WeakMap<HTMLElement, string>();
const lastWidth = new WeakMap<Element, number>();

export function fitTextToWidth(el: HTMLElement): void {
  el.style.fontSize = "";
  const available = el.clientWidth;
  if (available <= 0) return;
  const base = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(base) || base <= 0) return;

  let size = base;
  // Width tracks font size almost linearly, so this settles in one pass; the second covers rounding.
  for (let pass = 0; pass < 3 && el.scrollWidth > available && size > base * MIN_SCALE; pass += 1) {
    size = Math.max(base * MIN_SCALE, size * (available / el.scrollWidth) * 0.98);
    el.style.fontSize = `${size.toFixed(2)}px`;
  }

  if (el.scrollWidth > available) {
    el.title = el.textContent?.trim() ?? "";
  } else if (el.title) {
    el.removeAttribute("title");
  }
}

/** Starts watching `root` for card figures. Returns a disposer. No-op where ResizeObserver is missing. */
export function installAutoFitText(root: HTMLElement = document.body): () => void {
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }

  const tracked = new Set<HTMLElement>();

  // Values size against their card, so watch the parent: watching the value itself would re-trigger
  // every time its own font size changes.
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      if (lastWidth.get(entry.target) === width) continue;
      lastWidth.set(entry.target, width);
      for (const child of entry.target.children) {
        if (child instanceof HTMLElement && tracked.has(child)) fitTextToWidth(child);
      }
    }
  });

  let frame = 0;
  const scan = () => {
    frame = 0;
    for (const el of tracked) {
      if (!el.isConnected) {
        tracked.delete(el);
        if (el.parentElement) resizeObserver.unobserve(el.parentElement);
      }
    }
    for (const node of root.querySelectorAll<HTMLElement>(FIT_TEXT_SELECTOR)) {
      const text = node.textContent ?? "";
      if (!tracked.has(node)) {
        tracked.add(node);
        if (node.parentElement) resizeObserver.observe(node.parentElement);
      } else if (lastText.get(node) === text) {
        continue;
      }
      lastText.set(node, text);
      fitTextToWidth(node);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(scan);
  };

  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
  // Web fonts change glyph widths once they load; refit everything then.
  void document.fonts?.ready.then(() => {
    for (const el of tracked) fitTextToWidth(el);
  });
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    tracked.clear();
  };
}
