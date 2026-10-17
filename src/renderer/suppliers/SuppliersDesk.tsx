import type {
  InventoryLocation,
  Supplier,
  SupplierDue,
  SupplierPayment,
  SupplierPurchase,
  SupplierPurchaseItem,
  SupplierReminder,
  SupplierStatus,
  SupplierSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { logActivity } from "../activity/log";
import { classifyCommerceError } from "../commerce/errors";
import { formatMoney, minorToMajorInput, parseMajorToMinor } from "../money";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

type SupplierDraft = {
  mode: "create" | "edit";
  supplierId: string | null;
  name: string;
  code: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  status: SupplierStatus;
};
type PurchaseLine = { variantId: string; quantity: string; unitCost: string };
type PurchaseDraft = {
  supplierId: string;
  supplierName: string;
  inventoryLocationId: string;
  reference: string;
  paid: string;
  notes: string;
  lines: PurchaseLine[];
};
type ReminderDraft = {
  reminderId: string | null;
  dueDate: string;
  amount: string;
  leadDays: string;
  notify: boolean;
  note: string;
};
type VariantOption = { variantId: string; productName: string; sku: string };

function emptySupplierDraft(mode: "create" | "edit"): SupplierDraft {
  return {
    mode,
    supplierId: null,
    name: "",
    code: "",
    contactPerson: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
    status: "active",
  };
}
function localDate(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function emptyReminder(): ReminderDraft {
  return {
    reminderId: null,
    dueDate: localDate(),
    amount: "",
    leadDays: "3",
    notify: true,
    note: "",
  };
}
function formatInstant(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale);
}
function formatDate(iso: string, locale: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale);
}

export function SuppliersDesk({ client }: { client: TenantCommerceClient }) {
  const { t, locale } = useI18n();
  const [suppliers, setSuppliers] = useState<readonly SupplierSummary[]>([]);
  const [purchases, setPurchases] = useState<readonly SupplierPurchase[]>([]);
  const [dues, setDues] = useState<readonly SupplierDue[]>([]);
  const [reminders, setReminders] = useState<readonly SupplierReminder[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | SupplierStatus>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedPurchase, setExpandedPurchase] = useState<string | null>(null);
  const [purchaseItems, setPurchaseItems] = useState<
    Record<string, readonly SupplierPurchaseItem[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft | null>(null);
  const [purchase, setPurchase] = useState<PurchaseDraft | null>(null);
  const [locations, setLocations] = useState<readonly InventoryLocation[]>([]);
  const [variantOptions, setVariantOptions] = useState<readonly VariantOption[]>([]);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [payFor, setPayFor] = useState<SupplierSummary | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [payHistory, setPayHistory] = useState<readonly SupplierPayment[]>([]);
  const [reminderFor, setReminderFor] = useState<SupplierSummary | null>(null);
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft>(emptyReminder);

  const dueBySupplier = useMemo(() => new Map(dues.map((due) => [due.supplierId, due])), [dues]);
  const selected = useMemo(
    () => suppliers.find((supplier) => supplier.id === selectedId) ?? null,
    [suppliers, selectedId],
  );
  const shownPurchases = useMemo(
    () => purchases.filter((item) => selectedId === null || item.supplierId === selectedId),
    [purchases, selectedId],
  );
  const dueReminders = useMemo(() => reminders.filter((item) => item.isDue), [reminders]);

  const loadMoney = useCallback(async () => {
    const [purchaseResponse, duesResponse, reminderResponse] = await Promise.all([
      client.listSupplierPurchases({ limit: 100 }),
      client.supplierDues(),
      client.listSupplierReminders(),
    ]);
    setPurchases(purchaseResponse.items);
    setDues(duesResponse.items);
    setReminders(reminderResponse.items);
  }, [client]);
  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supplierResponse = await client.listSuppliers({
        limit: 100,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(query.trim() ? { search: query.trim() } : {}),
      });
      setSuppliers(supplierResponse.items);
      await loadMoney();
    } catch (caught) {
      setError(classifyCommerceError(caught).message);
    } finally {
      setLoading(false);
    }
  }, [client, loadMoney, query, statusFilter]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search text is applied explicitly
  }, [client, statusFilter]);
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (caught) {
        toast.error(classifyCommerceError(caught).message);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  const currencyFor = (supplierId: string) => dueBySupplier.get(supplierId)?.currency ?? "USD";

  const openEdit = (supplierId: string) =>
    void run(async () => {
      const supplier: Supplier = await client.getSupplier(supplierId);
      setSupplierDraft({
        mode: "edit",
        supplierId: supplier.id,
        name: supplier.name,
        code: supplier.code ?? "",
        contactPerson: supplier.contactPerson ?? "",
        phone: supplier.phone ?? "",
        email: supplier.email ?? "",
        address: supplier.address ?? "",
        notes: supplier.notes ?? "",
        status: supplier.status,
      });
    });
  const saveSupplier = () => {
    const draft = supplierDraft;
    if (!draft || draft.name.trim() === "") return toast.error(t("suppliers.err.nameRequired"));
    const optional = (value: string) => (value.trim() === "" ? null : value.trim());
    void run(async () => {
      const shared = {
        name: draft.name.trim(),
        code: optional(draft.code),
        contactPerson: optional(draft.contactPerson),
        phone: optional(draft.phone),
        email: optional(draft.email),
        address: optional(draft.address),
        notes: optional(draft.notes),
      };
      const saved =
        draft.mode === "create"
          ? await client.createSupplier({ idempotencyKey: crypto.randomUUID(), ...shared })
          : await client.updateSupplier({
              idempotencyKey: crypto.randomUUID(),
              supplierId: draft.supplierId!,
              status: draft.status,
              ...shared,
            });
      logActivity({
        category: "supplier",
        action: draft.mode === "create" ? "supplier_created" : "supplier_updated",
        description: `Saved supplier "${saved.name}"`,
        details: { supplierId: saved.id, status: saved.status },
      });
      setSelectedId(saved.id);
      setSupplierDraft(null);
      toast.success(t("suppliers.ok.saved", { name: saved.name }));
      await loadAll();
    });
  };

  const openPurchase = (supplier: SupplierSummary) =>
    void run(async () => {
      let activeLocations = locations;
      if (activeLocations.length === 0) {
        const response = await client.listInventoryLocations({ status: "active", limit: 100 });
        activeLocations = response.items;
        setLocations(response.items);
      }
      if (activeLocations.length === 0) return toast.error(t("suppliers.err.noLocation"));
      setPurchase({
        supplierId: supplier.id,
        supplierName: supplier.name,
        inventoryLocationId: activeLocations[0].id,
        reference: "",
        paid: "",
        notes: "",
        lines: [{ variantId: "", quantity: "", unitCost: "" }],
      });
    });
  useEffect(() => {
    const locationId = purchase?.inventoryLocationId;
    if (!locationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear options when the modal closes
      setVariantOptions([]);
      return;
    }
    let active = true;
    setVariantsLoading(true);
    void client
      .listInventory({ inventoryLocationId: locationId, limit: 200 })
      .then(
        (response) =>
          active &&
          setVariantOptions(
            response.items.map((item) => ({
              variantId: item.variantId,
              productName: item.productName,
              sku: item.sku,
            })),
          ),
      )
      .catch((caught) => active && toast.error(classifyCommerceError(caught).message))
      .finally(() => active && setVariantsLoading(false));
    return () => {
      active = false;
    };
  }, [client, purchase?.inventoryLocationId, toast]);
  const purchaseTotal = useMemo(
    () =>
      purchase?.lines.reduce((sum, line) => {
        const quantity = Number(line.quantity);
        const cost = parseMajorToMinor(line.unitCost);
        return (
          sum + (Number.isInteger(quantity) && quantity > 0 && cost !== null ? quantity * cost : 0)
        );
      }, 0) ?? 0,
    [purchase?.lines],
  );
  const savePurchase = () => {
    const draft = purchase;
    if (!draft) return;
    const lines = draft.lines.map((line) => ({
      variantId: line.variantId,
      quantity: Number(line.quantity),
      unitCostMinor: parseMajorToMinor(line.unitCost),
    }));
    if (
      lines.some(
        (line) =>
          line.variantId === "" ||
          !Number.isInteger(line.quantity) ||
          line.quantity <= 0 ||
          line.unitCostMinor === null,
      ) ||
      new Set(lines.map((line) => line.variantId)).size !== lines.length
    )
      return toast.error(t("suppliers.err.lines"));
    const paidMinor = draft.paid.trim() === "" ? undefined : parseMajorToMinor(draft.paid);
    if (paidMinor === null || (paidMinor !== undefined && paidMinor > purchaseTotal))
      return toast.error(t("suppliers.err.paidExceeds"));
    void run(async () => {
      const recorded = await client.recordSupplierPurchase({
        idempotencyKey: crypto.randomUUID(),
        supplierId: draft.supplierId,
        inventoryLocationId: draft.inventoryLocationId,
        supplierReference: draft.reference.trim() || null,
        ...(paidMinor === undefined ? {} : { paidMinor }),
        notes: draft.notes.trim() || null,
        lines: lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitCostMinor: line.unitCostMinor!,
        })),
      });
      logActivity({
        category: "supplier",
        action: "purchase_recorded",
        description: `Recorded ${formatMoney(recorded.totalMinor, recorded.currency, locale)} purchase from "${recorded.supplierName}"`,
        details: { supplierId: recorded.supplierId, purchaseId: recorded.id },
      });
      setPurchase(null);
      toast.success(t("suppliers.ok.purchaseRecorded", { name: recorded.supplierName }));
      await loadMoney();
    });
  };
  const togglePurchase = (purchaseId: string) => {
    if (expandedPurchase === purchaseId) return setExpandedPurchase(null);
    setExpandedPurchase(purchaseId);
    if (!purchaseItems[purchaseId])
      void run(async () => {
        const response = await client.supplierPurchaseItems(purchaseId);
        setPurchaseItems((current) => ({ ...current, [purchaseId]: response.items }));
      });
  };

  const openPayment = (supplier: SupplierSummary) =>
    void run(async () => {
      const response = await client.listSupplierPayments(supplier.id, { limit: 100 });
      setPayHistory(response.items);
      setPayFor(supplier);
      const outstanding = dueBySupplier.get(supplier.id)?.outstandingMinor ?? 0;
      setPayAmount(outstanding > 0 ? minorToMajorInput(outstanding) : "");
      setPayNotes("");
    });
  const savePayment = () => {
    if (!payFor) return;
    const amountMinor = parseMajorToMinor(payAmount);
    const outstanding = dueBySupplier.get(payFor.id)?.outstandingMinor ?? 0;
    if (amountMinor === null || amountMinor <= 0 || amountMinor > outstanding)
      return toast.error(t("suppliers.err.payment"));
    const supplier = payFor;
    void run(async () => {
      const payment = await client.recordSupplierPayment({
        supplierId: supplier.id,
        idempotencyKey: crypto.randomUUID(),
        amountMinor,
        notes: payNotes.trim() || null,
      });
      logActivity({
        category: "supplier",
        action: "supplier_payment_recorded",
        description: `Recorded ${formatMoney(payment.amountMinor, payment.currency, locale)} payment to "${supplier.name}"`,
        details: { supplierId: supplier.id, paymentId: payment.id },
      });
      setPayFor(null);
      toast.success(t("suppliers.ok.paymentRecorded", { name: supplier.name }));
      await loadMoney();
    });
  };

  const remindersFor = (supplierId: string) =>
    reminders.filter((reminder) => reminder.supplierId === supplierId);
  const openReminders = (supplier: SupplierSummary) => {
    setReminderFor(supplier);
    setReminderDraft(emptyReminder());
  };
  const saveReminder = () => {
    if (!reminderFor) return;
    const amountText = reminderDraft.amount.trim();
    const amountMinor = amountText === "" ? null : parseMajorToMinor(amountText);
    const leadDays = Number(reminderDraft.leadDays);
    if (
      !reminderDraft.dueDate ||
      (amountText !== "" && amountMinor === null) ||
      (amountMinor !== null && amountMinor <= 0) ||
      !Number.isInteger(leadDays) ||
      leadDays < 0 ||
      leadDays > 365
    )
      return toast.error(t("suppliers.err.reminder"));
    const supplier = reminderFor;
    void run(async () => {
      const body = {
        dueDate: reminderDraft.dueDate,
        amountMinor,
        leadDays,
        notify: reminderDraft.notify,
        note: reminderDraft.note.trim() || null,
      };
      if (reminderDraft.reminderId)
        await client.updateSupplierReminder({
          reminderId: reminderDraft.reminderId,
          idempotencyKey: crypto.randomUUID(),
          ...body,
        });
      else
        await client.createSupplierReminder({
          supplierId: supplier.id,
          idempotencyKey: crypto.randomUUID(),
          ...body,
        });
      setReminderDraft(emptyReminder());
      toast.success(t("suppliers.ok.reminderSaved", { name: supplier.name }));
      await loadMoney();
    });
  };
  const editReminder = (reminder: SupplierReminder) =>
    setReminderDraft({
      reminderId: reminder.id,
      dueDate: reminder.dueDate,
      amount: reminder.amountMinor === null ? "" : minorToMajorInput(reminder.amountMinor),
      leadDays: String(reminder.leadDays),
      notify: reminder.notify,
      note: reminder.note ?? "",
    });
  const setReminderStatus = (reminder: SupplierReminder, status: "pending" | "done") =>
    void run(async () => {
      await client.updateSupplierReminder({
        reminderId: reminder.id,
        idempotencyKey: crypto.randomUUID(),
        status,
      });
      await loadMoney();
    });
  const deleteReminder = (reminder: SupplierReminder) =>
    void run(async () => {
      await client.deleteSupplierReminder({
        reminderId: reminder.id,
        idempotencyKey: crypto.randomUUID(),
      });
      if (reminderDraft.reminderId === reminder.id) setReminderDraft(emptyReminder());
      await loadMoney();
    });

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">{t("suppliers.procurement")}</p>
          <h1>{t("nav.suppliers")}</h1>
        </div>
        <div className="staff-filters">
          <label>
            {t("activity.search")}
            <input
              value={query}
              placeholder={t("suppliers.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void loadAll()}
            />
          </label>
          <label>
            {t("orders.statusLabel")}
            <Select<"" | SupplierStatus>
              ariaLabel={t("suppliers.statusFilter")}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "", label: t("activity.all") },
                { value: "active", label: t("suppliers.active") },
                { value: "inactive", label: t("suppliers.inactive") },
              ]}
            />
          </label>
          <button
            className="button button--quiet"
            onClick={() => void loadAll()}
            disabled={loading}
          >
            {t("activity.apply")}
          </button>
          <button
            className="button button--quiet"
            onClick={() => setSupplierDraft(emptySupplierDraft("create"))}
            disabled={busy}
          >
            {t("suppliers.add")}
          </button>
        </div>
      </header>
      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void loadAll()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}
      {dueReminders.length > 0 ? (
        <section className="suppliers-due-banner" aria-label={t("suppliers.paymentsDue")}>
          <strong>{t("suppliers.paymentsDue")}</strong>
          <div>
            {dueReminders.map((reminder) => (
              <span key={reminder.id}>
                {reminder.supplierName} · {formatDate(reminder.dueDate, locale)}
                {reminder.amountMinor === null
                  ? ""
                  : ` · ${formatMoney(reminder.amountMinor, reminder.currency, locale)}`}
                {reminder.isOverdue ? ` · ${t("suppliers.overdue")}` : ""}
                <button className="link" onClick={() => setReminderStatus(reminder, "done")}>
                  {t("suppliers.done")}
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <div className="suppliers-layout">
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>
              {t("nav.suppliers")} · {suppliers.length}
            </h2>
          </div>
          <div className="suppliers-list">
            <button
              className={`suppliers-list__select suppliers-list__all${selectedId === null ? " suppliers-list__item--active" : ""}`}
              onClick={() => setSelectedId(null)}
            >
              <strong>{t("suppliers.all")}</strong>
              <span className="muted">
                {t("suppliers.purchasesCount", { count: purchases.length })}
              </span>
            </button>
            {suppliers.map((supplier) => {
              const active = selectedId === supplier.id;
              const due = dueBySupplier.get(supplier.id);
              const hasDueReminder = remindersFor(supplier.id).some((reminder) => reminder.isDue);
              return (
                <div
                  key={supplier.id}
                  className={`suppliers-list__item${active ? " suppliers-list__item--active" : ""}`}
                >
                  <button
                    className="suppliers-list__select"
                    onClick={() => setSelectedId(active ? null : supplier.id)}
                  >
                    <strong>{supplier.name}</strong>
                    <span className="muted">
                      {supplier.code ? `${supplier.code} · ` : ""}
                      {supplier.status}
                    </span>
                    {due && due.outstandingMinor > 0 ? (
                      <span className="supplier-badge supplier-badge--due">
                        {t("suppliers.due", {
                          amount: formatMoney(due.outstandingMinor, due.currency, locale),
                        })}
                      </span>
                    ) : null}
                    {hasDueReminder ? (
                      <span className="supplier-badge supplier-badge--warn">
                        {t("suppliers.reminderDue")}
                      </span>
                    ) : null}
                  </button>
                  <span className="suppliers-list__actions">
                    <button
                      className="link"
                      disabled={busy || supplier.status !== "active"}
                      onClick={() => openPurchase(supplier)}
                    >
                      {t("suppliers.purchase")}
                    </button>
                    <button
                      className="link"
                      disabled={busy || (due?.outstandingMinor ?? 0) === 0}
                      onClick={() => openPayment(supplier)}
                    >
                      {t("staff.pay")}
                    </button>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => openReminders(supplier)}
                    >
                      {t("suppliers.remind")}
                    </button>
                    <button className="link" disabled={busy} onClick={() => openEdit(supplier.id)}>
                      {t("staff.edit")}
                    </button>
                  </span>
                </div>
              );
            })}
            {loading ? <SkeletonLines lines={6} label={t("suppliers.loading")} /> : null}
            {!loading && suppliers.length === 0 ? (
              <p className="staff-empty">{t("suppliers.none")}</p>
            ) : null}
          </div>
        </section>
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>
              {t("suppliers.purchaseHistory")}
              {selected ? <span className="muted"> · {selected.name}</span> : null}
            </h2>
            {selected?.status === "active" ? (
              <button
                className="button button--quiet"
                onClick={() => openPurchase(selected)}
                disabled={busy}
              >
                {t("suppliers.newPurchase")}
              </button>
            ) : null}
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>{t("customers.date")}</th>
                  <th>{t("suppliers.supplierRef")}</th>
                  <th className="end">{t("cashier.total")}</th>
                  <th className="end">{t("suppliers.paid")}</th>
                </tr>
              </thead>
              <tbody>
                {shownPurchases.map((item) => {
                  const expanded = expandedPurchase === item.id;
                  return (
                    <Fragment key={item.id}>
                      <tr className="suppliers-receipt" onClick={() => togglePurchase(item.id)}>
                        <td>{formatInstant(item.occurredAt, locale)}</td>
                        <td>
                          <strong>{item.supplierName}</strong>
                          <small>
                            {item.supplierReference ?? t("suppliers.noReference")}{" "}
                            {expanded ? "▾" : "▸"}
                          </small>
                        </td>
                        <td className="end">
                          <strong>{formatMoney(item.totalMinor, item.currency, locale)}</strong>
                        </td>
                        <td className="end">
                          {formatMoney(item.effectivePaidMinor, item.currency, locale)}
                          {item.outstandingMinor > 0 ? (
                            <small className="supplier-due-text">
                              {t("suppliers.due", {
                                amount: formatMoney(item.outstandingMinor, item.currency, locale),
                              })}
                            </small>
                          ) : (
                            <small className="supplier-paid-text">{t("suppliers.settled")}</small>
                          )}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={4}>
                            {!purchaseItems[item.id] ? (
                              <p className="staff-empty">{t("suppliers.loadingLines")}</p>
                            ) : (
                              <table className="staff-table">
                                <thead>
                                  <tr>
                                    <th>{t("orders.product")}</th>
                                    <th className="end">{t("suppliers.quantity")}</th>
                                    <th className="end">{t("suppliers.unitCost")}</th>
                                    <th className="end">{t("orders.lineTotal")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {purchaseItems[item.id].map((line) => (
                                    <tr key={line.id}>
                                      <td>
                                        <strong>{line.productName}</strong>
                                        <small>{t("cashier.sku", { sku: line.sku })}</small>
                                      </td>
                                      <td className="end">{line.quantity}</td>
                                      <td className="end">
                                        {formatMoney(line.unitCostMinor, item.currency, locale)}
                                      </td>
                                      <td className="end">
                                        <strong>
                                          {formatMoney(line.lineTotalMinor, item.currency, locale)}
                                        </strong>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!loading && shownPurchases.length === 0 ? (
            <p className="staff-empty">{t("suppliers.noPurchases")}</p>
          ) : null}
        </section>
      </div>

      {supplierDraft ? (
        <Modal
          title={supplierDraft.mode === "create" ? t("suppliers.add") : t("suppliers.editTitle")}
          onClose={() => setSupplierDraft(null)}
          onSave={saveSupplier}
          busy={busy}
          saveLabel={t("staff.save")}
        >
          <label className="field">
            {t("orders.name")}
            <input
              value={supplierDraft.name}
              onChange={(event) => setSupplierDraft({ ...supplierDraft, name: event.target.value })}
            />
          </label>
          <div className="suppliers-field-row">
            <label className="field">
              {t("suppliers.code")}
              <input
                value={supplierDraft.code}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, code: event.target.value })
                }
              />
            </label>
            {supplierDraft.mode === "edit" ? (
              <label className="field">
                {t("orders.statusLabel")}
                <Select<SupplierStatus>
                  ariaLabel={t("suppliers.status")}
                  value={supplierDraft.status}
                  onChange={(status) => setSupplierDraft({ ...supplierDraft, status })}
                  options={[
                    { value: "active", label: t("suppliers.active") },
                    { value: "inactive", label: t("suppliers.inactive") },
                  ]}
                />
              </label>
            ) : null}
          </div>
          <label className="field">
            {t("suppliers.contactPerson")}
            <input
              value={supplierDraft.contactPerson}
              onChange={(event) =>
                setSupplierDraft({ ...supplierDraft, contactPerson: event.target.value })
              }
            />
          </label>
          <div className="suppliers-field-row">
            <label className="field">
              {t("suppliers.phone")}
              <input
                value={supplierDraft.phone}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, phone: event.target.value })
                }
              />
            </label>
            <label className="field">
              {t("suppliers.email")}
              <input
                value={supplierDraft.email}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, email: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            {t("suppliers.address")}
            <input
              value={supplierDraft.address}
              onChange={(event) =>
                setSupplierDraft({ ...supplierDraft, address: event.target.value })
              }
            />
          </label>
          <label className="field">
            {t("suppliers.notes")}
            <input
              value={supplierDraft.notes}
              onChange={(event) =>
                setSupplierDraft({ ...supplierDraft, notes: event.target.value })
              }
            />
          </label>
        </Modal>
      ) : null}

      {purchase ? (
        <Modal
          title={t("suppliers.newPurchaseFor", { name: purchase.supplierName })}
          onClose={() => setPurchase(null)}
          onSave={savePurchase}
          busy={busy}
          saveLabel={t("suppliers.recordTotal", {
            amount: formatMoney(purchaseTotal, currencyFor(purchase.supplierId), locale),
          })}
        >
          <p className="muted">{t("suppliers.purchaseNote")}</p>
          <div className="suppliers-field-row">
            <label className="field">
              {t("inventory.destination")}
              <Select
                ariaLabel={t("inventory.destination")}
                value={purchase.inventoryLocationId}
                onChange={(value) => setPurchase({ ...purchase, inventoryLocationId: value })}
                options={locations.map((location) => ({
                  value: location.id,
                  label: location.displayName,
                }))}
              />
            </label>
            <label className="field">
              {t("suppliers.referenceInvoice")}
              <input
                value={purchase.reference}
                onChange={(event) => setPurchase({ ...purchase, reference: event.target.value })}
              />
            </label>
          </div>
          <div className="suppliers-field-row">
            <label className="field">
              {t("suppliers.amountPaid")}
              <input
                inputMode="decimal"
                placeholder={minorToMajorInput(purchaseTotal)}
                value={purchase.paid}
                onChange={(event) => setPurchase({ ...purchase, paid: event.target.value })}
              />
            </label>
            <label className="field">
              {t("inventory.note")}
              <input
                value={purchase.notes}
                onChange={(event) => setPurchase({ ...purchase, notes: event.target.value })}
              />
            </label>
          </div>
          <div className="suppliers-lines">
            {purchase.lines.map((line, index) => (
              <div className="suppliers-line suppliers-line--money" key={index}>
                <Select
                  ariaLabel={t("orders.product")}
                  placeholder={
                    variantsLoading ? t("suppliers.loadingProducts") : t("suppliers.chooseProduct")
                  }
                  value={line.variantId}
                  disabled={variantsLoading}
                  onChange={(value) =>
                    setPurchase({
                      ...purchase,
                      lines: purchase.lines.map((existing, cursor) =>
                        cursor === index ? { ...existing, variantId: value } : existing,
                      ),
                    })
                  }
                  options={variantOptions.map((option) => ({
                    value: option.variantId,
                    label: `${option.productName} · ${option.sku}`,
                  }))}
                />
                <input
                  className="suppliers-line__qty"
                  inputMode="numeric"
                  placeholder={t("suppliers.qtyShort")}
                  value={line.quantity}
                  onChange={(event) =>
                    setPurchase({
                      ...purchase,
                      lines: purchase.lines.map((existing, cursor) =>
                        cursor === index ? { ...existing, quantity: event.target.value } : existing,
                      ),
                    })
                  }
                />
                <input
                  className="suppliers-line__cost"
                  inputMode="decimal"
                  placeholder={t("suppliers.unitCost")}
                  value={line.unitCost}
                  onChange={(event) =>
                    setPurchase({
                      ...purchase,
                      lines: purchase.lines.map((existing, cursor) =>
                        cursor === index ? { ...existing, unitCost: event.target.value } : existing,
                      ),
                    })
                  }
                />
                <button
                  className="link"
                  disabled={purchase.lines.length === 1}
                  onClick={() =>
                    setPurchase({
                      ...purchase,
                      lines: purchase.lines.filter((_, cursor) => cursor !== index),
                    })
                  }
                >
                  {t("cashier.remove")}
                </button>
              </div>
            ))}
          </div>
          <button
            className="button button--quiet"
            onClick={() =>
              setPurchase({
                ...purchase,
                lines: [...purchase.lines, { variantId: "", quantity: "", unitCost: "" }],
              })
            }
          >
            {t("suppliers.addLine")}
          </button>
        </Modal>
      ) : null}

      {payFor ? (
        <Modal
          title={t("suppliers.logPaymentFor", { name: payFor.name })}
          onClose={() => setPayFor(null)}
          onSave={savePayment}
          busy={busy}
          saveLabel={t("suppliers.recordPayment")}
        >
          {(() => {
            const due = dueBySupplier.get(payFor.id);
            return due ? (
              <div className="supplier-money-summary">
                <span>
                  {t("suppliers.purchased")}{" "}
                  <strong>{formatMoney(due.purchasedMinor, due.currency, locale)}</strong>
                </span>
                <span>
                  {t("suppliers.paid")}{" "}
                  <strong>{formatMoney(due.paidMinor, due.currency, locale)}</strong>
                </span>
                <span>
                  {t("suppliers.dueLabel")}{" "}
                  <strong>{formatMoney(due.outstandingMinor, due.currency, locale)}</strong>
                </span>
              </div>
            ) : null;
          })()}
          <label className="field">
            {t("orders.amount")}
            <input
              inputMode="decimal"
              value={payAmount}
              onChange={(event) => setPayAmount(event.target.value)}
            />
          </label>
          <label className="field">
            {t("inventory.note")}
            <input value={payNotes} onChange={(event) => setPayNotes(event.target.value)} />
          </label>
          <div className="supplier-modal-list">
            <strong>{t("suppliers.paymentHistory")}</strong>
            {payHistory.length === 0 ? (
              <p className="muted">{t("suppliers.noPayments")}</p>
            ) : (
              payHistory.map((payment) => (
                <div key={payment.id}>
                  <span>
                    {formatInstant(payment.paidAt, locale)}
                    {payment.notes ? ` · ${payment.notes}` : ""}
                  </span>
                  <strong>{formatMoney(payment.amountMinor, payment.currency, locale)}</strong>
                </div>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {reminderFor ? (
        <Modal
          title={t("suppliers.remindersFor", { name: reminderFor.name })}
          onClose={() => setReminderFor(null)}
          onSave={saveReminder}
          busy={busy}
          saveLabel={
            reminderDraft.reminderId ? t("suppliers.saveReminder") : t("suppliers.addReminder")
          }
        >
          <div className="suppliers-field-row">
            <label className="field">
              {t("suppliers.dueDate")}
              <input
                type="date"
                value={reminderDraft.dueDate}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, dueDate: event.target.value })
                }
              />
            </label>
            <label className="field">
              {t("suppliers.amountOptional")}
              <input
                inputMode="decimal"
                value={reminderDraft.amount}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, amount: event.target.value })
                }
              />
            </label>
          </div>
          <div className="suppliers-field-row">
            <label className="field">
              {t("suppliers.leadDays")}
              <input
                inputMode="numeric"
                value={reminderDraft.leadDays}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, leadDays: event.target.value })
                }
              />
            </label>
            <label className="field">
              {t("inventory.note")}
              <input
                value={reminderDraft.note}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, note: event.target.value })
                }
              />
            </label>
          </div>
          <label className="supplier-check">
            <input
              type="checkbox"
              checked={reminderDraft.notify}
              onChange={(event) =>
                setReminderDraft({ ...reminderDraft, notify: event.target.checked })
              }
            />{" "}
            {t("suppliers.notifyLead")}
          </label>
          {reminderDraft.reminderId ? (
            <button className="link" onClick={() => setReminderDraft(emptyReminder())}>
              {t("suppliers.cancelEditing")}
            </button>
          ) : null}
          <div className="supplier-modal-list">
            <strong>{t("suppliers.reminders")}</strong>
            {remindersFor(reminderFor.id).length === 0 ? (
              <p className="muted">{t("suppliers.noReminders")}</p>
            ) : (
              remindersFor(reminderFor.id).map((reminder) => (
                <div key={reminder.id}>
                  <span className={reminder.status === "done" ? "supplier-reminder--done" : ""}>
                    <strong>{formatDate(reminder.dueDate, locale)}</strong>
                    {reminder.amountMinor === null
                      ? ""
                      : ` · ${formatMoney(reminder.amountMinor, reminder.currency, locale)}`}
                    {reminder.isOverdue
                      ? ` · ${t("suppliers.overdue")}`
                      : reminder.isDue
                        ? ` · ${t("suppliers.dueSoon")}`
                        : ""}
                    {reminder.note ? ` · ${reminder.note}` : ""}
                  </span>
                  <span>
                    <button
                      className="link"
                      onClick={() =>
                        setReminderStatus(reminder, reminder.status === "done" ? "pending" : "done")
                      }
                    >
                      {reminder.status === "done" ? t("suppliers.reopen") : t("suppliers.done")}
                    </button>
                    <button className="link" onClick={() => editReminder(reminder)}>
                      {t("staff.edit")}
                    </button>
                    <button className="link link--danger" onClick={() => deleteReminder(reminder)}>
                      {t("staff.delete")}
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
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
  saveLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  saveLabel: string;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
