import { useCallback, useEffect, useState } from "react";

import type { OfflineBridge, OfflineStaffIdentity } from "../../shared/offline";
import type { PosAuthBridge, PosRosterEntry } from "../../shared/pos-auth";
import { isPosPinFormat } from "../../shared/pos-auth";
import type { PosSessionLoginResult } from "../../shared/pos-session";
import { useI18n } from "../shell/i18n";

// The floor login (ADR-043), modelled on the shifted-cafe roster-first flow but server-backed: pick who you are
// from the display-only roster cache (or type your username on a fresh till), then enter a numeric PIN on the
// pad or a physical keyboard. The PIN is verified by the API (POS-native pos_pin account). Offline fallback is
// attempted ONLY when the server is genuinely unreachable (`OFFLINE`) and only through the device-bound offline
// verifier, which itself enforces the bounded offline authority window. A definitive server rejection never
// falls back. Credential failures collapse to one message so a probe cannot tell an unknown username from a
// wrong PIN. PINs are digits only, at least 4, with NO maximum: nothing here truncates what was typed.
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as const;

type Mode = "loading" | "roster" | "username" | "pin";
type Failure =
  "none" | "credentials" | "format" | "throttled" | "offlineNotReady" | "server" | "notConfigured";

const FAILURE_KEYS: Record<Exclude<Failure, "none">, string> = {
  credentials: "login.error",
  format: "login.pinTooShort",
  throttled: "login.throttled",
  offlineNotReady: "login.offlineNotReady",
  server: "login.serverError",
  notConfigured: "login.notConfigured",
};

interface LocalLoginProps {
  /** The display-only roster cache (pos_users). Never an authenticator. */
  readonly rosterBridge: PosAuthBridge;
  /** Verify username + PIN against the server (pos_pin). Success establishes the connected session. */
  readonly onSignIn: (username: string, pin: string) => Promise<PosSessionLoginResult>;
  /** The device-bound offline verifier; present only while offline sign-in is armed on this till. */
  readonly offlineBridge?: OfflineBridge;
  readonly onOfflineSignedIn: (operator: OfflineStaffIdentity) => void;
}

export function LocalLogin({
  rosterBridge,
  onSignIn,
  offlineBridge,
  onOfflineSignedIn,
}: LocalLoginProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("loading");
  const [freshTill, setFreshTill] = useState(false);
  const [roster, setRoster] = useState<readonly PosRosterEntry[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [failure, setFailure] = useState<Failure>("none");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [count, entries] = await Promise.all([rosterBridge.count(), rosterBridge.roster()]);
    setRoster(entries);
    if (count === 0 || entries.length === 0) {
      // Fresh till (or nobody active cached): sign in by typing the username; the server is the authority.
      setFreshTill(count === 0);
      setMode("username");
      return;
    }
    setMode("roster");
  }, [rosterBridge]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial external read (count/roster)
    void refresh().catch(() => setMode("username"));
  }, [refresh]);

  const backToStart = useCallback(() => {
    setUsername("");
    setDisplayName("");
    setPin("");
    setFailure("none");
    setMode(roster.length > 0 ? "roster" : "username");
  }, [roster.length]);

  const fail = useCallback((reason: Exclude<Failure, "none">) => {
    setFailure(reason);
    setPin("");
  }, []);

  const submitPin = useCallback(async () => {
    if (username === "" || pin === "" || busy) return;
    if (!isPosPinFormat(pin)) {
      fail("format");
      return;
    }
    setBusy(true);
    setFailure("none");
    try {
      const result = await onSignIn(username, pin);
      if (result.ok) return; // The parent re-renders into the connected desks once the session resolves.
      if (result.reason === "INVALID_CREDENTIALS") return fail("credentials");
      if (result.reason === "NOT_CONFIGURED") return fail("notConfigured");
      if (result.reason !== "OFFLINE") return fail("server"); // Not proven to be an outage: fail closed.
      // Server unreachable: the device-bound offline verifier, within the bounded offline authority only.
      if (!offlineBridge) return fail("offlineNotReady");
      const offline = await offlineBridge.verifyStaffPin({ username, pin });
      if (offline.ok) {
        setPin("");
        onOfflineSignedIn(offline.operator);
        return;
      }
      if (offline.reason === "THROTTLED") return fail("throttled");
      if (offline.reason === "UNAVAILABLE") return fail("offlineNotReady");
      return fail("credentials");
    } catch {
      fail("server");
    } finally {
      setBusy(false);
    }
  }, [username, pin, busy, onSignIn, offlineBridge, onOfflineSignedIn, fail]);

  // Physical-keyboard entry on the PIN step (keyboards + bench scanners), mirroring the on-screen pad. Escape
  // clears the PIN, and a second Escape on an empty PIN returns to the roster.
  useEffect(() => {
    if (mode !== "pin") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length === 1 && event.key >= "0" && event.key <= "9") {
        setFailure("none");
        setPin((current) => current + event.key);
      } else if (event.key === "Backspace") {
        setFailure("none");
        setPin((current) => current.slice(0, -1));
      } else if (event.key === "Enter") {
        void submitPin();
      } else if (event.key === "Escape") {
        if (pin === "") backToStart();
        else setPin("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, pin, submitPin, backToStart]);

  if (mode === "loading") return <p className="inline-state">{t("login.preparing")}</p>;

  if (mode === "roster") {
    return (
      <div className="pin-login">
        <h2 className="pin-login__title">{t("login.chooseOperator")}</h2>
        <p className="pin-login__hint">{t("login.chooseOperatorHint")}</p>
        <ul className="roster">
          {roster.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="roster__item"
                onClick={() => {
                  setUsername(entry.username);
                  setDisplayName(entry.name);
                  setPin("");
                  setFailure("none");
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
        <button
          type="button"
          className="pin-login__back"
          onClick={() => {
            setUsername("");
            setFailure("none");
            setMode("username");
          }}
        >
          {t("login.notListed")}
        </button>
      </div>
    );
  }

  if (mode === "username") {
    return (
      <form
        className="pin-login"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = username.trim().toLowerCase();
          if (typed === "") return;
          setUsername(typed);
          setDisplayName(typed);
          setPin("");
          setFailure("none");
          setMode("pin");
        }}
      >
        {roster.length > 0 ? (
          <button type="button" className="pin-login__back" onClick={backToStart}>
            ‹ {t("login.back")}
          </button>
        ) : null}
        <h2 className="pin-login__title">
          {freshTill ? t("login.noAccountsTitle") : t("login.enterUsername")}
        </h2>
        <p className="pin-login__hint">
          {freshTill ? t("login.noAccountsHint") : t("login.usernamePrompt")}
        </p>
        <input
          className="pin-login__input"
          aria-label={t("login.username")}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder={t("login.usernamePlaceholder")}
        />
        <button type="submit" className="button button--complete" disabled={username.trim() === ""}>
          {t("login.continue")}
        </button>
      </form>
    );
  }

  return (
    <div className="pin-login">
      <button type="button" className="pin-login__back" onClick={backToStart}>
        ‹ {t("login.back")}
      </button>
      <h2 className="pin-login__title">{t("login.enterPin")}</h2>
      <p className="pin-login__hint">{t("login.pinFor", { username: displayName })}</p>
      <div
        className={`pin-login__display${failure !== "none" ? " pin-login__display--error" : ""}`}
        role="status"
        aria-label={t("login.pin")}
      >
        {pin ? (
          "•".repeat(Math.min(pin.length, 12)) + (pin.length > 12 ? ` +${pin.length - 12}` : "")
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
              setFailure("none");
              if (key === "C") setPin("");
              else if (key === "⌫") setPin((current) => current.slice(0, -1));
              else setPin((current) => current + key);
            }}
          >
            {key}
          </button>
        ))}
      </div>
      {failure !== "none" ? (
        <div className="notice notice--error" role="alert">
          {t(FAILURE_KEYS[failure])}
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
