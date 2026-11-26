import { useState } from "react";
import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import type { PosAuthBridge, PosUser } from "../../shared/pos-auth";
import { useI18n } from "../shell/i18n";
import { PosUsersManager } from "../settings/PosUsersManager";
import { StaffAttendance } from "./StaffAttendance";

export function StaffWorkspace({
  client,
  currency,
  branchId,
  rosterBridge,
  operator,
}: {
  client: TenantCommerceClient;
  currency: string;
  branchId: string | null;
  rosterBridge?: PosAuthBridge;
  operator: PosUser | null;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"attendance" | "accounts">("attendance");
  return (
    <>
      <div className="desk-preamble">
        <nav className="report-tabs" aria-label={t("nav.staff")}>
          <button
            className={`report-tab${tab === "attendance" ? " report-tab--active" : ""}`}
            onClick={() => setTab("attendance")}
          >
            {t("staff.workspace.attendance")}
          </button>
          <button
            className={`report-tab${tab === "accounts" ? " report-tab--active" : ""}`}
            onClick={() => setTab("accounts")}
          >
            {t("staff.workspace.accounts")}
          </button>
        </nav>
      </div>
      {tab === "attendance" ? (
        <StaffAttendance client={client} currency={currency} branchId={branchId} />
      ) : (
        <main className="staff-shell">
          <PosUsersManager client={client} rosterBridge={rosterBridge} operator={operator} />
        </main>
      )}
    </>
  );
}
