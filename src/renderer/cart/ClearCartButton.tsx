import { useEffect, useState } from "react";

import { useT } from "../shell/i18n";

/**
 * Empties the cart in one action. The first tap arms it ("Tap again to clear"); a second tap within a
 * few seconds clears, so a stray tap cannot wipe a long cart.
 */
export function ClearCartButton({ disabled, onClear }: { disabled: boolean; onClear: () => void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={`chip-button chip-button--danger${armed ? " chip-button--armed" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onClear();
      }}
    >
      {armed ? t("cashier.confirmClearCart") : t("cashier.clearCart")}
    </button>
  );
}
