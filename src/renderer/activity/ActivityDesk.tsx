import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ACTIVITY_CATEGORIES,
  type ActivityBridge,
  type ActivityCategory,
  type ActivityEvent,
  type ActivitySeverity,
} from "../../shared/activity";
import { DateRangeFilter } from "../shell/DateRangeFilter";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonTable } from "../shell/Skeleton";

// The client-only activity ledger. Every click, navigation and domain event recorded on this device is
// browsable here with who did it, when, and a comprehensive description. Modeled on the shifted-cafe-v2
// activity page, adapted to the connected-POS desk styling and the local SQLite-backed bridge.

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toDateInput(date);
}

function formatInstant(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale);
}

const CATEGORY_LABEL_KEYS: Record<ActivityCategory, string> = {
  interaction: "activity.cat.interaction",
  navigation: "activity.cat.navigation",
  session: "activity.cat.session",
  sale: "activity.cat.sale",
  return: "activity.cat.return",
  inventory: "activity.cat.inventory",
  supplier: "activity.cat.supplier",
  offline: "activity.cat.offline",
  system: "activity.cat.system",
};

const SEVERITY_LABEL_KEYS: Record<ActivitySeverity, string> = {
  info: "activity.sev.info",
  warning: "activity.sev.warning",
  alert: "activity.sev.alert",
};

const SEVERITY_PILL: Record<ActivitySeverity, string> = {
  info: "pill",
  warning: "pill pill--warn",
  alert: "pill pill--bad",
};

// Prepended to CSV exports so spreadsheet apps detect UTF-8 (e.g. Arabic) content. Written as an escape
// (not a literal BOM) so it is not flagged as irregular whitespace in source.
const UTF8_BOM = "﻿";

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function ActivityDesk({
  bridge = typeof window === "undefined" ? undefined : window.activity,
}: {
  bridge?: ActivityBridge;
}) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<readonly ActivityEvent[]>([]);
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(toDateInput(new Date()));
  const [severity, setSeverity] = useState<"" | ActivitySeverity>("");
  const [category, setCategory] = useState<"" | ActivityCategory>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sectionLabel = useCallback(
    (section: string | null) => (section ? t(`nav.${section}`) : "—"),
    [t],
  );

  const load = useCallback(async () => {
    if (!bridge) {
      setError(t("activity.unavailable"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await bridge.list({
        from,
        to,
        ...(severity ? { severity } : {}),
        ...(category ? { category } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setEvents(result.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("activity.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [bridge, from, to, severity, category, search, t]);

  // Reload whenever a structured filter changes. Free-text search is applied explicitly (button/Enter)
  // so it does not fire on every keystroke.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search is applied manually, not reactively
  }, [bridge, from, to, severity, category]);

  const exportCsv = () => {
    if (events.length === 0) return;
    const header = [
      t("activity.col.when"),
      t("activity.col.user"),
      t("activity.col.section"),
      t("activity.col.category"),
      t("activity.col.action"),
      t("activity.col.description"),
      t("activity.col.severity"),
    ];
    const rows = events.map((event) => [
      formatInstant(event.occurredAt, locale),
      event.actorName ?? "—",
      sectionLabel(event.section),
      t(CATEGORY_LABEL_KEYS[event.category]) ?? event.category,
      event.action,
      event.description,
      t(SEVERITY_LABEL_KEYS[event.severity]) ?? event.severity,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([`${UTF8_BOM}${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `activity-${from}_${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const summary = useMemo(() => {
    const alerts = events.filter((event) => event.severity === "alert").length;
    const warnings = events.filter((event) => event.severity === "warning").length;
    return { total: events.length, alerts, warnings };
  }, [events]);

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("activity.audit")}</p>
          <h1>{t("nav.activity")}</h1>
        </div>
        <div className="staff-filters">
          <DateRangeFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} />
          <label>
            {t("activity.col.severity")}
            <Select<"" | ActivitySeverity>
              ariaLabel={t("activity.col.severity")}
              value={severity}
              onChange={setSeverity}
              options={[
                { value: "", label: t("activity.all") },
                { value: "info", label: t("activity.sev.info") },
                { value: "warning", label: t("activity.sev.warning") },
                { value: "alert", label: t("activity.sev.alert") },
              ]}
            />
          </label>
          <label>
            {t("activity.col.category")}
            <Select<"" | ActivityCategory>
              ariaLabel={t("activity.col.category")}
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: t("activity.all") },
                ...ACTIVITY_CATEGORIES.map((value) => ({
                  value,
                  label: t(CATEGORY_LABEL_KEYS[value]),
                })),
              ]}
            />
          </label>
          <label>
            {t("activity.search")}
            <input
              value={search}
              placeholder={t("activity.searchPlaceholder")}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load();
              }}
            />
          </label>
          <button className="button button--quiet" onClick={() => void load()} disabled={loading}>
            {t("activity.apply")}
          </button>
          <button
            className="button button--quiet"
            onClick={exportCsv}
            disabled={events.length === 0}
          >
            {t("activity.exportCsv")}
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>{t("activity.events")}</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="staff-stat">
          <span>{t("activity.warnings")}</span>
          <strong>{summary.warnings}</strong>
        </div>
        <div className="staff-stat staff-stat--accent">
          <span>{t("activity.alerts")}</span>
          <strong>{summary.alerts}</strong>
        </div>
      </div>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            {t("nav.activity")} · {from} → {to}
          </h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>{t("activity.col.when")}</th>
                <th>{t("activity.col.user")}</th>
                <th>{t("activity.col.section")}</th>
                <th>{t("activity.col.action")}</th>
                <th>{t("activity.col.description")}</th>
                <th className="end">{t("activity.col.severity")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td className="muted">{formatInstant(event.occurredAt, locale)}</td>
                  <td>{event.actorName ?? "—"}</td>
                  <td className="muted">{sectionLabel(event.section)}</td>
                  <td>
                    <strong>{t(CATEGORY_LABEL_KEYS[event.category]) ?? event.category}</strong>
                    <small>{event.action}</small>
                  </td>
                  <td>{event.description}</td>
                  <td className="end">
                    <span className={SEVERITY_PILL[event.severity] ?? "pill"}>
                      {t(SEVERITY_LABEL_KEYS[event.severity]) ?? event.severity}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? <SkeletonTable rows={6} cols={4} label={t("activity.loading")} /> : null}
        {!loading && events.length === 0 ? (
          <p className="staff-empty">{t("activity.noneRange")}</p>
        ) : null}
      </section>
    </main>
  );
}
