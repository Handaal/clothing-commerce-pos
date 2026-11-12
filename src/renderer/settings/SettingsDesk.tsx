import type {
  Branch,
  BusinessSettings,
  Register,
  ReturnSettings,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { currencySymbol, minorToMajorInput, parseMajorToMinor } from "../money";
import { useI18n } from "../shell/i18n";
import { PALETTE_LIST } from "../shell/palettes";
import { Select } from "../shell/Select";
import { SkeletonLines, SkeletonTable } from "../shell/Skeleton";
import { useTheme } from "../shell/theme";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";
import { PosUsersManager } from "./PosUsersManager";
import type { PosAuthBridge, PosUser } from "../../shared/pos-auth";

type Tab = "business" | "branches" | "registers" | "returns" | "appearance" | "team";

const TABS: readonly { id: Tab; labelKey: string }[] = [
  { id: "business", labelKey: "settings.tab.business" },
  { id: "branches", labelKey: "settings.tab.branches" },
  { id: "registers", labelKey: "settings.tab.registers" },
  { id: "returns", labelKey: "settings.tab.returns" },
  { id: "appearance", labelKey: "settings.tab.appearance" },
];

type LifecycleStatus = Branch["status"];

export function SettingsDesk({
  client,
  currency,
  posAuthBridge,
  operator,
}: {
  client: TenantCommerceClient;
  currency: string;
  posAuthBridge?: PosAuthBridge;
  operator?: PosUser | null;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("business");
  // The team tab (server-backed pos_pin account management) is only meaningful for an admin operator. The
  // device-local posAuth bridge is optional here — used only to mirror the roster display cache.
  const showTeam = operator?.role === "admin";
  const tabs = showTeam ? [...TABS, { id: "team" as Tab, labelKey: "posUsers.tab" }] : TABS;
  const activeTab = tab === "team" && !showTeam ? "business" : tab;

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("settings.configuration")}</p>
          <h1>{t("nav.settings")}</h1>
        </div>
      </header>

      <nav className="report-tabs" aria-label={t("settings.area")}>
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`report-tab${activeTab === item.id ? " report-tab--active" : ""}`}
            aria-pressed={activeTab === item.id}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      {activeTab === "business" ? (
        <BusinessTab client={client} />
      ) : activeTab === "branches" ? (
        <BranchesTab client={client} />
      ) : activeTab === "registers" ? (
        <RegistersTab client={client} />
      ) : activeTab === "returns" ? (
        <ReturnsTab client={client} currency={currency} />
      ) : activeTab === "team" ? (
        <PosUsersManager client={client} rosterBridge={posAuthBridge} operator={operator ?? null} />
      ) : (
        <AppearanceTab />
      )}
    </main>
  );
}

// ─── Business identity ────────────────────────────────────────────────────────

// The editable subset of `BusinessSettings`. Nullable fields are held as strings in the form and
// normalized back to `null` when blank on save; the server owns slug, status, locale, and timestamps.
interface BusinessDraft {
  displayName: string;
  legalName: string;
  contactEmail: string;
  contactPhone: string;
  taxIdentifier: string;
  defaultTimezone: string;
  countryCode: string;
  defaultCurrency: string;
}

function toBusinessDraft(settings: BusinessSettings): BusinessDraft {
  return {
    displayName: settings.displayName,
    legalName: settings.legalName ?? "",
    contactEmail: settings.contactEmail ?? "",
    contactPhone: settings.contactPhone ?? "",
    taxIdentifier: settings.taxIdentifier ?? "",
    defaultTimezone: settings.defaultTimezone,
    countryCode: settings.countryCode ?? "",
    defaultCurrency: settings.defaultCurrency,
  };
}

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

function BusinessTab({ client }: { client: TenantCommerceClient }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [draft, setDraft] = useState<BusinessDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getBusinessSettings();
      setSettings(result);
      setDraft(toBusinessDraft(result));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const update = (patch: Partial<BusinessDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const dirty =
    settings !== null &&
    draft !== null &&
    JSON.stringify(draft) !== JSON.stringify(toBusinessDraft(settings));

  const save = async () => {
    if (!draft) return;
    if (draft.displayName.trim() === "") {
      toast.error(t("settings.err.bizName"));
      return;
    }
    if (draft.defaultCurrency.trim().length !== 3) {
      toast.error(t("settings.err.defaultCurrency"));
      return;
    }
    setBusy(true);
    try {
      // The request schema is strict; send the full editable set so a cleared optional becomes null.
      const result = await client.updateBusinessSettings({
        idempotencyKey: crypto.randomUUID(),
        displayName: draft.displayName.trim(),
        legalName: blankToNull(draft.legalName),
        contactEmail: blankToNull(draft.contactEmail),
        contactPhone: blankToNull(draft.contactPhone),
        taxIdentifier: blankToNull(draft.taxIdentifier),
        defaultTimezone: draft.defaultTimezone.trim(),
        countryCode: blankToNull(draft.countryCode),
        defaultCurrency: draft.defaultCurrency.trim().toUpperCase(),
      });
      setSettings(result);
      setDraft(toBusinessDraft(result));
      toast.success(t("settings.ok.bizSaved"));
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonLines lines={6} label={t("settings.loadingBiz")} />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!settings || !draft) return null;

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("settings.identity")}</h2>
        </div>
        <div className="settings-grid">
          <label className="field">
            {t("settings.displayName")}
            <input
              value={draft.displayName}
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.legalName")}
            <input
              value={draft.legalName}
              onChange={(event) => update({ legalName: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.taxIdentifier")}
            <input
              value={draft.taxIdentifier}
              onChange={(event) => update({ taxIdentifier: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.contactEmail")}
            <input
              type="email"
              value={draft.contactEmail}
              onChange={(event) => update({ contactEmail: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.contactPhone")}
            <input
              value={draft.contactPhone}
              onChange={(event) => update({ contactPhone: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.countryCode")}
            <input
              value={draft.countryCode}
              placeholder="EG"
              onChange={(event) => update({ countryCode: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.defaultTimezone")}
            <input
              value={draft.defaultTimezone}
              placeholder="Africa/Cairo"
              onChange={(event) => update({ defaultTimezone: event.target.value })}
            />
          </label>
          <label className="field">
            {t("settings.defaultCurrency")}
            <input
              value={draft.defaultCurrency}
              maxLength={3}
              placeholder="EGP"
              onChange={(event) => update({ defaultCurrency: event.target.value.toUpperCase() })}
            />
          </label>
        </div>
        <div className="staff-modal__actions">
          <button
            className="button button--quiet"
            disabled={!dirty || busy}
            onClick={() => setDraft(toBusinessDraft(settings))}
          >
            {t("settings.discard")}
          </button>
          <button className="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? t("settings.saving") : t("settings.saveChanges")}
          </button>
        </div>
      </section>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("settings.account")}</h2>
        </div>
        <div className="staff-stats">
          <div className="staff-stat">
            <span>{t("settings.slug")}</span>
            <strong>{settings.slug}</strong>
          </div>
          <div className="staff-stat">
            <span>{t("orders.statusLabel")}</span>
            <strong>{settings.status}</strong>
          </div>
          <div className="staff-stat">
            <span>{t("settings.onboarding")}</span>
            <strong>{settings.onboardingState}</strong>
          </div>
          <div className="staff-stat">
            <span>{t("settings.defaultLocale")}</span>
            <strong>{settings.defaultLocale}</strong>
          </div>
        </div>
        <p className="staff-empty">{t("settings.platformManaged")}</p>
      </section>
    </>
  );
}

// ─── Returns & refunds ──────────────────────────────────────────────────────

interface ReturnsDraft {
  enabled: boolean;
  windowDays: string;
  manualRefundsEnabled: boolean;
  maxManualRefund: string;
  allowedReasons: string;
}

function toReturnsDraft(settings: ReturnSettings): ReturnsDraft {
  return {
    enabled: settings.enabled,
    windowDays: settings.windowDays === null ? "" : String(settings.windowDays),
    manualRefundsEnabled: settings.manualRefundsEnabled,
    maxManualRefund:
      settings.maxManualRefundMinor === null
        ? ""
        : minorToMajorInput(settings.maxManualRefundMinor),
    allowedReasons: settings.allowedReasons.join(", "),
  };
}

function ReturnsTab({ client, currency }: { client: TenantCommerceClient; currency: string }) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<ReturnSettings | null>(null);
  const [draft, setDraft] = useState<ReturnsDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getReturnSettings();
      setSettings(result);
      setDraft(toReturnsDraft(result));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const update = (patch: Partial<ReturnsDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const dirty =
    settings !== null &&
    draft !== null &&
    JSON.stringify(draft) !== JSON.stringify(toReturnsDraft(settings));

  const save = async () => {
    if (!draft) return;
    // Window is an optional positive whole number of days; blank clears it (no time limit).
    let windowDays: number | null = null;
    if (draft.windowDays.trim() !== "") {
      const parsed = Number(draft.windowDays);
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast.error(t("settings.err.window"));
        return;
      }
      windowDays = parsed;
    }
    // Manual refund cap is entered in major currency units; blank clears it (no cap).
    let maxManualRefundMinor: number | null = null;
    if (draft.maxManualRefund.trim() !== "") {
      const parsed = parseMajorToMinor(draft.maxManualRefund);
      if (parsed === null) {
        toast.error(t("settings.err.refundCap"));
        return;
      }
      maxManualRefundMinor = parsed;
    }
    const allowedReasons = draft.allowedReasons
      .split(",")
      .map((reason) => reason.trim())
      .filter((reason) => reason !== "");

    setBusy(true);
    try {
      const result = await client.updateReturnSettings({
        idempotencyKey: crypto.randomUUID(),
        enabled: draft.enabled,
        windowDays,
        manualRefundsEnabled: draft.manualRefundsEnabled,
        maxManualRefundMinor,
        allowedReasons,
      });
      setSettings(result);
      setDraft(toReturnsDraft(result));
      toast.success(t("settings.ok.returnsSaved"));
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonLines lines={5} label={t("settings.loadingReturns")} />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!settings || !draft) return null;

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("settings.returnPolicy")}</h2>
        </div>
        <div className="settings-grid">
          <label className="field settings-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {t("settings.allowReturns")}
          </label>
          <label className="field">
            {t("settings.returnWindow")}
            <input
              inputMode="numeric"
              value={draft.windowDays}
              placeholder={t("settings.noLimit")}
              disabled={!draft.enabled}
              onChange={(event) => update({ windowDays: event.target.value })}
            />
          </label>
          <label className="field settings-check">
            <input
              type="checkbox"
              checked={draft.manualRefundsEnabled}
              onChange={(event) => update({ manualRefundsEnabled: event.target.checked })}
            />
            {t("settings.allowManualRefunds")}
          </label>
          <label className="field">
            {t("settings.manualRefundCap", { sym: currencySymbol(currency, locale) })}
            <input
              inputMode="decimal"
              value={draft.maxManualRefund}
              placeholder={t("settings.noCap")}
              disabled={!draft.manualRefundsEnabled}
              onChange={(event) => update({ maxManualRefund: event.target.value })}
            />
          </label>
          <label className="field settings-grid__wide">
            {t("settings.allowedReasons")}
            <input
              value={draft.allowedReasons}
              placeholder={t("settings.reasonsPlaceholder")}
              onChange={(event) => update({ allowedReasons: event.target.value })}
            />
          </label>
        </div>
        <div className="staff-modal__actions">
          <button
            className="button button--quiet"
            disabled={!dirty || busy}
            onClick={() => setDraft(toReturnsDraft(settings))}
          >
            {t("settings.discard")}
          </button>
          <button className="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? t("settings.saving") : t("settings.saveChanges")}
          </button>
        </div>
      </section>
    </>
  );
}

// ─── Branches ───────────────────────────────────────────────────────────────

// The editable subset of a `Branch`. Nullable string fields are held as "" in the form and
// normalized back to null on save; `code` and the generated identity/timestamps stay read-only.
interface BranchDraft {
  displayName: string;
  timezone: string;
  status: LifecycleStatus;
  isFulfillmentEnabled: boolean;
  isClickAndCollectEnabled: boolean;
  receiptFooter: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  contactEmail: string;
  contactPhone: string;
}

function toBranchDraft(branch: Branch): BranchDraft {
  return {
    displayName: branch.displayName,
    timezone: branch.timezone,
    status: branch.status,
    isFulfillmentEnabled: branch.isFulfillmentEnabled,
    isClickAndCollectEnabled: branch.isClickAndCollectEnabled,
    receiptFooter: branch.receiptFooter ?? "",
    addressLine1: branch.addressLine1 ?? "",
    addressLine2: branch.addressLine2 ?? "",
    city: branch.city ?? "",
    region: branch.region ?? "",
    postalCode: branch.postalCode ?? "",
    countryCode: branch.countryCode ?? "",
    contactEmail: branch.contactEmail ?? "",
    contactPhone: branch.contactPhone ?? "",
  };
}

function BranchesTab({ client }: { client: TenantCommerceClient }) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [draft, setDraft] = useState<BranchDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // All lifecycle states are listed so an inactive/archived branch can be re-activated here.
      const response = await client.listBranches({ limit: 100 });
      setBranches(response.items);
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const open = (branch: Branch) => {
    setEditing(branch);
    setDraft(toBranchDraft(branch));
  };

  const update = (patch: Partial<BranchDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!editing || !draft) return;
    if (draft.displayName.trim() === "") {
      toast.error(t("settings.err.branchName"));
      return;
    }
    setBusy(true);
    try {
      await client.updateBranch({
        idempotencyKey: crypto.randomUUID(),
        branchId: editing.id,
        displayName: draft.displayName.trim(),
        timezone: draft.timezone.trim(),
        status: draft.status,
        isFulfillmentEnabled: draft.isFulfillmentEnabled,
        isClickAndCollectEnabled: draft.isClickAndCollectEnabled,
        receiptFooter: blankToNull(draft.receiptFooter),
        addressLine1: blankToNull(draft.addressLine1),
        addressLine2: blankToNull(draft.addressLine2),
        city: blankToNull(draft.city),
        region: blankToNull(draft.region),
        postalCode: blankToNull(draft.postalCode),
        countryCode: blankToNull(draft.countryCode),
        contactEmail: blankToNull(draft.contactEmail),
        contactPhone: blankToNull(draft.contactPhone),
      });
      setEditing(null);
      setDraft(null);
      toast.success(t("settings.ok.saved", { name: draft.displayName.trim() }));
      await load();
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonTable rows={4} cols={4} label={t("settings.loadingBranches")} />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("settings.tab.branches")}</h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>{t("settings.branch")}</th>
                <th>{t("orders.statusLabel")}</th>
                <th>{t("settings.fulfillment")}</th>
                <th className="end">{t("staff.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((branch) => (
                <tr key={branch.id}>
                  <td>
                    <strong>{branch.displayName}</strong>
                    <small>{t("settings.code", { code: branch.code })}</small>
                  </td>
                  <td>{branch.status}</td>
                  <td className="muted">
                    {branch.isFulfillmentEnabled ? t("settings.ships") : "—"}
                    {branch.isClickAndCollectEnabled ? ` · ${t("settings.clickCollect")}` : ""}
                  </td>
                  <td className="end">
                    <button className="link" disabled={busy} onClick={() => open(branch)}>
                      {t("staff.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {branches.length === 0 ? <p className="staff-empty">{t("settings.noBranches")}</p> : null}
      </section>

      {editing && draft ? (
        <Modal
          title={t("settings.editBranch", { code: editing.code })}
          onClose={() => {
            setEditing(null);
            setDraft(null);
          }}
          onSave={() => void save()}
          busy={busy}
        >
          <div className="settings-grid">
            <label className="field">
              {t("settings.displayName")}
              <input
                value={draft.displayName}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.timezone")}
              <input
                value={draft.timezone}
                placeholder="Africa/Cairo"
                onChange={(event) => update({ timezone: event.target.value })}
              />
            </label>
            <label className="field">
              {t("orders.statusLabel")}
              <Select<LifecycleStatus>
                ariaLabel={t("settings.branchStatus")}
                value={draft.status}
                onChange={(status) => update({ status })}
                options={[
                  { value: "active", label: t("suppliers.active") },
                  { value: "inactive", label: t("suppliers.inactive") },
                  { value: "archived", label: t("settings.archived") },
                ]}
              />
            </label>
            <label className="field settings-check">
              <input
                type="checkbox"
                checked={draft.isFulfillmentEnabled}
                onChange={(event) => update({ isFulfillmentEnabled: event.target.checked })}
              />
              {t("settings.fulfillmentEnabled")}
            </label>
            <label className="field settings-check">
              <input
                type="checkbox"
                checked={draft.isClickAndCollectEnabled}
                onChange={(event) => update({ isClickAndCollectEnabled: event.target.checked })}
              />
              {t("settings.clickCollect")}
            </label>
            <label className="field settings-grid__wide">
              {t("settings.receiptFooter")}
              <input
                value={draft.receiptFooter}
                onChange={(event) => update({ receiptFooter: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.addressLine1")}
              <input
                value={draft.addressLine1}
                onChange={(event) => update({ addressLine1: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.addressLine2")}
              <input
                value={draft.addressLine2}
                onChange={(event) => update({ addressLine2: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.city")}
              <input
                value={draft.city}
                onChange={(event) => update({ city: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.region")}
              <input
                value={draft.region}
                onChange={(event) => update({ region: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.postalCode")}
              <input
                value={draft.postalCode}
                onChange={(event) => update({ postalCode: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.countryCode")}
              <input
                value={draft.countryCode}
                placeholder="EG"
                onChange={(event) => update({ countryCode: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.contactEmail")}
              <input
                type="email"
                value={draft.contactEmail}
                onChange={(event) => update({ contactEmail: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.contactPhone")}
              <input
                value={draft.contactPhone}
                onChange={(event) => update({ contactPhone: event.target.value })}
              />
            </label>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ─── Registers ──────────────────────────────────────────────────────────────

interface RegisterDraft {
  displayName: string;
  sellingCurrency: string;
  status: LifecycleStatus;
}

function RegistersTab({ client }: { client: TenantCommerceClient }) {
  const { t } = useI18n();
  const [registers, setRegisters] = useState<readonly Register[]>([]);
  const [branchNames, setBranchNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Register | null>(null);
  const [draft, setDraft] = useState<RegisterDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Branches are loaded alongside registers only to label each row with its branch name.
      const [registerList, branchList] = await Promise.all([
        client.listRegisters({ limit: 100 }),
        client.listBranches({ limit: 100 }),
      ]);
      setRegisters(registerList.items);
      setBranchNames(new Map(branchList.items.map((branch) => [branch.id, branch.displayName])));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  const open = (register: Register) => {
    setEditing(register);
    setDraft({
      displayName: register.displayName,
      sellingCurrency: register.sellingCurrency,
      status: register.status,
    });
  };

  const update = (patch: Partial<RegisterDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!editing || !draft) return;
    if (draft.displayName.trim() === "") {
      toast.error(t("settings.err.registerName"));
      return;
    }
    if (draft.sellingCurrency.trim().length !== 3) {
      toast.error(t("settings.err.sellingCurrency"));
      return;
    }
    setBusy(true);
    try {
      await client.updateRegister({
        idempotencyKey: crypto.randomUUID(),
        registerId: editing.id,
        displayName: draft.displayName.trim(),
        sellingCurrency: draft.sellingCurrency.trim().toUpperCase(),
        status: draft.status,
      });
      setEditing(null);
      setDraft(null);
      toast.success(t("settings.ok.saved", { name: draft.displayName.trim() }));
      await load();
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonTable rows={4} cols={5} label={t("settings.loadingRegisters")} />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>{t("settings.tab.registers")}</h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>{t("settings.register")}</th>
                <th>{t("settings.branch")}</th>
                <th>{t("staff.col.currency")}</th>
                <th>{t("orders.statusLabel")}</th>
                <th className="end">{t("staff.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {registers.map((register) => (
                <tr key={register.id}>
                  <td>
                    <strong>{register.displayName}</strong>
                    <small>{t("settings.code", { code: register.code })}</small>
                  </td>
                  <td>{branchNames.get(register.branchId) ?? "—"}</td>
                  <td className="muted">{register.sellingCurrency}</td>
                  <td>{register.status}</td>
                  <td className="end">
                    <button className="link" disabled={busy} onClick={() => open(register)}>
                      {t("staff.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {registers.length === 0 ? <p className="staff-empty">{t("settings.noRegisters")}</p> : null}
      </section>

      {editing && draft ? (
        <Modal
          title={t("settings.editRegister", { code: editing.code })}
          onClose={() => {
            setEditing(null);
            setDraft(null);
          }}
          onSave={() => void save()}
          busy={busy}
        >
          <div className="settings-grid">
            <label className="field">
              {t("settings.displayName")}
              <input
                value={draft.displayName}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </label>
            <label className="field">
              {t("settings.sellingCurrency")}
              <input
                value={draft.sellingCurrency}
                maxLength={3}
                placeholder="EGP"
                onChange={(event) => update({ sellingCurrency: event.target.value.toUpperCase() })}
              />
            </label>
            <label className="field">
              {t("orders.statusLabel")}
              <Select<LifecycleStatus>
                ariaLabel={t("settings.registerStatus")}
                value={draft.status}
                onChange={(status) => update({ status })}
                options={[
                  { value: "active", label: t("suppliers.active") },
                  { value: "inactive", label: t("suppliers.inactive") },
                  { value: "archived", label: t("settings.archived") },
                ]}
              />
            </label>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

// Theme and language are device-local operator preferences (persisted in localStorage by their
// providers), not tenant configuration — so they apply immediately with no server round-trip.
function AppearanceTab() {
  const { theme, setTheme, palette, setPalette, scale, setScale } = useTheme();
  const { lang, setLang, t } = useI18n();

  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>{t("settings.tab.appearance")}</h2>
      </div>
      <div className="settings-grid">
        <label className="field">
          {t("settings.theme")}
          <Select<typeof theme>
            ariaLabel={t("settings.theme")}
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: t("settings.light") },
              { value: "dark", label: t("settings.dark") },
            ]}
          />
        </label>
        <label className="field">
          {t("settings.language")}
          <Select<typeof lang>
            ariaLabel={t("settings.language")}
            value={lang}
            onChange={setLang}
            options={[
              { value: "en", label: "English" },
              { value: "ar", label: "العربية" },
            ]}
          />
        </label>
        <label className="field">
          {t("settings.displaySize")}
          <Select<typeof scale>
            ariaLabel={t("settings.displaySize")}
            value={scale}
            onChange={setScale}
            options={[
              { value: "compact", label: t("settings.displayCompact") },
              { value: "normal", label: t("settings.displayNormal") },
              { value: "large", label: t("settings.displayLarge") },
            ]}
          />
        </label>
      </div>
      <p className="staff-empty settings-grid__wide">{t("settings.displaySizeHint")}</p>

      <div className="field settings-grid__wide" style={{ marginTop: "1rem" }}>
        <span>{t("settings.colorPalette")}</span>
        <div className="palette-picker" role="radiogroup" aria-label={t("settings.colorPalette")}>
          {PALETTE_LIST.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={palette === item.id}
              className={`palette-swatch${palette === item.id ? " palette-swatch--active" : ""}`}
              onClick={() => setPalette(item.id)}
            >
              <span className="palette-swatch__chips" aria-hidden="true">
                {item.swatches.map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
              </span>
              <span className="palette-swatch__name">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="staff-empty">{t("settings.prefsNote")}</p>
    </section>
  );
}

// ─── Shared edit modal ────────────────────────────────────────────────────────

function Modal({
  title,
  children,
  onClose,
  onSave,
  busy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="staff-modal settings-modal"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {busy ? t("settings.saving") : t("settings.saveChanges")}
          </button>
        </div>
      </div>
    </div>
  );
}
