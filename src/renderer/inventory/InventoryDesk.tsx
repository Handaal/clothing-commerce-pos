import type {
  InventoryListResponse,
  InventoryLocation,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { Icons } from "../shell/icons";
import { Select } from "../shell/Select";
import { SkeletonTable } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { useModalA11y } from "../shell/useModalA11y";

type StockRow = InventoryListResponse["items"][number];

// A pending write targets one variant at one location; the row supplies the known identity + version.
type ReceiveDraft = {
  kind: "receive";
  variantId: string;
  productName: string;
  sku: string;
  inventoryLocationId: string;
  quantity: string;
  supplierReference: string;
  note: string;
};
type AdjustDraft = {
  kind: "adjust";
  variantId: string;
  productName: string;
  sku: string;
  inventoryLocationId: string;
  expectedVersion: number;
  countedQuantity: string;
  note: string;
};
type TransferDraft = {
  kind: "transfer";
  variantId: string;
  productName: string;
  sku: string;
  sourceInventoryLocationId: string;
  destinationInventoryLocationId: string;
  quantity: string;
  note: string;
};
type Draft = ReceiveDraft | AdjustDraft | TransferDraft;

export function InventoryDesk({ client }: { client: TenantCommerceClient }) {
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [list, setList] = useState<InventoryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);

  const locationName = useCallback(
    (id: string) => locations.find((loc) => loc.id === id)?.displayName ?? id,
    [locations],
  );

  // Locations are the scope selector for every read and write. Load active ones once up front.
  useEffect(() => {
    let active = true;
    void client
      .listInventoryLocations({ status: "active", limit: 100 })
      .then((response) => {
        if (!active) return;
        setLocations(response.items);
        setLocationId((current) => current ?? response.items[0]?.id ?? null);
      })
      .catch((err) => active && setError(classifyCommerceError(err).message));
    return () => {
      active = false;
    };
  }, [client]);

  const loadLevels = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    try {
      setList(await client.listInventory({ inventoryLocationId: locationId, limit: 100 }));
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setLoading(false);
    }
  }, [client, locationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void loadLevels();
  }, [loadLevels]);

  const loadMore = useCallback(async () => {
    if (!list?.pageInfo.hasMore || !locationId) return;
    try {
      const next = await client.listInventory({
        inventoryLocationId: locationId,
        limit: 100,
        cursor: list.pageInfo.nextCursor ?? undefined,
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setError(classifyCommerceError(err).message);
    }
  }, [client, list, locationId]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await action();
        setDraft(null);
        toast.success(done);
        await loadLevels();
      } catch (err) {
        toast.error(classifyCommerceError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [loadLevels],
  );

  const submitDraft = () => {
    if (!draft) return;
    if (draft.kind === "receive") {
      const quantity = Number(draft.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        toast.error("Enter a whole quantity greater than zero.");
        return;
      }
      void run(
        () =>
          client.receiveInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            inventoryLocationId: draft.inventoryLocationId,
            quantity,
            ...(draft.supplierReference.trim()
              ? { supplierReference: draft.supplierReference.trim() }
              : {}),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        `Received ${quantity} into ${locationName(draft.inventoryLocationId)}.`,
      );
    } else if (draft.kind === "adjust") {
      const countedQuantity = Number(draft.countedQuantity);
      if (!Number.isInteger(countedQuantity) || countedQuantity < 0) {
        toast.error("Enter a counted quantity of zero or more.");
        return;
      }
      void run(
        () =>
          client.adjustInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            inventoryLocationId: draft.inventoryLocationId,
            countedQuantity,
            expectedVersion: draft.expectedVersion,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        `Count set to ${countedQuantity} for ${draft.sku}.`,
      );
    } else {
      const quantity = Number(draft.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        toast.error("Enter a whole quantity greater than zero.");
        return;
      }
      if (draft.destinationInventoryLocationId === draft.sourceInventoryLocationId) {
        toast.error("Choose a different destination location.");
        return;
      }
      void run(
        () =>
          client.transferInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: draft.variantId,
            sourceInventoryLocationId: draft.sourceInventoryLocationId,
            destinationInventoryLocationId: draft.destinationInventoryLocationId,
            quantity,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        `Transferred ${quantity} of ${draft.sku}.`,
      );
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows: readonly StockRow[] =
    list === null
      ? []
      : normalizedQuery === ""
        ? list.items
        : list.items.filter(
            (row) =>
              row.productName.toLowerCase().includes(normalizedQuery) ||
              row.sku.toLowerCase().includes(normalizedQuery),
          );

  const totalOnHand = visibleRows.reduce((sum, row) => sum + row.onHand, 0);
  const transferTargets = useMemo(
    () => locations.filter((loc) => loc.isTransferDestinationEnabled),
    [locations],
  );

  return (
    <main className="staff-shell">
      <header className="staff-topbar">
        <div>
          <p className="eyebrow">Stock</p>
          <h1>Inventory</h1>
        </div>
        <div className="staff-filters">
          <label>
            Location
            <Select
              ariaLabel="Location"
              value={locationId ?? ""}
              onChange={(value) => setLocationId(value)}
              disabled={locations.length === 0}
              options={locations.map((loc) => ({ value: loc.id, label: loc.displayName }))}
            />
          </label>
          <label>
            Search product or SKU
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button
            className="button button--quiet"
            onClick={() => void loadLevels()}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void loadLevels()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="staff-stats">
        <div className="staff-stat">
          <span>Tracked SKUs</span>
          <strong>{list ? list.items.length : "—"}</strong>
        </div>
        <div className="staff-stat staff-stat--accent">
          <span>Units on hand{normalizedQuery ? " (filtered)" : ""}</span>
          <strong>{totalOnHand}</strong>
        </div>
        <div className="staff-stat">
          <span>Locations</span>
          <strong>{locations.length}</strong>
        </div>
      </div>

      <section className="staff-card">
        <div className="staff-card__head">
          <h2>Stock levels · {locationId ? locationName(locationId) : "—"}</h2>
        </div>
        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="end">On hand</th>
                <th className="end">Version</th>
                <th className="end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.variantId}>
                  <td>
                    <strong>{row.productName}</strong>
                    <small>SKU {row.sku}</small>
                  </td>
                  <td className="end">
                    <strong>{row.onHand}</strong>
                  </td>
                  <td className="end muted">{row.version}</td>
                  <td className="end">
                    <span className="row-actions">
                      <button
                        className="row-action"
                        disabled={busy}
                        onClick={() =>
                          setDraft({
                            kind: "receive",
                            variantId: row.variantId,
                            productName: row.productName,
                            sku: row.sku,
                            inventoryLocationId: row.inventoryLocationId,
                            quantity: "",
                            supplierReference: "",
                            note: "",
                          })
                        }
                      >
                        <Icons.receive />
                        Receive
                      </button>
                      <button
                        className="row-action"
                        disabled={busy}
                        onClick={() =>
                          setDraft({
                            kind: "adjust",
                            variantId: row.variantId,
                            productName: row.productName,
                            sku: row.sku,
                            inventoryLocationId: row.inventoryLocationId,
                            expectedVersion: row.version,
                            countedQuantity: String(row.onHand),
                            note: "",
                          })
                        }
                      >
                        <Icons.adjust />
                        Adjust
                      </button>
                      <button
                        className="row-action"
                        disabled={busy || transferTargets.length === 0}
                        onClick={() =>
                          setDraft({
                            kind: "transfer",
                            variantId: row.variantId,
                            productName: row.productName,
                            sku: row.sku,
                            sourceInventoryLocationId: row.inventoryLocationId,
                            destinationInventoryLocationId:
                              transferTargets.find((loc) => loc.id !== row.inventoryLocationId)
                                ?.id ?? "",
                            quantity: "",
                            note: "",
                          })
                        }
                      >
                        <Icons.transfer />
                        Transfer
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? <SkeletonTable rows={6} cols={4} label="Loading stock" /> : null}
        {!loading && visibleRows.length === 0 ? (
          <p className="staff-empty">
            {normalizedQuery === ""
              ? "No stock tracked at this location yet."
              : `No item matches “${query}”.`}
          </p>
        ) : null}
        {list?.pageInfo.hasMore ? (
          <div className="staff-card__head">
            <button
              className="button button--quiet"
              onClick={() => void loadMore()}
              disabled={busy}
            >
              Load more
            </button>
          </div>
        ) : null}
      </section>

      {draft ? (
        <Modal
          title={
            draft.kind === "receive"
              ? `Receive stock · ${draft.sku}`
              : draft.kind === "adjust"
                ? `Adjust count · ${draft.sku}`
                : `Transfer stock · ${draft.sku}`
          }
          onClose={() => setDraft(null)}
          onSave={submitDraft}
          busy={busy}
          saveLabel={
            draft.kind === "receive"
              ? "Receive"
              : draft.kind === "adjust"
                ? "Set count"
                : "Transfer"
          }
        >
          <p className="muted">{draft.productName}</p>
          {draft.kind === "receive" ? (
            <>
              <p className="muted">Into {locationName(draft.inventoryLocationId)}</p>
              <label className="field">
                Quantity received
                <input
                  inputMode="numeric"
                  value={draft.quantity}
                  onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                  placeholder="0"
                />
              </label>
              <label className="field">
                Supplier reference (optional)
                <input
                  value={draft.supplierReference}
                  onChange={(e) => setDraft({ ...draft, supplierReference: e.target.value })}
                />
              </label>
              <label className="field">
                Note (optional)
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          ) : draft.kind === "adjust" ? (
            <>
              <p className="muted">
                At {locationName(draft.inventoryLocationId)} · counting against version{" "}
                {draft.expectedVersion}
              </p>
              <label className="field">
                Counted quantity (new on-hand)
                <input
                  inputMode="numeric"
                  value={draft.countedQuantity}
                  onChange={(e) => setDraft({ ...draft, countedQuantity: e.target.value })}
                />
              </label>
              <label className="field">
                Note (optional)
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <p className="muted">From {locationName(draft.sourceInventoryLocationId)}</p>
              <label className="field">
                Destination
                <Select
                  ariaLabel="Destination"
                  placeholder="Choose destination"
                  value={draft.destinationInventoryLocationId}
                  onChange={(value) =>
                    setDraft({ ...draft, destinationInventoryLocationId: value })
                  }
                  options={transferTargets
                    .filter((loc) => loc.id !== draft.sourceInventoryLocationId)
                    .map((loc) => ({ value: loc.id, label: loc.displayName }))}
                />
              </label>
              <label className="field">
                Quantity to move
                <input
                  inputMode="numeric"
                  value={draft.quantity}
                  onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                  placeholder="0"
                />
              </label>
              <label className="field">
                Note (optional)
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </>
          )}
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
      <div className="staff-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
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
