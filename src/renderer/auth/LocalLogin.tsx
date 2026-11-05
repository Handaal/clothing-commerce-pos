import { useCallback, useEffect, useState } from "react";

import type { OfflineBridge, OfflineStaffIdentity } from "../../shared/offline";
import type { PosAuthBridge, PosRosterEntry } from "../../shared/pos-auth";
import { POS_PIN_MAX_LENGTH } from "../../shared/pos-auth";
import type { PosSessionLoginResult } from "../../shared/pos-session";
import { useI18n } from "../shell/i18n";

// The shifted-cafe floor login, now server-backed: pick who you are from the cached roster, then tap a
// numeric PIN. The PIN is verified by the server via the POS-native (pos_pin) provider (`onSignIn`); when
// the server is unreachable it falls back to the device-bound offline roster so the till still opens. On
// a fresh till (no cached accounts yet) it points the owner at the Clerk provisioning affordance, since
// accounts are created server-side. Failures are collapsed to one message so a probe cannot tell an
// unknown username from a wrong PIN.
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as const;

type Mode = "loading" | "empty" | "roster" | "pin";

interface LocalLoginProps {
  /** The device-local roster cache (pos_users), populated by an admin / at bootstrap. Local & offline. */
  readonly rosterBridge: PosAuthBridge;
  /** Verify username + PIN against the server (pos_pin). Success establishes the connected session. */
  readonly onSignIn: (username: string, pin: string) => Promise<PosSessionLoginResult>;
  /** Offline fallback; present only when offline login is armed and the server was unreachable. */
  readonly offlineBridge?: OfflineBridge;
  readonly onOfflineSignedIn: (operator: OfflineStaffIdentity) => void;
  /** Owner provisioning (Clerk) affordance — create the first accounts on a fresh till. */
  readonly onOwnerSetup?: () => void;
}

export function LocalLogin({
  rosterBridge,
  onSignIn,
  offlineBridge,
  onOfflineSignedIn,
  onOwnerSetup,
}: LocalLoginProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("loading");
  const [roster, setRoster] = useState<readonly PosRosterEntry[]>([]);
  const [selected, setSelected] = useState<PosRosterEntry | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const count = await rosterBridge.count();
    if (count === 0) {
      setMode("empty");
      return;
    }
    setRoster(await rosterBridge.roster());
    setMode("roster");
  }, [rosterBridge]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial external read (count/roster)
    void refresh().catch(() => setMode("empty"));
  }, [refresh]);

  const submitPin = useCallback(async () => {
    if (!selected || pin === "" || busy) return;
    setBusy(true);
    setError(false);
    try {
      const result = await onSignIn(selected.username, pin);
      if (result.ok) return; // The parent re-renders into the connected desks once the session resolves.
      // Server reachable but rejected the credential, or the provider is not configured: one failure.
      if (result.reason === "INVALID_CREDENTIALS" || result.reason === "NOT_CONFIGURED") {
        setError(true);
        setPin("");
        return;
      }
      // Server unreachable (OFFLINE/ERROR): fall back to the cached offline roster with the same PIN.
      if (offlineBridge) {
        const offline = await offlineBridge.verifyStaffPin({ username: selected.username, pin });
        if (offline.ok) {
          onOfflineSignedIn(offline.operator);
          return;
        }
      }
      setError(true);
      setPin("");
    } catch {
      setError(true);
      setPin("");
    } finally {
      setBusy(false);
    }
  }, [selected, pin, busy, onSignIn, offlineBridge, onOfflineSignedIn]);

  // Physical-keyboard entry on the PIN step (keyboards + bench scanners), mirroring the on-screen pad.
  useEffect(() => {
    if (mode !== "pin") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") {
        setError(false);
        setPin((current) => (current.length < POS_PIN_MAX_LENGTH ? current + event.key : current));
      } else if (event.key === "Backspace") {
        setError(false);
        setPin((current) => current.slice(0, -1));
      } else if (event.key === "Enter") {
        void submitPin();
      } else if (event.key === "Escape") {
        setPin("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, submitPin]);

  if (mode === "loading") return <p className="inline-state">{t("login.preparing")}</p>;

  // Fresh till: no cached accounts. Accounts are provisioned server-side, so steer the owner to the Clerk
  // setup affordance rather than seeding a device-local admin.
  if (mode === "empty") {
    return (
      <div className="pin-login">
        <h2 className="pin-login__title">{t("login.noAccountsTitle")}</h2>
        <p className="pin-login__hint">{t("login.noAccountsHint")}</p>
        {onOwnerSetup ? (
          <button type="button" className="button button--complete" onClick={onOwnerSetup}>
            {t("login.ownerSetup")}
          </button>
        ) : null}
      </div>
    );
  }

  if (mode === "roster") {
    return (
      <div className="pin-login">
        <h2 className="pin-login__title">{t("login.chooseOperator")}</h2>
        <p className="pin-login__hint">{t("login.chooseOperatorHint")}</p>
        {roster.length === 0 ? (
          <p className="staff-empty">{t("login.noOperators")}</p>
        ) : (
          <ul className="roster">
            {roster.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="roster__item"
                  onClick={() => {
                    setSelected(entry);
                    setPin("");
                    setError(false);
                    setMode("pin");
                  }}
                >
                  <span className="roster__name">{entry.name}</span>
                  <span className={`pill ${entry.role === "admin" ? "pill--good" : ""}`}>
                    {t(`login.role.${entry.role}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {onOwnerSetup ? (
          <button type="button" className="pin-login__back" onClick={onOwnerSetup}>
            {t("login.ownerSetup")}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pin-login">
      <button
        type="button"
        className="pin-login__back"
        onClick={() => {
          setSelected(null);
          setPin("");
          setError(false);
          setMode("roster");
        }}
      >
        ‹ {t("login.back")}
      </button>
      <h2 className="pin-login__title">{t("login.enterPin")}</h2>
      <p className="pin-login__hint">{t("login.pinFor", { username: selected?.name ?? "" })}</p>
      <div
        className={`pin-login__display${error ? " pin-login__display--error" : ""}`}
        role="status"
        aria-label={t("login.pin")}
      >
        {pin ? (
          "•".repeat(pin.length)
        ) : (
          <span className="pin-login__placeholder">{t("login.pin")}</span>
        )}
      </div>
      <div className="pin-pad">
        {PAD.map((key) => (
          <button
            type="button"
            key={key}
            className="pin-key"
            disabled={busy}
            aria-label={key === "C" ? t("login.clear") : key === "⌫" ? t("login.backspace") : key}
            onClick={() => {
              setError(false);
              if (key === "C") setPin("");
              else if (key === "⌫") setPin((current) => current.slice(0, -1));
              else
                setPin((current) =>
                  current.length < POS_PIN_MAX_LENGTH ? current + key : current,
                );
            }}
          >
            {key}
          </button>
        ))}
      </div>
      {error ? (
        <div className="notice notice--error" role="alert">
          {t("login.error")}
        </div>
      ) : null}
      <button
        type="button"
        className="button button--complete"
        disabled={busy || pin === ""}
        onClick={() => void submitPin()}
      >
        {busy ? t("login.signingIn") : t("login.signIn")}
      </button>
    </div>
  );
}
