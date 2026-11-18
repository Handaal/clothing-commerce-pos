import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";
import type { HeldCart } from "./held";
import { cartTotal } from "./cart";

export function HeldCartsPanel({
  carts,
  currency,
  canResume,
  onResume,
  onDelete,
  onClose,
}: {
  carts: readonly HeldCart[];
  currency: string;
  canResume: boolean;
  onResume: (cart: HeldCart) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("cashier.heldCarts")}
      onClick={onClose}
    >
      <div className="modal-card held-carts-panel" onClick={(event) => event.stopPropagation()}>
        <div className="variant-dialog__head">
          <h3>{t("cashier.heldCarts")}</h3>
          <button className="button button--quiet" onClick={onClose}>
            {t("cashier.closeVariants")}
          </button>
        </div>
        {carts.length === 0 ? <p className="inline-state">{t("cashier.noHeldCarts")}</p> : null}
        {!canResume && carts.length > 0 ? (
          <p className="inline-state">{t("cashier.emptyBeforeResume")}</p>
        ) : null}
        {carts.map((cart) => (
          <div className="held-cart-row" key={cart.id}>
            <div>
              <strong>{new Date(cart.heldAt).toLocaleString(locale)}</strong>
              <span>
                {t("cashier.lines", { count: cart.lines.length })} ·{" "}
                {formatMoney(cartTotal(cart.lines), currency, locale)}
              </span>
            </div>
            <button className="button" disabled={!canResume} onClick={() => onResume(cart)}>
              {t("cashier.resumeCart")}
            </button>
            <button className="button button--quiet" onClick={() => onDelete(cart.id)}>
              {t("cashier.deleteHeldCart")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
