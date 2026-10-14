import type {
  Adjustment,
  AttendanceEntry,
  LeaveEntry,
  PayrollReportResponse,
  PayrollRow,
  PayrollSettings,
  StaffSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { currencySymbol, formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { Select } from "../shell/Select";
import { SkeletonTable } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

// ── date helpers (local calendar dates, YYYY-MM-DD) ──────────────────────────
const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = (): string => isoDate(new Date());
const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
};
const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
// ISO ↔ <input type="datetime-local"> (local wall-clock, no seconds).
const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (local: string): string | null => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const fmtMinutes = (min: number | null): string => {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

type EntryEdit = {
  id?: string;
  membershipId: string;
  clockIn: string;
  clockOut: string;
};
type AdjEdit = {
  membershipId: string;
  name: string;
  type: "bonus" | "deduction";
  amount: string;
  reason: string;
  date: string;
};
type CompEdit = {
  membershipId: string;
  name: string;
  base: string;
  overtime: string;
  normalHours: string;
};
type SettingsEdit = { normalHours: string; shiftDurationHours: string };

export function StaffAttendance({
  client,
  currency,
  branchId,
}: {
  client: TenantCommerceClient;
  currency: string;
  branchId: string | null;
}) {
  const [from, setFrom] = useState(daysAgoISO(30));
  const [to, setTo] = useState(todayISO());
  const [payroll, setPayroll] = useState<PayrollReportResponse>({
    items: [],
    totals: {
      baseSalaryMinor: 0,
      overtimeAmountMinor: 0,
      bonusMinor: 0,
      deductionMinor: 0,
      netPayMinor: 0,
    },
  });
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [leaves, setLeaves] = useState<LeaveEntry[]>([]);
  const [entries, setEntries] = useState<AttendanceEntry[]>([]);
  const [staff, setStaff] = useState<StaffSummary[]>([]);
  const [settings, setSettings] = useState<PayrollSettings>({
    normalHours: 0,
    shiftDurationHours: 9,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const [entryEdit, setEntryEdit] = useState<EntryEdit | null>(null);
  const [adjEdit, setAdjEdit] = useState<AdjEdit | null>(null);
  const [compEdit, setCompEdit] = useState<CompEdit | null>(null);
  const [settingsEdit, setSettingsEdit] = useState<SettingsEdit | null>(null);

  const money = useCallback((minor: number) => formatMoney(minor, currency), [currency]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [report, adj, lv, recent, ps] = await Promise.all([
        client.getPayrollReport({ from, to }),
        client.listAdjustments({ from, to }),
        client.listLeaves({ from, to }),
        client.listAttendance({ limit: 50 }),
        client.getPayrollSettings(),
      ]);
      setPayroll(report);
      setAdjustments(adj.items);
      setLeaves(lv.items);
      setEntries(recent.items);
      setSettings(ps);
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client, from, to]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    let active = true;
    void client
      .listStaff({ limit: 100 })
      .then((r) => active && setStaff(r.items))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  const roleByMember = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff) m.set(s.membershipId, s.roles.map((r) => r.roleName).join(", "));
    return m;
  }, [staff]);
  const nameByMember = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff) m.set(s.membershipId, s.displayName ?? s.email ?? "Member");
    for (const r of payroll.items)
      if (r.memberDisplayName && !m.has(r.membershipId)) m.set(r.membershipId, r.memberDisplayName);
    return m;
  }, [staff, payroll.items]);
  const displayName = (membershipId: string, fallback?: string | null): string =>
    nameByMember.get(membershipId) ?? fallback ?? "Member";

  // Members currently clocked in (derived from the recent entry log).
  const openMembers = useMemo(
    () => new Set(entries.filter((e) => e.clockOut === null).map((e) => e.membershipId)),
    [entries],
  );
  const totalHours = payroll.items.reduce((s, r) => s + r.workedHours, 0);

  const quick = (days: number) => {
    setFrom(daysAgoISO(days));
    setTo(todayISO());
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      await reload();
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const saveEntry = () => {
    if (!entryEdit) return;
    const clockIn = fromLocalInput(entryEdit.clockIn);
    if (!clockIn) {
      toast.error("A valid clock-in time is required.");
      return;
    }
    const clockOut = entryEdit.clockOut ? fromLocalInput(entryEdit.clockOut) : null;
    void run(async () => {
      if (entryEdit.id) {
        await client.updateAttendanceEntry({ entryId: entryEdit.id, clockIn, clockOut });
      } else {
        await client.addAttendanceEntry({
          membershipId: entryEdit.membershipId,
          branchId,
          clockIn,
          clockOut,
        });
      }
      setEntryEdit(null);
    }, "Attendance entry saved.");
  };

  const saveAdjustment = () => {
    if (!adjEdit) return;
    const amountMinor = parseMajorToMinor(adjEdit.amount);
    if (amountMinor === null) {
      toast.error("Enter a valid amount.");
      return;
    }
    void run(async () => {
      await client.createAdjustment({
        membershipId: adjEdit.membershipId,
        type: adjEdit.type,
        amountMinor,
        reason: adjEdit.reason.trim() || null,
        effectiveDate: adjEdit.date || undefined,
      });
      setAdjEdit(null);
    }, "Adjustment added.");
  };

  const saveCompensation = () => {
    if (!compEdit) return;
    const base = parseMajorToMinor(compEdit.base);
    const overtime = parseMajorToMinor(compEdit.overtime);
    const normalHours = Number(compEdit.normalHours);
    if (base === null || overtime === null || !Number.isFinite(normalHours) || normalHours < 0) {
      toast.error("Enter valid salary, overtime rate and normal hours.");
      return;
    }
    void run(async () => {
      await client.setCompensation({
        membershipId: compEdit.membershipId,
        baseSalaryMinor: base,
        overtimeRateMinor: overtime,
        normalHours,
        currency,
      });
      setCompEdit(null);
    }, "Compensation updated.");
  };

  const saveSettings = () => {
    if (!settingsEdit) return;
    const normalHours = Number(settingsEdit.normalHours);
    const shift = Number(settingsEdit.shiftDurationHours);
    if (!Number.isFinite(normalHours) || normalHours < 0 || !Number.isFinite(shift) || shift <= 0) {
      toast.error("Enter valid payroll settings.");
      return;
    }
    void run(async () => {
      await client.updatePayrollSettings({ normalHours, shiftDurationHours: shift });
      setSettingsEdit(null);
    }, "Payroll settings saved.");
  };

  const exportCsv = () => {
    const header = [
      "Employee",
      "Role",
      "Worked hours",
      "Worked days",
      "Normal hours",
      "Overtime hours",
      "Base",
      "Overtime",
      "Bonus",
      "Deductions",
      "Net pay",
      "Currency",
    ];
    const lines = payroll.items.map((r) => [
      displayName(r.membershipId, r.memberDisplayName),
      roleByMember.get(r.membershipId) ?? "",
      r.workedHours.toFixed(2),
      r.workedDays ?? "",
      r.normalHours,
      r.overtimeHours,
      (r.baseSalaryMinor / 100).toFixed(2),
      (r.overtimeAmountMinor / 100).toFixed(2),
      (r.bonusMinor / 100).toFixed(2),
      (r.deductionMinor / 100).toFixed(2),
      (r.netPayMinor / 100).toFixed(2),
      r.currency,
    ]);
    const csv = [header, ...lines]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sym = currencySymbol(currency);

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Attendance &amp; payroll</h1>
        </div>
        <div className="staff-filters">
          <button className="button button--quiet" onClick={() => quick(0)}>
            Today
          </button>
          <button className="button button--quiet" onClick={() => quick(7)}>
            Week
          </button>
          <button className="button button--quiet" onClick={() => quick(30)}>
            Month
          </button>
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            className="button button--quiet"
            onClick={exportCsv}
            disabled={payroll.items.length === 0}
          >
            Export CSV
          </button>
          <button className="button button--quiet" onClick={() => window.print()}>
            Print
          </button>
          <button
            className="button button--quiet"
            onClick={() =>
              setSettingsEdit({
                normalHours: String(settings.normalHours),
                shiftDurationHours: String(settings.shiftDurationHours),
              })
            }
          >
            Payroll settings
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>Total hours</span>
          <strong>{totalHours.toFixed(1)}</strong>
        </div>
        <div className="staff-stat">
          <span>Clocked in now</span>
          <strong>{openMembers.size}</strong>
        </div>
        <div className="staff-stat">
          <span>People</span>
          <strong>{payroll.items.length}</strong>
        </div>
        <div className="staff-stat staff-stat--accent">
          <span>Net payroll</span>
          <strong>{money(payroll.totals.netPayMinor)}</strong>
        </div>
      </div>

      {/* Payroll */}
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Payroll</h2>
          <span>
            Net total: <strong>{money(payroll.totals.netPayMinor)}</strong>
          </span>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="end">Worked (hrs)</th>
                <th className="end">Days</th>
                <th className="end">Base</th>
                <th className="end">Overtime</th>
                <th className="end">Bonus</th>
                <th className="end">Deductions</th>
                <th className="end">Net pay</th>
                <th className="end">Status</th>
                <th className="end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {payroll.items.map((r: PayrollRow) => (
                <tr key={r.membershipId}>
                  <td>
                    <strong>{displayName(r.membershipId, r.memberDisplayName)}</strong>
                    <small>{roleByMember.get(r.membershipId) || r.memberEmail || ""}</small>
                  </td>
                  <td className="end">
                    {r.workedHours.toFixed(1)}
                    <span className="muted"> / {r.normalHours}</span>
                    {r.overtimeHours > 0 ? (
                      <span className="good"> +{r.overtimeHours}h</span>
                    ) : null}
                  </td>
                  <td className="end">{r.workedDays ?? "—"}</td>
                  <td className="end">{money(r.baseSalaryMinor)}</td>
                  <td className="end good">
                    {r.overtimeAmountMinor > 0 ? `+${money(r.overtimeAmountMinor)}` : "—"}
                  </td>
                  <td className="end good">{r.bonusMinor > 0 ? `+${money(r.bonusMinor)}` : "—"}</td>
                  <td className="end bad">
                    {r.deductionMinor > 0 ? `−${money(r.deductionMinor)}` : "—"}
                  </td>
                  <td className="end accent">
                    <strong>{money(r.netPayMinor)}</strong>
                  </td>
                  <td className="end">
                    {openMembers.has(r.membershipId) ? (
                      <span className="pill pill--good">In</span>
                    ) : (
                      <span className="pill">Out</span>
                    )}
                  </td>
                  <td className="end">
                    <span className="staff-actions">
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() =>
                          setAdjEdit({
                            membershipId: r.membershipId,
                            name: displayName(r.membershipId, r.memberDisplayName),
                            type: "deduction",
                            amount: "",
                            reason: "",
                            date: todayISO(),
                          })
                        }
                      >
                        Adjust
                      </button>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() =>
                          setCompEdit({
                            membershipId: r.membershipId,
                            name: displayName(r.membershipId, r.memberDisplayName),
                            base: minorToMajorInput(r.baseSalaryMinor),
                            overtime: minorToMajorInput(r.overtimeRateMinor),
                            normalHours: String(r.normalHours),
                          })
                        }
                      >
                        Pay
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && payroll.items.length === 0 ? (
          <p className="staff-empty">No payroll rows for this period.</p>
        ) : null}
      </section>

      {/* Adjustments log */}
      {adjustments.length > 0 ? (
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>Adjustments</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Reason</th>
                  <th className="end">Amount</th>
                  <th className="end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{displayName(a.membershipId, a.memberDisplayName)}</strong>
                    </td>
                    <td>
                      <span
                        className={`pill ${a.type === "deduction" ? "pill--bad" : "pill--good"}`}
                      >
                        {a.type}
                      </span>
                    </td>
                    <td className="muted">{a.effectiveDate}</td>
                    <td className="muted">{a.reason ?? "—"}</td>
                    <td className={`end ${a.type === "deduction" ? "bad" : "good"}`}>
                      {a.type === "deduction" ? "−" : "+"}
                      {money(a.amountMinor)}
                    </td>
                    <td className="end">
                      <button
                        className="link bad"
                        disabled={busy}
                        onClick={() =>
                          void run(() => client.removeAdjustment(a.id), "Adjustment removed.")
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Attendance log (recent, editable) */}
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Attendance log</h2>
          <button
            className="button"
            disabled={busy || staff.length === 0}
            onClick={() =>
              setEntryEdit({
                membershipId: staff[0]?.membershipId ?? "",
                clockIn: toLocalInput(new Date().toISOString()),
                clockOut: "",
              })
            }
          >
            Add entry
          </button>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Clock in</th>
                <th>Clock out</th>
                <th className="end">Hours</th>
                <th className="end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <strong>{displayName(e.membershipId, e.memberDisplayName)}</strong>
                  </td>
                  <td className="muted">{fmtDateTime(e.clockIn)}</td>
                  <td className="muted">
                    {e.clockOut ? (
                      fmtDateTime(e.clockOut)
                    ) : (
                      <span className="pill pill--good">Still in</span>
                    )}
                  </td>
                  <td className="end">
                    {e.workedMinutes != null ? (e.workedMinutes / 60).toFixed(1) : "—"}
                  </td>
                  <td className="end">
                    <span className="staff-actions">
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() =>
                          setEntryEdit({
                            id: e.id,
                            membershipId: e.membershipId,
                            clockIn: toLocalInput(e.clockIn),
                            clockOut: toLocalInput(e.clockOut),
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        className="link bad"
                        disabled={busy}
                        onClick={() =>
                          void run(() => client.removeAttendanceEntry(e.id), "Entry removed.")
                        }
                      >
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && entries.length === 0 ? (
          <p className="staff-empty">No attendance entries yet.</p>
        ) : null}
      </section>

      {/* Leave log */}
      {leaves.length > 0 ? (
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>Leave log</h2>
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Left</th>
                  <th>Returned</th>
                  <th className="end">Duration</th>
                </tr>
              </thead>
              <tbody>
                {leaves.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{displayName(l.membershipId, l.memberDisplayName)}</strong>
                    </td>
                    <td className="muted">{fmtDateTime(l.leftAt)}</td>
                    <td className="muted">
                      {l.returnedAt ? (
                        fmtDateTime(l.returnedAt)
                      ) : (
                        <span className="pill pill--warn">Out</span>
                      )}
                    </td>
                    <td className="end">{fmtMinutes(l.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {loading ? <SkeletonTable rows={6} cols={5} label="Loading attendance" /> : null}

      {/* ── Modals ── */}
      {entryEdit ? (
        <Modal
          title={entryEdit.id ? "Edit entry" : "Add entry"}
          onClose={() => setEntryEdit(null)}
          onSave={saveEntry}
          busy={busy}
        >
          {!entryEdit.id ? (
            <label className="field">
              Employee
              <Select
                ariaLabel="Employee"
                value={entryEdit.membershipId}
                onChange={(membershipId) => setEntryEdit({ ...entryEdit, membershipId })}
                options={staff.map((s) => ({
                  value: s.membershipId,
                  label: s.displayName ?? s.email ?? s.membershipId,
                }))}
              />
            </label>
          ) : null}
          <label className="field">
            Clock in
            <input
              type="datetime-local"
              value={entryEdit.clockIn}
              onChange={(e) => setEntryEdit({ ...entryEdit, clockIn: e.target.value })}
            />
          </label>
          <label className="field">
            Clock out (blank = still in)
            <input
              type="datetime-local"
              value={entryEdit.clockOut}
              onChange={(e) => setEntryEdit({ ...entryEdit, clockOut: e.target.value })}
            />
          </label>
        </Modal>
      ) : null}

      {adjEdit ? (
        <Modal
          title={`Adjustment · ${adjEdit.name}`}
          onClose={() => setAdjEdit(null)}
          onSave={saveAdjustment}
          busy={busy}
        >
          <label className="field">
            Type
            <Select<"bonus" | "deduction">
              ariaLabel="Adjustment type"
              value={adjEdit.type}
              onChange={(type) => setAdjEdit({ ...adjEdit, type })}
              options={[
                { value: "deduction", label: "Deduction" },
                { value: "bonus", label: "Bonus" },
              ]}
            />
          </label>
          <label className="field">
            Amount ({sym})
            <input
              inputMode="decimal"
              value={adjEdit.amount}
              onChange={(e) => setAdjEdit({ ...adjEdit, amount: e.target.value })}
              placeholder="0.00"
            />
          </label>
          <label className="field">
            Date
            <input
              type="date"
              value={adjEdit.date}
              onChange={(e) => setAdjEdit({ ...adjEdit, date: e.target.value })}
            />
          </label>
          <label className="field">
            Reason
            <input
              value={adjEdit.reason}
              onChange={(e) => setAdjEdit({ ...adjEdit, reason: e.target.value })}
            />
          </label>
        </Modal>
      ) : null}

      {compEdit ? (
        <Modal
          title={`Compensation · ${compEdit.name}`}
          onClose={() => setCompEdit(null)}
          onSave={saveCompensation}
          busy={busy}
        >
          <label className="field">
            Monthly base salary ({sym})
            <input
              inputMode="decimal"
              value={compEdit.base}
              onChange={(e) => setCompEdit({ ...compEdit, base: e.target.value })}
            />
          </label>
          <label className="field">
            Overtime rate per hour ({sym})
            <input
              inputMode="decimal"
              value={compEdit.overtime}
              onChange={(e) => setCompEdit({ ...compEdit, overtime: e.target.value })}
            />
          </label>
          <label className="field">
            Normal hours (period threshold)
            <input
              inputMode="decimal"
              value={compEdit.normalHours}
              onChange={(e) => setCompEdit({ ...compEdit, normalHours: e.target.value })}
            />
          </label>
        </Modal>
      ) : null}

      {settingsEdit ? (
        <Modal
          title="Payroll settings"
          onClose={() => setSettingsEdit(null)}
          onSave={saveSettings}
          busy={busy}
        >
          <label className="field">
            Default normal hours
            <input
              inputMode="decimal"
              value={settingsEdit.normalHours}
              onChange={(e) => setSettingsEdit({ ...settingsEdit, normalHours: e.target.value })}
            />
          </label>
          <label className="field">
            Shift duration hours (one worked day)
            <input
              inputMode="decimal"
              value={settingsEdit.shiftDurationHours}
              onChange={(e) =>
                setSettingsEdit({ ...settingsEdit, shiftDurationHours: e.target.value })
              }
            />
          </label>
        </Modal>
      ) : null}
    </main>
  );
}

function Modal({
  title,
  children,
  onClose,
  onSave,
  busy,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
