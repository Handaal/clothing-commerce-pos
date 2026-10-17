import type {
  AssignableStaffRole,
  AssignableStaffScope,
  EligibleIdentity,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useEffect, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { useModalA11y } from "../shell/useModalA11y";

// Admin flow for adding a staff account. Accounts (identities) are provisioned centrally; here the
// manager links an already-provisioned identity to this tenant by exact email, then optionally grants
// a role within an access scope. Mirrors the shifted-cafe staff onboarding, adapted to the identity
// model: the POS never creates the underlying login, only the tenant membership + role grant.
export function AddStaffModal({
  client,
  onClose,
  onCreated,
}: {
  client: TenantCommerceClient;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const [email, setEmail] = useState("");
  const [looking, setLooking] = useState(false);
  const [candidates, setCandidates] = useState<EligibleIdentity[] | null>(null);
  const [identityId, setIdentityId] = useState("");

  const [roles, setRoles] = useState<AssignableStaffRole[]>([]);
  const [scopes, setScopes] = useState<AssignableStaffScope[]>([]);
  const [roleId, setRoleId] = useState("");
  const [accessScopeId, setAccessScopeId] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The role + scope catalogs are the canonical, server-backed selection surfaces for a grant.
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.listAssignableStaffRoles({ limit: 100 }),
      client.listAssignableStaffScopes({ limit: 100 }),
    ])
      .then(([roleList, scopeList]) => {
        if (!active) return;
        setRoles(roleList.items);
        setScopes(scopeList.items);
      })
      .catch(() => {
        /* Role assignment is optional; a catalog read failure just hides the grant selectors. */
      });
    return () => {
      active = false;
    };
  }, [client]);

  async function find() {
    const trimmed = email.trim();
    if (trimmed === "") return;
    setLooking(true);
    setError(null);
    setCandidates(null);
    setIdentityId("");
    try {
      const response = await client.findEligibleStaffIdentitiesByEmail({ email: trimmed });
      setCandidates(response.items);
      if (response.items.length === 1) setIdentityId(response.items[0].identityId);
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLooking(false);
    }
  }

  async function submit() {
    if (identityId === "") return;
    setBusy(true);
    setError(null);
    try {
      const member = await client.createStaff({
        idempotencyKey: crypto.randomUUID(),
        identityId,
      });
      // Optional role grant in the same pass once the membership exists.
      if (roleId !== "" && accessScopeId !== "") {
        await client.assignStaffRole({
          idempotencyKey: crypto.randomUUID(),
          membershipId: member.membershipId,
          roleId,
          accessScopeId,
        });
      }
      onCreated(member.displayName ?? member.email ?? t("staff.member"));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  }

  const identityLabel = (identity: EligibleIdentity): string =>
    identity.displayName ?? identity.primaryEmail ?? identity.identityId;

  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <h3>{t("staff.add.title")}</h3>
        <div className="staff-modal__body">
          <p className="muted">{t("staff.add.hint")}</p>
          <div className="add-product-custom">
            <input
              type="email"
              inputMode="email"
              autoFocus
              placeholder={t("staff.add.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void find();
                }
              }}
            />
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void find()}
              disabled={looking || email.trim() === ""}
            >
              {looking ? t("staff.add.searching") : t("staff.add.find")}
            </button>
          </div>

          {candidates !== null && candidates.length === 0 ? (
            <p className="staff-empty">{t("staff.add.noMatch")}</p>
          ) : null}

          {candidates && candidates.length > 0 ? (
            <div className="staff-identity-list">
              {candidates.map((identity) => (
                <label className="staff-identity" key={identity.identityId}>
                  <input
                    type="radio"
                    name="identity"
                    checked={identityId === identity.identityId}
                    onChange={() => setIdentityId(identity.identityId)}
                  />
                  <span>
                    <strong>{identityLabel(identity)}</strong>
                    {identity.primaryEmail ? <small>{identity.primaryEmail}</small> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {identityId !== "" && roles.length > 0 && scopes.length > 0 ? (
            <>
              <label className="field">
                {t("staff.add.role")}
                <Select
                  ariaLabel={t("staff.add.role")}
                  placeholder={t("staff.add.noRole")}
                  value={roleId}
                  onChange={setRoleId}
                  options={roles.map((r) => ({ value: r.roleId, label: r.roleName }))}
                />
              </label>
              <label className="field">
                {t("staff.add.scope")}
                <Select
                  ariaLabel={t("staff.add.scope")}
                  placeholder={t("staff.add.chooseScope")}
                  value={accessScopeId}
                  onChange={setAccessScopeId}
                  options={scopes.map((s) => ({ value: s.accessScopeId, label: s.scopeName }))}
                />
              </label>
              <p className="muted">{t("staff.add.roleOptional")}</p>
            </>
          ) : null}

          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button
            className="button"
            onClick={() => void submit()}
            disabled={busy || identityId === ""}
          >
            {busy ? t("staff.add.adding") : t("staff.add.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
