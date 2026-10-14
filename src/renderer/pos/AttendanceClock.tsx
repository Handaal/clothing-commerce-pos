import type { AttendanceEntry, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "loading" | "ready" | "working" | "error";

// The signed-in operator's own attendance toggle, rendered in the POS top bar. It reflects the
// server's authoritative open-entry state (one open entry at a time) and records the register's branch
// on clock-in. Reading and recording use the operator's own `attendance.record` grant — never anyone
// else's. All timing (worked duration, open/closed) is owned by the Commerce API; this is only a view.
export function AttendanceClock({
  client,
  branchId,
  disabled = false,
}: {
  client: TenantCommerceClient;
  branchId: string | null;
  disabled?: boolean;
}) {
  const [openEntry, setOpenEntry] = useState<AttendanceEntry | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  // Discards results from a client that has been swapped out (tenant/session change) mid-flight.
  const activeClient = useRef(client);

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
      setMessage("Attendance status is unavailable.");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async () => {
    setPhase("working");
    setMessage(null);
    try {
      const result = openEntry ? await client.clockOut() : await client.clockIn({ branchId });
      if (activeClient.current !== client) return;
      // Clock-out closes the entry (no longer open); clock-in opens a new one.
      setOpenEntry(result.entry.clockOut === null ? result.entry : null);
      setPhase("ready");
    } catch {
      if (activeClient.current !== client) return;
      // Re-sync from the server: the most common failure is a stale open/closed view (already clocked
      // in/out from another device), which a refresh resolves to the true state.
      setMessage(
        openEntry
          ? "Could not clock out. Refreshing status."
          : "Could not clock in. Refreshing status.",
      );
      void refresh();
    }
  }, [client, openEntry, branchId, refresh]);

  const since = openEntry ? formatClockInTime(openEntry.clockIn) : null;
  const busy = phase === "loading" || phase === "working";

  return (
    <div className="attendance-clock">
      <button
        type="button"
        className={`button ${openEntry ? "button--quiet" : ""}`.trim()}
        aria-label={openEntry ? "Clock out of your shift" : "Clock in to start your shift"}
        disabled={disabled || busy}
        onClick={() => void toggle()}
      >
        {phase === "loading"
          ? "Attendance…"
          : phase === "working"
            ? openEntry
              ? "Clocking out…"
              : "Clocking in…"
            : openEntry
              ? since
                ? `Clock out · since ${since}`
                : "Clock out"
              : "Clock in"}
      </button>
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
function formatClockInTime(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
