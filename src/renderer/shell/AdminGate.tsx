import { useState } from "react";

import { useI18n } from "./i18n";
import { useModalA11y } from "./useModalA11y";

// A reusable admin-credential gate for revealing sensitive figures or approving a sensitive action.
// It verifies a username + PIN and only resolves when the matched operator is an admin — mirroring
// shifted-cafe-v2's `requireAdmin`.
//
// Connected tills sign in with server (pos_pin) accounts, so the authoritative step-up check is the
// server — `posSession.verifyCredentials`, which validates WITHOUT replacing the live session (a
// supervisor can approve on a cashier's till without hijacking it). The offline roster (`posAuth`) is
// a separate credential store with its own locally-created PINs, so checking it for a connected
// operator wrongly rejected their real credentials. We fall back to it only when the server is
// unreachable, so an offline operator can still unlock. When neither bridge exists (e.g. a
// non-Electron test host), the gate resolves immediately so the permissive default is unchanged.
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
    const rosterBridge = window.posAuth;
    if (!sessionBridge && !rosterBridge) {
      // No auth configured at all: nothing to verify against, so allow the reveal.
      onVerified();
      return;
    }
    const name = username.trim();
    const code = pin.trim();
    if (name === "" || code === "") {
      setError(t("adminGate.err.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Authoritative connected check first. A wrong credential here is definitive (deny); only an
      // unreachable/unconfigured server falls through to the offline roster.
      if (sessionBridge) {
        const result = await sessionBridge.verifyCredentials(name, code);
        if (result.ok) {
          if (result.role !== "admin") {
            setError(t("adminGate.err.denied"));
            return;
          }
          onVerified();
          return;
        }
        if (result.reason === "INVALID_CREDENTIALS") {
          setError(t("adminGate.err.denied"));
          return;
        }
        // OFFLINE / NOT_CONFIGURED / ERROR → try the offline roster below.
      }
      if (rosterBridge) {
        const result = await rosterBridge.login(name, code);
        if (!result.ok || result.user.role !== "admin") {
          setError(t("adminGate.err.denied"));
          return;
        }
        onVerified();
        return;
      }
      // Server was unreachable and there is no offline roster to fall back to.
      setError(t("adminGate.err.denied"));
    } catch {
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
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void verify();
                }
              }}
            />
          </label>
          {error ? (
            <div className="notice notice--error" role="alert">
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
