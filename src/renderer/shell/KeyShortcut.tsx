import { useEffect, useRef } from "react";

/**
 * Registers a single function-key shortcut (e.g. F12 = take payment) while mounted. Rendered as a
 * component rather than a hook so it can sit next to the control it triggers, inside any branch.
 * Ignored while a modal dialog is open so it never acts behind one.
 */
export function KeyShortcut({ keyName, onTrigger }: { keyName: string; onTrigger: () => void }) {
  const triggerRef = useRef(onTrigger);
  useEffect(() => {
    triggerRef.current = onTrigger;
  }, [onTrigger]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== keyName || event.ctrlKey || event.altKey || event.metaKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      triggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyName]);

  return null;
}
