import { useState } from "react";

import { isPosPinFormat } from "../../shared/pos-auth";
import { useI18n } from "./i18n";
import { useModalA11y } from "./useModalA11y";

// A reusable admin-credential gate for revealing sensitive figures or approving a sensitive action (the
// shifted-cafe `requireAdmin`). ADR-043: the API is the only POS credential authority, so the step-up check is
// `posSession.verifyCredentials` — verified by the server WITHOUT minting or replacing the live session (a
// supervisor approves on a cashier's till without taking it over). There is no device-local account store to
// fall back to any more. When the server is unreachable the gate FAILS CLOSED with a clear message: offline
// device verifiers carry no POS role, so admin authority cannot be proven offline (ADR-043 §10, owner decision).
// A definitive rejection is always a denial. Only a non-Electron test host (no session bridge) resolves directly.
export function AdminGate({
  title,
  onVerified,
  onCancel,
}: {
  title?: string;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    const sessionBridge = window.posSession;
    if (!sessionBridge) {
      // Non-Electron test host: no auth configured at all, so the permissive default is unchanged.
      onVerified();
      return;
    }
    const name = username.trim();
    if (name === "" || pin === "") {
      setError(t("adminGate.err.required"));
      return;
    }
    if (!isPosPinFormat(pin)) {
      setPin("");
      setError(t("login.pinTooShort"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await sessionBridge.verifyCredentials(name, pin);
      if (result.ok && result.role === "admin") {
        onVerified();
        return;
      }
      setPin("");
      if (!result.ok && result.reason === "OFFLINE") setError(t("adminGate.err.offline"));
      else if (!result.ok && result.reason === "ERROR") setError(t("login.serverError"));
      else setError(t("adminGate.err.denied"));
    } catch {
      setPin("");
      setError(t("adminGate.err.denied"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="staff-modal admin-gate" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{title ?? t("adminGate.title")}</h3>
        <div className="staff-modal__body">
          <p className="muted">{t("adminGate.hint")}</p>
          <label className="field">
            {t("adminGate.username")}
            <input
              autoFocus
              autoComplete="off"
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="field">
            {t("adminGate.pin")}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              disabled={busy}
              onChange={(e) => setPin(e.target.value)}
              aria-describedby={error ? "admin-gate-error" : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void verify();
                }
              }}
            />
          </label>
          {error ? (
            <div className="notice notice--error" role="alert" id="admin-gate-error">
              {error}
            </div>
          ) : null}
        </div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={() => void verify()} disabled={busy}>
            {busy ? t("adminGate.verifying") : t("adminGate.unlock")}
          </button>
        </div>
      </div>
    </div>
  );
}
