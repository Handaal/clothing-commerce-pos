import { useCallback, useEffect, useState } from "react";

import type {
  AssignableStaffRole,
  AssignableStaffScope,
  PosLoginSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { ApiHttpError } from "@shifted/clothing-commerce-sdk";

import type { PosAuthBridge, PosRole, PosUser } from "../../shared/pos-auth";
import { POS_PIN_MAX_LENGTH, POS_PIN_MIN_LENGTH } from "../../shared/pos-auth";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SECTIONS } from "../shell/sections";

// Admin-only management of the server-backed POS-native (pos_pin) accounts (the shifted-cafe "Users"
// page, now repointed at the API). Create / edit role + section grants / reset PINs / deactivate all go
// through the SDK; the device-local `pos_users` table is kept only as a display cache for the pre-auth
// floor roster picker, mirrored here after every read/write. This screen never sees a stored PIN.
const GRANTABLE_SECTIONS = SECTIONS.filter((section) => section.id !== "pos");

const PIN_PATTERN = new RegExp(`^[0-9]{${POS_PIN_MIN_LENGTH},${POS_PIN_MAX_LENGTH}}$`);

interface DraftState {
  id: string | null;
  name: string;
  username: string;
  role: PosRole;
  pin: string;
  permissions: string[];
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: "",
  username: "",
  role: "cashier",
  pin: "",
  permissions: [],
};

function newKey(): string {
  return crypto.randomUUID();
}

// Simplified auto-map: the owner never deals with the server RBAC model. A new pos_pin account is bound to
// the first role that grants any POS permission (else the first assignable role), scoped tenant-wide where
// a tenant-mode scope exists (else the first scope). The POS role + section grants shape the sidebar.
function pickRole(roles: readonly AssignableStaffRole[]): AssignableStaffRole | null {
  return (
    roles.find((role) => role.permissionKeys.some((key) => key.startsWith("pos."))) ??
    roles[0] ??
    null
  );
}

function pickScope(scopes: readonly AssignableStaffScope[]): AssignableStaffScope | null {
  return scopes.find((scope) => scope.scopeMode === "tenant") ?? scopes[0] ?? null;
}

export function PosUsersManager({
  client,
  rosterBridge,
  operator,
}: {
  client: TenantCommerceClient;
  rosterBridge?: PosAuthBridge;
  operator: PosUser | null;
}) {
  const { t } = useI18n();
  const [users, setUsers] = useState<readonly PosLoginSummary[]>([]);
  const [role, setRole] = useState<AssignableStaffRole | null>(null);
  const [scope, setScope] = useState<AssignableStaffScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the device-local display cache in step with the server so the pre-auth floor picker (which has no
  // session to query the server with) stays populated. Best-effort: a cache failure never blocks the desk.
  const mirror = useCallback(
    (list: readonly PosLoginSummary[]) => {
      void rosterBridge
        ?.replaceRosterCache(
          list.map((item) => ({
            username: item.username,
            name: item.displayName ?? item.username,
            role: item.posRole,
            active: item.status === "active",
          })),
        )
        .catch(() => undefined);
    },
    [rosterBridge],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [logins, roles, scopes] = await Promise.all([
        client.listPosLogins(),
        client.listAssignableStaffRoles(),
        client.listAssignableStaffScopes(),
      ]);
      setUsers(logins.items);
      setRole(pickRole(roles.items));
      setScope(pickScope(scopes.items));
      setError(null);
      mirror(logins.items);
    } catch {
      setError(t("posUsers.loadError"));
    } finally {
      setLoading(false);
    }
  }, [client, mirror, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial external read (server list)
    void refresh();
  }, [refresh]);

  const mapError = useCallback(
    (caught: unknown): string => {
      if (caught instanceof ApiHttpError) {
        if (caught.code === "USERNAME_TAKEN" || caught.status === 409)
          return t("login.usernameTaken");
        if (caught.status === 400) return t("posUsers.invalidPin");
        if (caught.status === 403) return t("posUsers.lastAdmin");
      }
      return t("posUsers.saveError");
    },
    [t],
  );

  // Provision the same PIN for offline unlock so one PIN works online and offline. Best-effort: if the
  // tenant's offline key is still dormant (no KEK configured yet) the server has nowhere to wrap the PIN,
  // so swallow that one case and leave a non-blocking note. Any other failure is a real error — rethrow it
  // to the caller's catch so it surfaces like a failed save.
  const provisionOfflinePin = useCallback(
    async (membershipId: string, pin: string) => {
      try {
        await client.setStaffOfflinePin({ idempotencyKey: newKey(), membershipId, pin });
      } catch (caught) {
        if (
          caught instanceof ApiHttpError &&
          (caught.code === "OFFLINE_PIN_NOT_CONFIGURED" || caught.status === 503)
        ) {
          setNote(t("posUsers.offlinePinDeferred"));
          return;
        }
        throw caught;
      }
    },
    [client, t],
  );

  const save = useCallback(async () => {
    if (!draft || busy) return;
    const isNew = draft.id === null;
    if (draft.name.trim() === "" || (isNew && draft.username.trim() === "")) return;
    if (isNew && !PIN_PATTERN.test(draft.pin)) {
      setError(t("posUsers.invalidPin"));
      return;
    }
    if (isNew && (!role || !scope)) {
      setError(t("posUsers.saveError"));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const posPermissions = draft.role === "cashier" ? draft.permissions : [];
      if (isNew) {
        const created = await client.createPosLogin({
          idempotencyKey: newKey(),
          username: draft.username.trim(),
          pin: draft.pin,
          displayName: draft.name.trim(),
          roleId: role!.roleId,
          accessScopeId: scope!.accessScopeId,
          posRole: draft.role,
          posPermissions,
        });
        await provisionOfflinePin(created.membershipId, draft.pin);
      } else {
        await client.updatePosLogin({
          idempotencyKey: newKey(),
          membershipId: draft.id!,
          displayName: draft.name.trim(),
          posRole: draft.role,
          posPermissions,
        });
        if (draft.pin !== "") {
          if (!PIN_PATTERN.test(draft.pin)) {
            setError(t("posUsers.invalidPin"));
            setBusy(false);
            return;
          }
          await client.setPosLoginPin({
            idempotencyKey: newKey(),
            membershipId: draft.id!,
            pin: draft.pin,
          });
          await provisionOfflinePin(draft.id!, draft.pin);
        }
      }
      setDraft(null);
      await refresh();
    } catch (caught) {
      setError(mapError(caught));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, client, role, scope, refresh, mapError, provisionOfflinePin, t]);

  const toggleActive = useCallback(
    async (user: PosLoginSummary) => {
      setBusy(true);
      setError(null);
      try {
        await client.updateStaffStatus({
          idempotencyKey: newKey(),
          membershipId: user.membershipId,
          status: user.status === "active" ? "deactivated" : "active",
        });
        await refresh();
      } catch (caught) {
        setError(mapError(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, mapError],
  );

  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("posUsers.title")}</h2>
        <button
          className="button button--quiet"
          disabled={busy}
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
        >
          {t("posUsers.add")}
        </button>
      </div>

      {error ? (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {note ? (
        <div className="notice notice--warning" role="status">
          {note}
        </div>
      ) : null}

      {draft ? (
        <UserDraftForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setError(null);
            setNote(null);
          }}
          onSave={() => void save()}
        />
      ) : null}

      {loading ? (
        <p className="inline-state">{t("posUsers.loading")}</p>
      ) : (
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>{t("posUsers.colName")}</th>
                <th>{t("login.username")}</th>
                <th>{t("posUsers.colRole")}</th>
                <th>{t("posUsers.colStatus")}</th>
                <th className="end">{t("posUsers.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const active = user.status === "active";
                return (
                  <tr key={user.membershipId}>
                    <td>
                      <strong>{user.displayName ?? user.username}</strong>
                    </td>
                    <td className="muted">{user.username}</td>
                    <td>
                      <span className={`pill ${user.posRole === "admin" ? "pill--good" : ""}`}>
                        {t(`login.role.${user.posRole}`)}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${active ? "pill--good" : "pill--bad"}`}>
                        {active ? t("posUsers.active") : t("posUsers.inactive")}
                      </span>
                    </td>
                    <td className="end">
                      <button
                        className="button button--quiet"
                        disabled={busy}
                        onClick={() =>
                          setDraft({
                            id: user.membershipId,
                            name: user.displayName ?? "",
                            username: user.username,
                            role: user.posRole,
                            pin: "",
                            permissions: [...user.posPermissions],
                          })
                        }
                      >
                        {t("posUsers.edit")}
                      </button>
                      <button
                        className="button button--quiet"
                        disabled={busy || user.membershipId === operator?.id}
                        onClick={() => void toggleActive(user)}
                      >
                        {active ? t("posUsers.deactivate") : t("posUsers.activate")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UserDraftForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: DraftState;
  busy: boolean;
  onChange: (draft: DraftState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const isNew = draft.id === null;
  return (
    <form
      className="pos-users-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="suppliers-field-row">
        <label className="field">
          {t("posUsers.colName")}
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field">
          {t("login.username")}
          <input
            value={draft.username}
            disabled={!isNew}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onChange({ ...draft, username: e.target.value })}
          />
        </label>
      </div>
      <div className="suppliers-field-row">
        <label className="field">
          {t("posUsers.colRole")}
          <Select<PosRole>
            ariaLabel={t("posUsers.colRole")}
            value={draft.role}
            onChange={(role) => onChange({ ...draft, role })}
            options={[
              { value: "cashier", label: t("login.role.cashier") },
              { value: "admin", label: t("login.role.admin") },
            ]}
          />
        </label>
        <label className="field">
          {isNew ? t("login.pin") : t("posUsers.newPinOptional")}
          <input
            inputMode="numeric"
            autoComplete="off"
            value={draft.pin}
            placeholder={t("login.pinRule")}
            onChange={(e) => onChange({ ...draft, pin: e.target.value.replace(/[^0-9]/g, "") })}
          />
        </label>
      </div>
      {draft.role === "cashier" ? (
        <fieldset className="pos-users-perms">
          <legend>{t("posUsers.sectionsAllowed")}</legend>
          {GRANTABLE_SECTIONS.map((section) => {
            const checked = draft.permissions.includes(section.id);
            return (
              <label key={section.id} className="pos-users-perm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    onChange({
                      ...draft,
                      permissions: e.target.checked
                        ? [...draft.permissions, section.id]
                        : draft.permissions.filter((id) => id !== section.id),
                    })
                  }
                />
                {t(section.labelKey)}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <div className="button-row">
        <button type="submit" className="button button--complete" disabled={busy}>
          {isNew ? t("posUsers.create") : t("posUsers.save")}
        </button>
        <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
