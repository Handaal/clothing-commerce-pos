import { useEffect, useRef } from "react";

// Accessibility for modal dialogs: move focus into the dialog on open, trap Tab within it, close on
// Escape, and restore focus to the trigger on close. Attach the returned ref to the dialog content
// element (the box, not the scrim). The scrim keeps its own click-to-close handler.

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useModalA11y<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);

  // Keep the latest onClose in a ref so the setup effect can run exactly once (on open) without
  // listing onClose as a dependency. Callers overwhelmingly pass an inline arrow, whose identity
  // changes on every parent render; if the effect depended on it, every unrelated re-render (e.g.
  // the 2s offline poll in App) would tear down and re-run this effect, pulling focus back to the
  // dialog's first focusable element mid-typing and making fields appear to "go dead".
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node.tabIndex = -1;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );

    (focusables()[0] ?? node).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
    // Run once per open: the dialog ref is stable for the dialog's lifetime and onClose is read via
    // onCloseRef, so re-running on every render (and stealing focus) is both unnecessary and harmful.
  }, []);

  return ref;
}
