import type {
  PayrollCycleSettings,
  PayrollDue,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { formatMoney } from "../money";
import { useI18n } from "../shell/i18n";

export function PayrollCyclePanel({ client }: { client: TenantCommerceClient }) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<PayrollCycleSettings | null>(null);
  const [due, setDue] = useState<PayrollDue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextSettings, nextDue] = await Promise.all([
        client.getPayrollCycleSettings(),
        client.getPayrollDue(),
      ]);
      setSettings(nextSettings);
      setDue(nextDue);
      setError(null);
    } catch (cause) {
      setError(classifyCommerceError(cause).message);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial payroll settings are loaded from the API
    void reload();
  }, [reload]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      await client.updatePayrollCycleSettings(settings);
      await reload();
    } catch (cause) {
      setError(classifyCommerceError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  const markPaid = async () => {
    if (!due?.due) return;
    setBusy(true);
    try {
      await client.markPayrollPaid();
      await reload();
    } catch (cause) {
      setError(classifyCommerceError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="staff-card payroll-cycle">
      <div className="staff-card__head">
        <h2>{t("staff.cycle.title")}</h2>
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {settings ? (
        <div className="payroll-cycle__controls">
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            {t("staff.cycle.enabled")}
          </label>
          <label>
            {t("staff.cycle.day")}
            <input
              type="number"
              min={1}
              max={28}
              value={settings.anchorDay}
              onChange={(event) =>
                setSettings({ ...settings, anchorDay: Number(event.target.value) })
              }
            />
          </label>
          <button
            className="button button--quiet"
            disabled={busy || settings.anchorDay < 1 || settings.anchorDay > 28}
            onClick={() => void save()}
          >
            {t("staff.cycle.save")}
          </button>
        </div>
      ) : null}
      {due ? (
        <div className="payroll-cycle__due">
          <span>{t("staff.cycle.period", { from: due.periodStart, to: due.periodEnd })}</span>
          <strong>{formatMoney(due.totalMinor, due.currency, locale)}</strong>
          <span>
            {due.payment
              ? t("staff.cycle.paid")
              : due.due
                ? t("staff.cycle.due")
                : t("staff.cycle.notDue")}
          </span>
          {due.due ? (
            <button className="button" disabled={busy} onClick={() => void markPaid()}>
              {t("staff.cycle.markPaid")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
