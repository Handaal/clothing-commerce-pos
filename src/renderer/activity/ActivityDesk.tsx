import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ACTIVITY_CATEGORIES,
  type ActivityBridge,
  type ActivityCategory,
  type ActivityEvent,
  type ActivitySeverity,
} from "../../shared/activity";
import { useT } from "../shell/i18n";
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

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  interaction: "Interaction",
  navigation: "Navigation",
  session: "Session",
  sale: "Sale",
  return: "Return",
  inventory: "Inventory",
  supplier: "Supplier",
  offline: "Offline",
  system: "System",
};

const SEVERITY_LABELS: Record<ActivitySeverity, string> = {
  info: "Info",
  warning: "Warning",
  alert: "Alert",
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
  const t = useT();
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
      setError("Activity log is unavailable on this device.");
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
      setError(caught instanceof Error ? caught.message : "Could not load the activity log.");
    } finally {
      setLoading(false);
    }
  }, [bridge, from, to, severity, category, search]);

  // Reload whenever a structured filter changes. Free-text search is applied explicitly (button/Enter)
  // so it does not fire on every keystroke.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search is applied manually, not reactively
  }, [bridge, from, to, severity, category]);

  const exportCsv = () => {
    if (events.length === 0) return;
    const header = ["When", "User", "Section", "Category", "Action", "Description", "Severity"];
    const rows = events.map((event) => [
      formatInstant(event.occurredAt),
      event.actorName ?? "—",
      sectionLabel(event.section),
      CATEGORY_LABELS[event.category] ?? event.category,
      event.action,
      event.description,
      SEVERITY_LABELS[event.severity] ?? event.severity,
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
          <p className="eyebrow">Audit</p>
          <h1>{t("nav.activity")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label>
            Severity
            <Select<"" | ActivitySeverity>
              ariaLabel="Severity"
              value={severity}
              onChange={setSeverity}
              options={[
                { value: "", label: "All" },
                { value: "info", label: "Info" },
                { value: "warning", label: "Warning" },
                { value: "alert", label: "Alert" },
              ]}
            />
          </label>
          <label>
            Category
            <Select<"" | ActivityCategory>
              ariaLabel="Category"
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: "All" },
                ...ACTIVITY_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
              ]}
            />
          </label>
          <label>
            Search
            <input
              value={search}
              placeholder="Description, user, action…"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load();
              }}
            />
          </label>
          <button className="button button--quiet" onClick={() => void load()} disabled={loading}>
            Apply
          </button>
          <button
            className="button button--quiet"
            onClick={exportCsv}
            disabled={events.length === 0}
          >
            Export CSV
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>Events</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="staff-stat">
          <span>Warnings</span>
          <strong>{summary.warnings}</strong>
        </div>
        <div className="staff-stat staff-stat--accent">
          <span>Alerts</span>
          <strong>{summary.alerts}</strong>
        </div>
      </div>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>
            Activity · {from} → {to}
          </h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Section</th>
                <th>Action</th>
                <th>Description</th>
                <th className="end">Severity</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td className="muted">{formatInstant(event.occurredAt)}</td>
                  <td>{event.actorName ?? "—"}</td>
                  <td className="muted">{sectionLabel(event.section)}</td>
                  <td>
                    <strong>{CATEGORY_LABELS[event.category] ?? event.category}</strong>
                    <small>{event.action}</small>
                  </td>
                  <td>{event.description}</td>
                  <td className="end">
                    <span className={SEVERITY_PILL[event.severity] ?? "pill"}>
                      {SEVERITY_LABELS[event.severity] ?? event.severity}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? <SkeletonTable rows={6} cols={4} label="Loading activity" /> : null}
        {!loading && events.length === 0 ? (
          <p className="staff-empty">No activity recorded for this range.</p>
        ) : null}
      </section>
    </main>
  );
}
