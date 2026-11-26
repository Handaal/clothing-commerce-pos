import type { StaffSummary, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useState, type ReactNode } from "react";
import { classifyCommerceError } from "../commerce/errors";
import { useI18n } from "../shell/i18n";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

type ProfileEdit = {
  membershipId: string;
  displayName: string;
  position: string;
  phone: string;
  idempotencyKey: string;
};

function ProfileDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function StaffProfilesPanel({
  client,
  staff,
  onChanged,
}: {
  client: TenantCommerceClient;
  staff: StaffSummary[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [edit, setEdit] = useState<ProfileEdit | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!edit || !edit.displayName.trim()) return;
    setBusy(true);
    try {
      await client.updateStaffProfile({
        membershipId: edit.membershipId,
        idempotencyKey: edit.idempotencyKey,
        displayName: edit.displayName.trim(),
        position: edit.position.trim() || null,
        phone: edit.phone.trim() || null,
      });
      setEdit(null);
      onChanged();
      toast.success(t("staff.profile.saved"));
    } catch (error) {
      toast.error(classifyCommerceError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(member: StaffSummary) {
    if (
      !window.confirm(
        t("staff.profile.deactivateConfirm", { name: member.displayName ?? t("staff.member") }),
      )
    )
      return;
    setBusy(true);
    try {
      await client.updateStaffStatus({
        membershipId: member.membershipId,
        status: "deactivated",
        idempotencyKey: crypto.randomUUID(),
      });
      onChanged();
      toast.success(t("staff.profile.deactivated"));
    } catch (error) {
      toast.error(classifyCommerceError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("staff.profile.team")}</h2>
      </div>
      <div className="staff-table-wrap">
        <table className="staff-table">
          <thead>
            <tr>
              <th>{t("staff.col.employee")}</th>
              <th>{t("staff.profile.position")}</th>
              <th>{t("staff.profile.phone")}</th>
              <th>{t("staff.profile.access")}</th>
              <th className="end">{t("staff.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.membershipId}>
                <td>
                  <strong>{member.displayName ?? member.email ?? t("staff.member")}</strong>
                </td>
                <td>{member.position || "—"}</td>
                <td>{member.phone || "—"}</td>
                <td>
                  {member.roles.length > 0 || member.email
                    ? t("staff.profile.login")
                    : t("staff.add.withoutLogin")}
                </td>
                <td className="end">
                  <button
                    className="link"
                    disabled={busy || member.status === "deactivated"}
                    onClick={() =>
                      setEdit({
                        membershipId: member.membershipId,
                        displayName: member.displayName ?? "",
                        position: member.position ?? "",
                        phone: member.phone ?? "",
                        idempotencyKey: crypto.randomUUID(),
                      })
                    }
                  >
                    {t("staff.profile.edit")}
                  </button>
                  {member.status === "active" && member.roles.length === 0 && !member.email ? (
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => void deactivate(member)}
                    >
                      {t("posUsers.deactivate")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit ? (
        <ProfileDialog onClose={() => setEdit(null)}>
          <h3>{t("staff.profile.edit")}</h3>
          <div className="staff-modal__body">
            <label className="field">
              {t("staff.col.employee")}
              <input
                value={edit.displayName}
                maxLength={120}
                onChange={(event) =>
                  setEdit({
                    ...edit,
                    displayName: event.target.value,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              />
            </label>
            <label className="field">
              {t("staff.profile.position")}
              <input
                value={edit.position}
                maxLength={80}
                onChange={(event) =>
                  setEdit({
                    ...edit,
                    position: event.target.value,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              />
            </label>
            <label className="field">
              {t("staff.profile.phone")}
              <input
                value={edit.phone}
                maxLength={30}
                onChange={(event) =>
                  setEdit({
                    ...edit,
                    phone: event.target.value,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              />
            </label>
          </div>
          <div className="staff-modal__actions">
            <button className="button button--quiet" disabled={busy} onClick={() => setEdit(null)}>
              {t("pay.cancel")}
            </button>
            <button
              className="button"
              disabled={busy || !edit.displayName.trim()}
              onClick={() => void save()}
            >
              {t("common.save")}
            </button>
          </div>
        </ProfileDialog>
      ) : null}
    </section>
  );
}
