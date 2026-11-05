// The classic `useSignIn` custom-flow hook ({ isLoaded, signIn, setActive }) lives under /legacy in
// @clerk/react v6; the bare entry exports the newer signals-shaped hook, which this flow does not use.
import { useSignIn } from "@clerk/react/legacy";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";

// Email-less staff sign-in in the shifted-cafe manner: pick who you are, then tap a numeric PIN. Accounts
// are provisioned server-side as Clerk username + PIN (no email), so this drives Clerk's `useSignIn`
// directly instead of the hosted <SignIn> card. Step one is a username field today; once the tenant staff
// roster endpoint lands it becomes the roster grid, and the PIN step below stays exactly as is.
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as const;
const MAX_PIN = 8;

export function StaffPinSignIn() {
  const { t } = useI18n();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [step, setStep] = useState<"username" | "pin">("username");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const identifier = username.trim();
    if (!isLoaded || !signIn || !setActive || identifier === "" || pin === "" || busy) return;
    setBusy(true);
    setError(false);
    try {
      const attempt = await signIn.create({ identifier, password: pin });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        // The active session flips App's useAuth to signed-in and this card unmounts.
        await setActive({ session: attempt.createdSessionId });
        return;
      }
      setError(true);
      setPin("");
    } catch {
      // Clerk failures are intentionally collapsed to one message so a probe cannot tell whether it was
      // the username or the PIN that was wrong.
      setError(true);
      setPin("");
    } finally {
      setBusy(false);
    }
  }, [isLoaded, signIn, setActive, username, pin, busy]);

  // Physical-keyboard entry on the PIN step (bench scanners and keyboards), mirroring the on-screen pad:
  // digits append, Backspace deletes, Enter submits, Escape clears. Bound at the window so it works
  // without focusing a field — the PIN step has no text input to steal the keystrokes.
  useEffect(() => {
    if (step !== "pin") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") {
        setError(false);
        setPin((current) => (current.length < MAX_PIN ? current + event.key : current));
      } else if (event.key === "Backspace") {
        setError(false);
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

  if (!isLoaded) return <p className="inline-state">{t("login.preparing")}</p>;

  if (step === "username") {
    return (
      <form
        className="pin-login"
        onSubmit={(event) => {
          event.preventDefault();
          if (username.trim() === "") return;
          setError(false);
          setStep("pin");
        }}
      >
        <h2 className="pin-login__title">{t("login.username")}</h2>
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
          setError(false);
        }}
      >
        ‹ {t("login.back")}
      </button>
      <h2 className="pin-login__title">{t("login.enterPin")}</h2>
      <p className="pin-login__hint">{t("login.pinFor", { username })}</p>
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
              else setPin((current) => (current.length < MAX_PIN ? current + key : current));
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
        onClick={() => void submit()}
      >
        {busy ? t("login.signingIn") : t("login.signIn")}
      </button>
    </div>
  );
}
