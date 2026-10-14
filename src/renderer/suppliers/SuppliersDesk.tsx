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
function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function SuppliersDesk({ client }: { client: TenantCommerceClient }) {
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
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast.error(classifyCommerceError(caught).message);
    } finally {
      setBusy(false);
    }
  }, []);
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
    if (!draft || draft.name.trim() === "") return toast.error("A supplier name is required.");
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
      toast.success(`Saved supplier ${saved.name}.`);
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
      if (activeLocations.length === 0)
        return toast.error("No active inventory location can receive stock.");
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
  }, [client, purchase?.inventoryLocationId]);
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
      return toast.error("Every line needs a unique product, whole quantity, and valid unit cost.");
    const paidMinor = draft.paid.trim() === "" ? undefined : parseMajorToMinor(draft.paid);
    if (paidMinor === null || (paidMinor !== undefined && paidMinor > purchaseTotal))
      return toast.error("Amount paid must not exceed the purchase total.");
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
        description: `Recorded ${formatMoney(recorded.totalMinor, recorded.currency)} purchase from "${recorded.supplierName}"`,
        details: { supplierId: recorded.supplierId, purchaseId: recorded.id },
      });
      setPurchase(null);
      toast.success(`Recorded purchase from ${recorded.supplierName}.`);
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
      return toast.error("Payment must be greater than zero and no more than the outstanding due.");
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
        description: `Recorded ${formatMoney(payment.amountMinor, payment.currency)} payment to "${supplier.name}"`,
        details: { supplierId: supplier.id, paymentId: payment.id },
      });
      setPayFor(null);
      toast.success(`Recorded payment to ${supplier.name}.`);
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
      return toast.error("Reminder date, amount, and lead days are not valid.");
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
      toast.success(`Saved payment reminder for ${supplier.name}.`);
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
          <p className="eyebrow">Procurement &amp; payables</p>
          <h1>Suppliers</h1>
        </div>
        <div className="staff-filters">
          <label>
            Search
            <input
              value={query}
              placeholder="Name or code"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void loadAll()}
            />
          </label>
          <label>
            Status
            <Select<"" | SupplierStatus>
              ariaLabel="Supplier status filter"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "", label: "All" },
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
          </label>
          <button
            className="button button--quiet"
            onClick={() => void loadAll()}
            disabled={loading}
          >
            Apply
          </button>
          <button
            className="button button--quiet"
            onClick={() => setSupplierDraft(emptySupplierDraft("create"))}
            disabled={busy}
          >
            Add supplier
          </button>
        </div>
      </header>
      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void loadAll()}>
            Retry
          </button>
        </div>
      ) : null}
      {dueReminders.length > 0 ? (
        <section className="suppliers-due-banner" aria-label="Payments due">
          <strong>Payments due</strong>
          <div>
            {dueReminders.map((reminder) => (
              <span key={reminder.id}>
                {reminder.supplierName} · {formatDate(reminder.dueDate)}
                {reminder.amountMinor === null
                  ? ""
                  : ` · ${formatMoney(reminder.amountMinor, reminder.currency)}`}
                {reminder.isOverdue ? " · Overdue" : ""}
                <button className="link" onClick={() => setReminderStatus(reminder, "done")}>
                  Done
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <div className="suppliers-layout">
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>Suppliers · {suppliers.length}</h2>
          </div>
          <div className="suppliers-list">
            <button
              className={`suppliers-list__select suppliers-list__all${selectedId === null ? " suppliers-list__item--active" : ""}`}
              onClick={() => setSelectedId(null)}
            >
              <strong>All suppliers</strong>
              <span className="muted">{purchases.length} purchases</span>
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
                        Due {formatMoney(due.outstandingMinor, due.currency)}
                      </span>
                    ) : null}
                    {hasDueReminder ? (
                      <span className="supplier-badge supplier-badge--warn">
                        Payment reminder due
                      </span>
                    ) : null}
                  </button>
                  <span className="suppliers-list__actions">
                    <button
                      className="link"
                      disabled={busy || supplier.status !== "active"}
                      onClick={() => openPurchase(supplier)}
                    >
                      Purchase
                    </button>
                    <button
                      className="link"
                      disabled={busy || (due?.outstandingMinor ?? 0) === 0}
                      onClick={() => openPayment(supplier)}
                    >
                      Pay
                    </button>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => openReminders(supplier)}
                    >
                      Remind
                    </button>
                    <button className="link" disabled={busy} onClick={() => openEdit(supplier.id)}>
                      Edit
                    </button>
                  </span>
                </div>
              );
            })}
            {loading ? <SkeletonLines lines={6} label="Loading suppliers" /> : null}
            {!loading && suppliers.length === 0 ? (
              <p className="staff-empty">No suppliers found.</p>
            ) : null}
          </div>
        </section>
        <section className="staff-card">
          <div className="staff-card__head">
            <h2>
              Purchase history{selected ? <span className="muted"> · {selected.name}</span> : null}
            </h2>
            {selected?.status === "active" ? (
              <button
                className="button button--quiet"
                onClick={() => openPurchase(selected)}
                disabled={busy}
              >
                New purchase
              </button>
            ) : null}
          </div>
          <div className="staff-table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Supplier / reference</th>
                  <th className="end">Total</th>
                  <th className="end">Paid</th>
                </tr>
              </thead>
              <tbody>
                {shownPurchases.map((item) => {
                  const expanded = expandedPurchase === item.id;
                  return (
                    <Fragment key={item.id}>
                      <tr className="suppliers-receipt" onClick={() => togglePurchase(item.id)}>
                        <td>{formatInstant(item.occurredAt)}</td>
                        <td>
                          <strong>{item.supplierName}</strong>
                          <small>
                            {item.supplierReference ?? "No reference"} {expanded ? "▾" : "▸"}
                          </small>
                        </td>
                        <td className="end">
                          <strong>{formatMoney(item.totalMinor, item.currency)}</strong>
                        </td>
                        <td className="end">
                          {formatMoney(item.effectivePaidMinor, item.currency)}
                          {item.outstandingMinor > 0 ? (
                            <small className="supplier-due-text">
                              Due {formatMoney(item.outstandingMinor, item.currency)}
                            </small>
                          ) : (
                            <small className="supplier-paid-text">Settled</small>
                          )}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={4}>
                            {!purchaseItems[item.id] ? (
                              <p className="staff-empty">Loading lines…</p>
                            ) : (
                              <table className="staff-table">
                                <thead>
                                  <tr>
                                    <th>Product</th>
                                    <th className="end">Quantity</th>
                                    <th className="end">Unit cost</th>
                                    <th className="end">Line total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {purchaseItems[item.id].map((line) => (
                                    <tr key={line.id}>
                                      <td>
                                        <strong>{line.productName}</strong>
                                        <small>SKU {line.sku}</small>
                                      </td>
                                      <td className="end">{line.quantity}</td>
                                      <td className="end">
                                        {formatMoney(line.unitCostMinor, item.currency)}
                                      </td>
                                      <td className="end">
                                        <strong>
                                          {formatMoney(line.lineTotalMinor, item.currency)}
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
            <p className="staff-empty">No purchases recorded.</p>
          ) : null}
        </section>
      </div>

      {supplierDraft ? (
        <Modal
          title={supplierDraft.mode === "create" ? "Add supplier" : "Edit supplier"}
          onClose={() => setSupplierDraft(null)}
          onSave={saveSupplier}
          busy={busy}
          saveLabel="Save"
        >
          <label className="field">
            Name
            <input
              value={supplierDraft.name}
              onChange={(event) => setSupplierDraft({ ...supplierDraft, name: event.target.value })}
            />
          </label>
          <div className="suppliers-field-row">
            <label className="field">
              Code (optional)
              <input
                value={supplierDraft.code}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, code: event.target.value })
                }
              />
            </label>
            {supplierDraft.mode === "edit" ? (
              <label className="field">
                Status
                <Select<SupplierStatus>
                  ariaLabel="Supplier status"
                  value={supplierDraft.status}
                  onChange={(status) => setSupplierDraft({ ...supplierDraft, status })}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                />
              </label>
            ) : null}
          </div>
          <label className="field">
            Contact person (optional)
            <input
              value={supplierDraft.contactPerson}
              onChange={(event) =>
                setSupplierDraft({ ...supplierDraft, contactPerson: event.target.value })
              }
            />
          </label>
          <div className="suppliers-field-row">
            <label className="field">
              Phone (optional)
              <input
                value={supplierDraft.phone}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, phone: event.target.value })
                }
              />
            </label>
            <label className="field">
              Email (optional)
              <input
                value={supplierDraft.email}
                onChange={(event) =>
                  setSupplierDraft({ ...supplierDraft, email: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            Address (optional)
            <input
              value={supplierDraft.address}
              onChange={(event) =>
                setSupplierDraft({ ...supplierDraft, address: event.target.value })
              }
            />
          </label>
          <label className="field">
            Notes (optional)
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
          title={`New purchase · ${purchase.supplierName}`}
          onClose={() => setPurchase(null)}
          onSave={savePurchase}
          busy={busy}
          saveLabel={`Record · ${formatMoney(purchaseTotal, currencyFor(purchase.supplierId))}`}
        >
          <p className="muted">
            The API records the priced purchase and all stock receipts atomically. Costs are
            supplier-accounting facts, not inventory valuation.
          </p>
          <div className="suppliers-field-row">
            <label className="field">
              Destination
              <Select
                ariaLabel="Destination"
                value={purchase.inventoryLocationId}
                onChange={(value) => setPurchase({ ...purchase, inventoryLocationId: value })}
                options={locations.map((location) => ({
                  value: location.id,
                  label: location.displayName,
                }))}
              />
            </label>
            <label className="field">
              Reference / invoice (optional)
              <input
                value={purchase.reference}
                onChange={(event) => setPurchase({ ...purchase, reference: event.target.value })}
              />
            </label>
          </div>
          <div className="suppliers-field-row">
            <label className="field">
              Amount paid (blank = full)
              <input
                inputMode="decimal"
                placeholder={minorToMajorInput(purchaseTotal)}
                value={purchase.paid}
                onChange={(event) => setPurchase({ ...purchase, paid: event.target.value })}
              />
            </label>
            <label className="field">
              Notes (optional)
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
                  ariaLabel="Product"
                  placeholder={variantsLoading ? "Loading products…" : "Choose product"}
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
                  placeholder="Qty"
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
                  placeholder="Unit cost"
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
                  Remove
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
            + Add line
          </button>
        </Modal>
      ) : null}

      {payFor ? (
        <Modal
          title={`Log payment · ${payFor.name}`}
          onClose={() => setPayFor(null)}
          onSave={savePayment}
          busy={busy}
          saveLabel="Record payment"
        >
          {(() => {
            const due = dueBySupplier.get(payFor.id);
            return due ? (
              <div className="supplier-money-summary">
                <span>
                  Purchased <strong>{formatMoney(due.purchasedMinor, due.currency)}</strong>
                </span>
                <span>
                  Paid <strong>{formatMoney(due.paidMinor, due.currency)}</strong>
                </span>
                <span>
                  Due <strong>{formatMoney(due.outstandingMinor, due.currency)}</strong>
                </span>
              </div>
            ) : null;
          })()}
          <label className="field">
            Amount
            <input
              inputMode="decimal"
              value={payAmount}
              onChange={(event) => setPayAmount(event.target.value)}
            />
          </label>
          <label className="field">
            Notes (optional)
            <input value={payNotes} onChange={(event) => setPayNotes(event.target.value)} />
          </label>
          <div className="supplier-modal-list">
            <strong>Payment history</strong>
            {payHistory.length === 0 ? (
              <p className="muted">No standalone payments yet.</p>
            ) : (
              payHistory.map((payment) => (
                <div key={payment.id}>
                  <span>
                    {formatInstant(payment.paidAt)}
                    {payment.notes ? ` · ${payment.notes}` : ""}
                  </span>
                  <strong>{formatMoney(payment.amountMinor, payment.currency)}</strong>
                </div>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {reminderFor ? (
        <Modal
          title={`Payment reminders · ${reminderFor.name}`}
          onClose={() => setReminderFor(null)}
          onSave={saveReminder}
          busy={busy}
          saveLabel={reminderDraft.reminderId ? "Save reminder" : "Add reminder"}
        >
          <div className="suppliers-field-row">
            <label className="field">
              Due date
              <input
                type="date"
                value={reminderDraft.dueDate}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, dueDate: event.target.value })
                }
              />
            </label>
            <label className="field">
              Amount (optional)
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
              Lead days
              <input
                inputMode="numeric"
                value={reminderDraft.leadDays}
                onChange={(event) =>
                  setReminderDraft({ ...reminderDraft, leadDays: event.target.value })
                }
              />
            </label>
            <label className="field">
              Note (optional)
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
            Notify when the lead window opens
          </label>
          {reminderDraft.reminderId ? (
            <button className="link" onClick={() => setReminderDraft(emptyReminder())}>
              Cancel editing
            </button>
          ) : null}
          <div className="supplier-modal-list">
            <strong>Reminders</strong>
            {remindersFor(reminderFor.id).length === 0 ? (
              <p className="muted">No reminders.</p>
            ) : (
              remindersFor(reminderFor.id).map((reminder) => (
                <div key={reminder.id}>
                  <span className={reminder.status === "done" ? "supplier-reminder--done" : ""}>
                    <strong>{formatDate(reminder.dueDate)}</strong>
                    {reminder.amountMinor === null
                      ? ""
                      : ` · ${formatMoney(reminder.amountMinor, reminder.currency)}`}
                    {reminder.isOverdue ? " · Overdue" : reminder.isDue ? " · Due soon" : ""}
                    {reminder.note ? ` · ${reminder.note}` : ""}
                  </span>
                  <span>
                    <button
                      className="link"
                      onClick={() =>
                        setReminderStatus(reminder, reminder.status === "done" ? "pending" : "done")
                      }
                    >
                      {reminder.status === "done" ? "Reopen" : "Done"}
                    </button>
                    <button className="link" onClick={() => editReminder(reminder)}>
                      Edit
                    </button>
                    <button className="link link--danger" onClick={() => deleteReminder(reminder)}>
                      Delete
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
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-modal" ref={dialogRef} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <div className="staff-modal__body">{children}</div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={onSave} disabled={busy}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
