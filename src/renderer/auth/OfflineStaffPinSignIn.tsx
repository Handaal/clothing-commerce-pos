import { useCallback, useEffect, useState } from "react";

import type { OfflineBridge, OfflineStaffIdentity } from "../../shared/offline";
import { useI18n } from "../shell/i18n";

// Offline till sign-in: the same username + PIN flow as the connected card, but verified entirely in
// the main process against the locally cached staff roster (no connection required). On success the
// caller receives the operator identity; offline sales stay attributed to the grant operator — this
// PIN is an access gate. Failures are collapsed to one message so a probe cannot tell whether the
// username or the PIN was wrong; a throttled username shows a distinct "try again shortly" hint.
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as const;
const MAX_PIN = 8;

interface OfflineStaffPinSignInProps {
  readonly bridge: OfflineBridge;
  readonly onSignedIn: (operator: OfflineStaffIdentity) => void;
  readonly onBack: () => void;
}

export function OfflineStaffPinSignIn({ bridge, onSignedIn, onBack }: OfflineStaffPinSignInProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<"username" | "pin">("username");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<"none" | "invalid" | "throttled" | "unavailable">("none");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const identifier = username.trim();
    if (identifier === "" || pin === "" || busy) return;
    setBusy(true);
    setError("none");
    try {
      const result = await bridge.verifyStaffPin({ username: identifier, pin });
      if (result.ok) {
        onSignedIn(result.operator);
        return;
      }
      setError(
        result.reason === "THROTTLED"
          ? "throttled"
          : result.reason === "UNAVAILABLE"
            ? "unavailable"
            : "invalid",
      );
      setPin("");
    } catch {
      setError("invalid");
      setPin("");
    } finally {
      setBusy(false);
    }
  }, [bridge, username, pin, busy, onSignedIn]);

  // Physical-keyboard entry on the PIN step, mirroring the on-screen pad and the connected card.
  useEffect(() => {
    if (step !== "pin") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") {
        setError("none");
        setPin((current) => (current.length < MAX_PIN ? current + event.key : current));
      } else if (event.key === "Backspace") {
        setError("none");
        setPin((current) => current.slice(0, -1));
      } else if (event.key === "Enter") {
        void submit();
      } else if (event.key === "Escape") {
        setPin("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, submit]);

  if (step === "username") {
    return (
      <form
        className="pin-login"
        onSubmit={(event) => {
          event.preventDefault();
          if (username.trim() === "") return;
          setError("none");
          setStep("pin");
        }}
      >
        <h2 className="pin-login__title">{t("login.offlineTitle")}</h2>
        <p className="pin-login__hint">{t("login.usernamePrompt")}</p>
        <input
          className="pin-login__input"
          aria-label={t("login.username")}
          autoComplete="username"
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
        <button type="button" className="pin-login__back" onClick={onBack}>
          ‹ {t("login.offlineBackToConnected")}
        </button>
      </form>
    );
  }

  return (
    <div className="pin-login">
      <button
        type="button"
        className="pin-login__back"
        onClick={() => {
          setStep("username");
          setPin("");
          setError("none");
        }}
      >
        ‹ {t("login.back")}
      </button>
      <h2 className="pin-login__title">{t("login.enterPin")}</h2>
      <p className="pin-login__hint">{t("login.pinFor", { username })}</p>
      <div
        className={`pin-login__display${error !== "none" ? " pin-login__display--error" : ""}`}
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
              setError("none");
              if (key === "C") setPin("");
              else if (key === "⌫") setPin((current) => current.slice(0, -1));
              else setPin((current) => (current.length < MAX_PIN ? current + key : current));
            }}
          >
            {key}
          </button>
        ))}
      </div>
      {error !== "none" ? (
        <div className="notice notice--error" role="alert">
          {error === "throttled"
            ? t("login.throttled")
            : error === "unavailable"
              ? t("login.offlineUnavailable")
              : t("login.error")}
        </div>
      ) : null}
      <button
        type="button"
        className="button button--complete"
        disabled={busy || pin === ""}
        onClick={() => void submit()}
      >
        {busy ? t("login.signingIn") : t("login.signIn")}
      </button>
    </div>
  );
}
