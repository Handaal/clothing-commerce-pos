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

type Tab = "business" | "branches" | "registers" | "returns" | "appearance";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "business", label: "Business" },
  { id: "branches", label: "Branches" },
  { id: "registers", label: "Registers" },
  { id: "returns", label: "Returns & refunds" },
  { id: "appearance", label: "Appearance" },
];

type LifecycleStatus = Branch["status"];

export function SettingsDesk({
  client,
  currency,
}: {
  client: TenantCommerceClient;
  currency: string;
}) {
  const [tab, setTab] = useState<Tab>("business");

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>Settings</h1>
        </div>
      </header>

      <nav className="report-tabs" aria-label="Settings area">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`report-tab${tab === item.id ? " report-tab--active" : ""}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "business" ? (
        <BusinessTab client={client} />
      ) : tab === "branches" ? (
        <BranchesTab client={client} />
      ) : tab === "registers" ? (
        <RegistersTab client={client} />
      ) : tab === "returns" ? (
        <ReturnsTab client={client} currency={currency} />
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
      toast.error("A business display name is required.");
      return;
    }
    if (draft.defaultCurrency.trim().length !== 3) {
      toast.error("Default currency must be a 3-letter code (e.g. EGP).");
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
      toast.success("Business settings saved.");
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonLines lines={6} label="Loading business settings" />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  if (!settings || !draft) return null;

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Identity</h2>
        </div>
        <div className="settings-grid">
          <label className="field">
            Display name
            <input
              value={draft.displayName}
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </label>
          <label className="field">
            Legal name
            <input
              value={draft.legalName}
              onChange={(event) => update({ legalName: event.target.value })}
            />
          </label>
          <label className="field">
            Tax identifier
            <input
              value={draft.taxIdentifier}
              onChange={(event) => update({ taxIdentifier: event.target.value })}
            />
          </label>
          <label className="field">
            Contact email
            <input
              type="email"
              value={draft.contactEmail}
              onChange={(event) => update({ contactEmail: event.target.value })}
            />
          </label>
          <label className="field">
            Contact phone
            <input
              value={draft.contactPhone}
              onChange={(event) => update({ contactPhone: event.target.value })}
            />
          </label>
          <label className="field">
            Country code
            <input
              value={draft.countryCode}
              placeholder="EG"
              onChange={(event) => update({ countryCode: event.target.value })}
            />
          </label>
          <label className="field">
            Default timezone
            <input
              value={draft.defaultTimezone}
              placeholder="Africa/Cairo"
              onChange={(event) => update({ defaultTimezone: event.target.value })}
            />
          </label>
          <label className="field">
            Default currency
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
            Discard
          </button>
          <button className="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Account</h2>
        </div>
        <div className="staff-stats">
          <div className="staff-stat">
            <span>Slug</span>
            <strong>{settings.slug}</strong>
          </div>
          <div className="staff-stat">
            <span>Status</span>
            <strong>{settings.status}</strong>
          </div>
          <div className="staff-stat">
            <span>Onboarding</span>
            <strong>{settings.onboardingState}</strong>
          </div>
          <div className="staff-stat">
            <span>Default locale</span>
            <strong>{settings.defaultLocale}</strong>
          </div>
        </div>
        <p className="staff-empty">
          Slug, status, onboarding, and locale are managed by the platform and cannot be edited
          here.
        </p>
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
        toast.error("Return window must be a whole number of days, or blank for no limit.");
        return;
      }
      windowDays = parsed;
    }
    // Manual refund cap is entered in major currency units; blank clears it (no cap).
    let maxManualRefundMinor: number | null = null;
    if (draft.maxManualRefund.trim() !== "") {
      const parsed = parseMajorToMinor(draft.maxManualRefund);
      if (parsed === null) {
        toast.error("Enter the refund cap as an amount like 500 or 500.00, or leave it blank.");
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
      toast.success("Return settings saved.");
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonLines lines={5} label="Loading return settings" />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  if (!settings || !draft) return null;

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Return policy</h2>
        </div>
        <div className="settings-grid">
          <label className="field settings-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            Allow returns
          </label>
          <label className="field">
            Return window (days)
            <input
              inputMode="numeric"
              value={draft.windowDays}
              placeholder="No limit"
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
            Allow manual refunds
          </label>
          <label className="field">
            Manual refund cap ({currencySymbol(currency)})
            <input
              inputMode="decimal"
              value={draft.maxManualRefund}
              placeholder="No cap"
              disabled={!draft.manualRefundsEnabled}
              onChange={(event) => update({ maxManualRefund: event.target.value })}
            />
          </label>
          <label className="field settings-grid__wide">
            Allowed return reasons (comma-separated)
            <input
              value={draft.allowedReasons}
              placeholder="Damaged, Wrong size, Changed mind"
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
            Discard
          </button>
          <button className="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
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
      toast.error("A branch display name is required.");
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
      toast.success(`Saved ${draft.displayName.trim()}.`);
      await load();
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonTable rows={4} cols={4} label="Loading branches" />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Branches</h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Branch</th>
                <th>Status</th>
                <th>Fulfillment</th>
                <th className="end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((branch) => (
                <tr key={branch.id}>
                  <td>
                    <strong>{branch.displayName}</strong>
                    <small>Code {branch.code}</small>
                  </td>
                  <td>{branch.status}</td>
                  <td className="muted">
                    {branch.isFulfillmentEnabled ? "Ships" : "—"}
                    {branch.isClickAndCollectEnabled ? " · Click & collect" : ""}
                  </td>
                  <td className="end">
                    <button className="link" disabled={busy} onClick={() => open(branch)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {branches.length === 0 ? <p className="staff-empty">No branches yet.</p> : null}
      </section>

      {editing && draft ? (
        <Modal
          title={`Edit branch · ${editing.code}`}
          onClose={() => {
            setEditing(null);
            setDraft(null);
          }}
          onSave={() => void save()}
          busy={busy}
        >
          <div className="settings-grid">
            <label className="field">
              Display name
              <input
                value={draft.displayName}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </label>
            <label className="field">
              Timezone
              <input
                value={draft.timezone}
                placeholder="Africa/Cairo"
                onChange={(event) => update({ timezone: event.target.value })}
              />
            </label>
            <label className="field">
              Status
              <Select<LifecycleStatus>
                ariaLabel="Branch status"
                value={draft.status}
                onChange={(status) => update({ status })}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                  { value: "archived", label: "Archived" },
                ]}
              />
            </label>
            <label className="field settings-check">
              <input
                type="checkbox"
                checked={draft.isFulfillmentEnabled}
                onChange={(event) => update({ isFulfillmentEnabled: event.target.checked })}
              />
              Fulfillment enabled
            </label>
            <label className="field settings-check">
              <input
                type="checkbox"
                checked={draft.isClickAndCollectEnabled}
                onChange={(event) => update({ isClickAndCollectEnabled: event.target.checked })}
              />
              Click & collect
            </label>
            <label className="field settings-grid__wide">
              Receipt footer
              <input
                value={draft.receiptFooter}
                onChange={(event) => update({ receiptFooter: event.target.value })}
              />
            </label>
            <label className="field">
              Address line 1
              <input
                value={draft.addressLine1}
                onChange={(event) => update({ addressLine1: event.target.value })}
              />
            </label>
            <label className="field">
              Address line 2
              <input
                value={draft.addressLine2}
                onChange={(event) => update({ addressLine2: event.target.value })}
              />
            </label>
            <label className="field">
              City
              <input
                value={draft.city}
                onChange={(event) => update({ city: event.target.value })}
              />
            </label>
            <label className="field">
              Region
              <input
                value={draft.region}
                onChange={(event) => update({ region: event.target.value })}
              />
            </label>
            <label className="field">
              Postal code
              <input
                value={draft.postalCode}
                onChange={(event) => update({ postalCode: event.target.value })}
              />
            </label>
            <label className="field">
              Country code
              <input
                value={draft.countryCode}
                placeholder="EG"
                onChange={(event) => update({ countryCode: event.target.value })}
              />
            </label>
            <label className="field">
              Contact email
              <input
                type="email"
                value={draft.contactEmail}
                onChange={(event) => update({ contactEmail: event.target.value })}
              />
            </label>
            <label className="field">
              Contact phone
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
      toast.error("A register display name is required.");
      return;
    }
    if (draft.sellingCurrency.trim().length !== 3) {
      toast.error("Selling currency must be a 3-letter code (e.g. EGP).");
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
      toast.success(`Saved ${draft.displayName.trim()}.`);
      await load();
    } catch (err) {
      toast.error(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonTable rows={4} cols={5} label="Loading registers" />;
  if (error)
    return (
      <div className="notice notice--error" role="alert">
        <span>{error}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );

  return (
    <>
      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Registers</h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Register</th>
                <th>Branch</th>
                <th>Currency</th>
                <th>Status</th>
                <th className="end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {registers.map((register) => (
                <tr key={register.id}>
                  <td>
                    <strong>{register.displayName}</strong>
                    <small>Code {register.code}</small>
                  </td>
                  <td>{branchNames.get(register.branchId) ?? "—"}</td>
                  <td className="muted">{register.sellingCurrency}</td>
                  <td>{register.status}</td>
                  <td className="end">
                    <button className="link" disabled={busy} onClick={() => open(register)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {registers.length === 0 ? <p className="staff-empty">No registers yet.</p> : null}
      </section>

      {editing && draft ? (
        <Modal
          title={`Edit register · ${editing.code}`}
          onClose={() => {
            setEditing(null);
            setDraft(null);
          }}
          onSave={() => void save()}
          busy={busy}
        >
          <div className="settings-grid">
            <label className="field">
              Display name
              <input
                value={draft.displayName}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </label>
            <label className="field">
              Selling currency
              <input
                value={draft.sellingCurrency}
                maxLength={3}
                placeholder="EGP"
                onChange={(event) => update({ sellingCurrency: event.target.value.toUpperCase() })}
              />
            </label>
            <label className="field">
              Status
              <Select<LifecycleStatus>
                ariaLabel="Register status"
                value={draft.status}
                onChange={(status) => update({ status })}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                  { value: "archived", label: "Archived" },
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
  const { theme, setTheme, palette, setPalette } = useTheme();
  const { lang, setLang } = useI18n();

  return (
    <section className="staff-card">
      <div className="staff-card__head">
        <h2>Appearance</h2>
      </div>
      <div className="settings-grid">
        <label className="field">
          Theme
          <Select<typeof theme>
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </label>
        <label className="field">
          Language
          <Select<typeof lang>
            ariaLabel="Language"
            value={lang}
            onChange={setLang}
            options={[
              { value: "en", label: "English" },
              { value: "ar", label: "العربية" },
            ]}
          />
        </label>
      </div>

      <div className="field settings-grid__wide" style={{ marginTop: "1rem" }}>
        <span>Color palette</span>
        <div className="palette-picker" role="radiogroup" aria-label="Color palette">
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

      <p className="staff-empty">
        These preferences are saved on this device and apply immediately.
      </p>
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
            Cancel
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
