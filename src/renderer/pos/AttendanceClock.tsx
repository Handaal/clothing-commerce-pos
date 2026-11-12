import type { AttendanceEntry, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalAttendanceState,
  OfflineAttendanceEventType,
  OfflineBridge,
} from "../../shared/offline";
import { useI18n } from "../shell/i18n";

type Phase = "loading" | "ready" | "working" | "error";

/** The slice of the offline bridge the clock needs — capture an event and read the local state. */
export type AttendanceOfflineBridge = Pick<
  OfflineBridge,
  "recordAttendanceEvent" | "getLocalAttendance"
>;

// The signed-in operator's own attendance toggle, rendered in the POS top bar. Online, it reflects the
// server's authoritative open-entry state (one open entry at a time) and records the register's branch
// on clock-in. When the device is offline but offline authority is ready, it switches to an offline
// capture path: it writes a signed, durable, PROVISIONAL clock event to the local outbox and shows a
// "queued — will sync" state. It never claims a server-confirmed clock-in while offline. All server-side
// timing/pairing/payroll remains owned by the Commerce API.
export function AttendanceClock({
  client,
  branchId,
  disabled = false,
  offline,
  networkOnline = true,
  offlineReady = false,
}: {
  client: TenantCommerceClient;
  branchId: string | null;
  disabled?: boolean;
  offline?: AttendanceOfflineBridge;
  networkOnline?: boolean;
  offlineReady?: boolean;
}) {
  const { t, locale } = useI18n();
  // Offline capture is active only when we are genuinely offline AND offline authority is installed.
  // Otherwise the connected server path below is authoritative.
  const offlineMode = Boolean(offline) && !networkOnline && offlineReady;
  const [openEntry, setOpenEntry] = useState<AttendanceEntry | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  // Mid-shift leave is self-service start/end. The API exposes no "my open leave" read, so this is
  // tracked optimistically from the start/end responses and only offered while on shift (clocked in).
  const [onLeave, setOnLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  // Discards results from a client that has been swapped out (tenant/session change) mid-flight.
  const activeClient = useRef(client);
  // Offline capture state: the device-local attendance picture + a transient "queued" phase.
  const [localAttendance, setLocalAttendance] = useState<LocalAttendanceState | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    activeClient.current = client;
    setPhase("loading");
    setMessage(null);
    try {
      const mine = await client.getMyAttendance({ limit: 1 });
      if (activeClient.current !== client) return;
      setOpenEntry(mine.openEntry);
      setPhase("ready");
    } catch {
      if (activeClient.current !== client) return;
      setPhase("error");
      setMessage(t("attendance.unavailable"));
    }
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load reads external attendance status
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async () => {
    setPhase("working");
    setMessage(null);
    try {
      const result = openEntry ? await client.clockOut() : await client.clockIn({ branchId });
      if (activeClient.current !== client) return;
      // Clock-out closes the entry (no longer open); clock-in opens a new one. Ending the shift also
      // clears any lingering leave state — leave only applies while clocked in.
      const stillOpen = result.entry.clockOut === null;
      setOpenEntry(stillOpen ? result.entry : null);
      if (!stillOpen) setOnLeave(false);
      setPhase("ready");
    } catch {
      if (activeClient.current !== client) return;
      // Re-sync from the server: the most common failure is a stale open/closed view (already clocked
      // in/out from another device), which a refresh resolves to the true state.
      setMessage(openEntry ? t("attendance.clockOutFail") : t("attendance.clockInFail"));
      void refresh();
    }
  }, [client, openEntry, branchId, refresh, t]);

  const toggleLeave = useCallback(async () => {
    if (!openEntry) return;
    setLeaveBusy(true);
    setMessage(null);
    try {
      const result = onLeave ? await client.endLeave() : await client.startLeave({ branchId });
      if (activeClient.current !== client) return;
      // An open leave has no return time yet; ending it stamps `returnedAt`.
      setOnLeave(result.entry.returnedAt === null);
    } catch {
      if (activeClient.current !== client) return;
      setMessage(onLeave ? t("attendance.endLeaveFail") : t("attendance.startLeaveFail"));
    } finally {
      if (activeClient.current === client) setLeaveBusy(false);
    }
  }, [client, openEntry, onLeave, branchId, t]);

  // Refresh the device-local attendance view whenever offline capture becomes active, so the button
  // can offer the correct next action (toggle in/out from the last local event) and show the queue.
  useEffect(() => {
    if (!offlineMode || !offline) return;
    let active = true;
    offline
      .getLocalAttendance()
      .then((state) => {
        if (active) setLocalAttendance(state);
      })
      .catch(() => {
        if (active) setLocalAttendance(null);
      });
    return () => {
      active = false;
    };
  }, [offlineMode, offline]);

  // The next clock action offline toggles from the last captured local event. With no local history we
  // default to clock-in; the server adjudicates true pairing later (no payroll claim is made here).
  const offlineNextAction: OfflineAttendanceEventType =
    localAttendance?.lastEvent?.eventType === "clock_in" ? "clock_out" : "clock_in";

  const captureOffline = useCallback(async () => {
    if (!offline) return;
    setOfflineBusy(true);
    setOfflineMessage(null);
    try {
      await offline.recordAttendanceEvent({ eventType: offlineNextAction });
      const state = await offline.getLocalAttendance();
      setLocalAttendance(state);
      // Explicitly a QUEUED state — never "clocked in successfully" as a server fact.
      setOfflineMessage(t("attendance.offlineQueued"));
    } catch {
      setOfflineMessage(t("attendance.offlineFailed"));
    } finally {
      setOfflineBusy(false);
    }
  }, [offline, offlineNextAction, t]);

  const since = openEntry ? formatClockInTime(openEntry.clockIn, locale) : null;
  const busy = phase === "loading" || phase === "working";

  if (offlineMode) {
    const pending = localAttendance?.pending ?? 0;
    return (
      <div className="attendance-clock" data-mode="offline">
        <button
          type="button"
          className="button button--quiet"
          aria-label={
            offlineNextAction === "clock_out"
              ? t("attendance.clockOutAria")
              : t("attendance.clockInAria")
          }
          disabled={disabled || offlineBusy}
          onClick={() => void captureOffline()}
        >
          {offlineBusy
            ? t("attendance.offlineSaving")
            : offlineNextAction === "clock_out"
              ? t("attendance.clockOutOffline")
              : t("attendance.clockInOffline")}
        </button>
        {pending > 0 ? (
          <span className="attendance-clock__message" role="status">
            {t("attendance.offlinePending", { count: pending })}
          </span>
        ) : null}
        {offlineMessage ? (
          <span className="attendance-clock__message" role="status">
            {offlineMessage}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="attendance-clock">
      <button
        type="button"
        className={`button ${openEntry ? "button--quiet" : ""}`.trim()}
        aria-label={openEntry ? t("attendance.clockOutAria") : t("attendance.clockInAria")}
        disabled={disabled || busy || leaveBusy}
        onClick={() => void toggle()}
      >
        {phase === "loading"
          ? t("attendance.loading")
          : phase === "working"
            ? openEntry
              ? t("attendance.clockingOut")
              : t("attendance.clockingIn")
            : openEntry
              ? since
                ? t("attendance.clockOutSince", { since })
                : t("attendance.clockOut")
              : t("attendance.clockIn")}
      </button>
      {openEntry ? (
        <button
          type="button"
          className={`button ${onLeave ? "" : "button--quiet"}`.trim()}
          aria-label={onLeave ? t("attendance.endLeaveAria") : t("attendance.startLeaveAria")}
          disabled={disabled || busy || leaveBusy}
          onClick={() => void toggleLeave()}
        >
          {leaveBusy
            ? onLeave
              ? t("attendance.endingLeave")
              : t("attendance.startingLeave")
            : onLeave
              ? t("attendance.endLeave")
              : t("attendance.startLeave")}
        </button>
      ) : null}
      {message ? (
        <span className="attendance-clock__message" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}

// Renders the open-entry start time in the operator's local time, hour:minute. Falls back to null on an
// unparseable timestamp so the button simply omits the "since" hint rather than showing a broken value.
function formatClockInTime(iso: string, locale: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
