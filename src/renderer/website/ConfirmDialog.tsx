import type { ReactNode } from "react";

import { useModalA11y } from "../shell/useModalA11y";
import { useI18n } from "../shell/i18n";

// Confirmation for website actions (delete a sale, unpublish a product, discard edits, fulfil or cancel
// an online order). `children` renders extra inputs (e.g. a cancellation reason) above the buttons.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy = false,
  tone = "danger",
  confirmDisabled = false,
  children,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: "danger" | "primary";
  confirmDisabled?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ref = useModalA11y<HTMLDivElement>(onCancel);
  return (
    <div className="staff-modal__scrim" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="staff-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="website-confirm-title"
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="website-confirm-title">{title}</h3>
        <p className="muted">{message}</p>
        {children}
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className={tone === "danger" ? "button button--danger" : "button"}
            data-testid="website-confirm"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
