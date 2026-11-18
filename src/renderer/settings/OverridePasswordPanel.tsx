import { useState } from "react";
import { isPosPinFormat } from "../../shared/pos-auth";

import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

import { classifyCommerceError } from "../commerce/errors";
import { useI18n } from "../shell/i18n";

/**
 * ADR-042 D-6: set or change MY OWN POS override password (separate from the sign-in PIN). It is used at
 * the till when an offline voucher or return requires admin credentials (checked immediately; no approval queue). The account re-enters its POS username + PIN; the server
 * checks the password policy, stores only a one-way verifier (v2) and never returns it. Nothing is kept in this form after saving.
 */
export function OverridePasswordPanel({ client }: { client: TenantCommerceClient }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const mismatch = confirm !== "" && confirm !== password;
  const ready =
    username.trim() !== "" && isPosPinFormat(pin) && password.length >= 10 && confirm === password;

  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await client.setPosOverridePassword({
        idempotencyKey: crypto.randomUUID(),
        username: username.trim(),
        pin,
        password,
      });
      setNotice({ tone: "ok", text: t("overridePassword.saved") });
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("overridePassword.failed", { reason: classifyCommerceError(error).message }),
      });
    } finally {
      setPin("");
      setPassword("");
      setConfirm("");
      setBusy(false);
    }
  }

  return (
    <section className="staff-card" data-testid="override-password-panel">
      <div className="staff-card__head">
        <h2>{t("overridePassword.title")}</h2>
      </div>
      <p>{t("overridePassword.note")}</p>
      <div className="settings-grid">
        <label className="field">
          {t("overridePassword.username")}
          <input
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          {t("overridePassword.pin")}
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            autoComplete="off"
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <label className="field">
          {t("overridePassword.password")}
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          {t("overridePassword.confirm")}
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
      </div>
      {mismatch ? (
        <p className="notice notice--error" role="alert">
          {t("overridePassword.mismatch")}
        </p>
      ) : null}
      {notice ? (
        <p
          className={`notice ${notice.tone === "ok" ? "notice--success" : "notice--error"}`}
          role={notice.tone === "ok" ? "status" : "alert"}
          data-testid="override-password-notice"
        >
          {notice.text}
        </p>
      ) : null}
      <div className="staff-modal__actions">
        <button className="button" disabled={!ready || busy} onClick={() => void save()}>
          {t("overridePassword.save")}
        </button>
      </div>
    </section>
  );
}
