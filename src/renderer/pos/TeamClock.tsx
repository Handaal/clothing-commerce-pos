import type { AttendanceEntry, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";
import type { AttendanceOfflineBridge } from "./AttendanceClock";
import { classifyCommerceError } from "../commerce/errors";
import { useI18n } from "../shell/i18n";
import { useModalA11y } from "../shell/useModalA11y";

type Member = {
  membershipId: string;
  displayName: string | null;
  email: string | null;
  open: boolean;
};
const rosterKey = (tenantId: string) => `zee:team-clock:${tenantId}`;
function cachedRoster(tenantId: string): Member[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(rosterKey(tenantId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is Member =>
        item !== null &&
        typeof item === "object" &&
        typeof item.membershipId === "string" &&
        typeof item.open === "boolean" &&
        (typeof item.displayName === "string" || item.displayName === null) &&
        (typeof item.email === "string" || item.email === null),
    );
  } catch {
    return [];
  }
}

export function TeamClock({
  client,
  tenantId,
  branchId,
  disabled,
  offline,
  networkOnline,
  offlineReady,
}: {
  client: TenantCommerceClient;
  tenantId: string;
  branchId: string | null;
  disabled: boolean;
  offline?: AttendanceOfflineBridge;
  networkOnline: boolean;
  offlineReady: boolean;
}) {
  const { t } = useI18n();
  const offlineMode = !networkOnline && offlineReady && Boolean(offline);
  const [open, setOpen] = useState(false);
  const [staff, setStaff] = useState<Member[]>(() => cachedRoster(tenantId));
  const [openEntries, setOpenEntries] = useState<ReadonlyMap<string, AttendanceEntry>>(new Map());
  const [offlineOpen, setOfflineOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalA11y<HTMLDivElement>(() => setOpen(false));

  const refreshOffline = useCallback(async () => {
    if (!offline) return;
    const people = cachedRoster(tenantId);
    const states = await Promise.all(
      people.map((person) => offline.getLocalAttendance(person.membershipId)),
    );
    setStaff(people);
    setOfflineOpen(
      new Map(
        people.map((person, index) => [
          person.membershipId,
          states[index].lastEvent ? states[index].lastEvent.eventType === "clock_in" : person.open,
        ]),
      ),
    );
    setError(people.length ? null : t("attendance.teamOfflineRoster"));
  }, [offline, tenantId, t]);

  const refreshConnected = useCallback(async () => {
    setError(null);
    try {
      const people: Member[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listStaff({ status: "active", limit: 100, cursor });
        people.push(
          ...page.items.map((person) => ({
            membershipId: person.membershipId,
            displayName: person.displayName,
            email: person.email,
            open: false,
          })),
        );
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      const current = new Map<string, AttendanceEntry>();
      for (let index = 0; index < people.length; index += 5) {
        const batch = people.slice(index, index + 5);
        const responses = await Promise.all(
          batch.map((person) =>
            client.listAttendance({ membershipId: person.membershipId, limit: 1 }),
          ),
        );
        responses.forEach((response, offset) => {
          const entry = response.items[0];
          if (entry?.clockOut === null) current.set(batch[offset].membershipId, entry);
        });
      }
      const snapshot = people.map((person) => ({
        ...person,
        open: current.has(person.membershipId),
      }));
      localStorage.setItem(rosterKey(tenantId), JSON.stringify(snapshot));
      setStaff(snapshot);
      setOpenEntries(current);
    } catch (caught) {
      setError(classifyCommerceError(caught).message);
    }
  }, [client, tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load the external team roster on connection changes
    if (networkOnline) void refreshConnected();
    else if (offlineMode) void refreshOffline();
  }, [networkOnline, offlineMode, refreshConnected, refreshOffline]);

  async function toggle(person: Member) {
    setBusy(person.membershipId);
    setError(null);
    try {
      if (offlineMode && offline) {
        await offline.recordAttendanceEvent({
          membershipId: person.membershipId,
          eventType: offlineOpen.get(person.membershipId) ? "clock_out" : "clock_in",
        });
        await refreshOffline();
      } else {
        const entry = openEntries.get(person.membershipId);
        if (entry)
          await client.updateAttendanceEntry({
            entryId: entry.id,
            clockIn: entry.clockIn,
            clockOut: new Date().toISOString(),
          });
        else
          await client.addAttendanceEntry({
            membershipId: person.membershipId,
            branchId,
            clockIn: new Date().toISOString(),
            clockOut: null,
          });
        await refreshConnected();
      }
    } catch (caught) {
      setError(classifyCommerceError(caught).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        className="button button--quiet"
        disabled={disabled || (!networkOnline && !offlineReady)}
        onClick={() => {
          setOpen(true);
          void (offlineMode ? refreshOffline() : refreshConnected());
        }}
      >
        {t("attendance.teamClock")}
      </button>
      {open ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("attendance.teamClock")}
          onClick={() => setOpen(false)}
        >
          <div
            className="modal-card team-clock-modal"
            ref={dialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="variant-dialog__head">
              <h3>{t("attendance.teamClock")}</h3>
              <button className="button button--quiet" onClick={() => setOpen(false)}>
                {t("cashier.closeVariants")}
              </button>
            </div>
            {offlineMode ? <p className="muted">{t("attendance.offlineQueued")}</p> : null}
            {error ? (
              <p className="notice notice--error" role="alert">
                {error}
              </p>
            ) : null}
            {staff.map((person) => {
              const clockedIn = offlineMode
                ? offlineOpen.get(person.membershipId)
                : openEntries.has(person.membershipId);
              return (
                <div className="held-cart-row" key={person.membershipId}>
                  <div>
                    <strong>{person.displayName ?? person.email ?? person.membershipId}</strong>
                    <span>{clockedIn ? t("staff.in") : t("staff.out")}</span>
                  </div>
                  <button
                    className="button"
                    disabled={busy !== null || (!networkOnline && !offlineMode)}
                    onClick={() => void toggle(person)}
                  >
                    {clockedIn ? t("attendance.clockOutAria") : t("attendance.clockInAria")}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}
