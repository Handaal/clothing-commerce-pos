import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CachedCatalogItem,
  LocalIntent,
  OfflineBridge,
  OfflineIntentInput,
  OfflineIntentOperation,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { formatDateTime } from "../format";
import { useI18n } from "../shell/i18n";

/**
 * The desk actions this panel can capture offline. Only operations whose required references are
 * available on the device are offered: inventory actions pick from the cached catalog, settings
 * requests need no directory, and a device-revoke request targets THIS device. Supplier and staff
 * intents need supplier/role directories that are not cached on the till yet, so they are not offered
 * here (the signed lane itself supports them).
 */
export type DeskIntentOperation = Extract<
  OfflineIntentOperation,
  | "inventory.receive"
  | "inventory.adjust"
  | "inventory.count"
  | "settings.change_request"
  | "settings.device_revoke_request"
>;

const ADJUST_REASONS = ["damaged", "lost", "found", "correction", "other"] as const;

interface FormState {
  variantId: string;
  quantity: string;
  reference: string;
  reason: string;
  note: string;
  settingKey: string;
  requestedValue: string;
}

const EMPTY: FormState = {
  variantId: "",
  quantity: "",
  reference: "",
  reason: "",
  note: "",
  settingKey: "",
  requestedValue: "",
};

function toInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Builds the exact intent for the server schema, or null when the form is incomplete. */
export function buildDeskIntent(
  operation: DeskIntentOperation,
  form: FormState,
  context: { deviceId: string | null; advisory: ProjectedInventoryItem | undefined },
): OfflineIntentInput | null {
  const note = form.note.trim() === "" ? null : form.note.trim().slice(0, 500);
  const quantity = toInteger(form.quantity);
  const base = { baseVersion: null, dependsOnSyncCommandId: null };
  switch (operation) {
    case "inventory.receive":
      if (!form.variantId || quantity === null || quantity < 1) return null;
      return {
        ...base,
        operation,
        subjectId: form.variantId,
        payload: {
          variantId: form.variantId,
          quantity,
          supplierDocumentRef: form.reference.trim() === "" ? null : form.reference.trim(),
          note,
        },
      };
    case "inventory.adjust":
      if (!form.variantId || quantity === null || quantity === 0) return null;
      return {
        ...base,
        operation,
        subjectId: form.variantId,
        payload: { variantId: form.variantId, quantityDelta: quantity, reason: form.reason, note },
      };
    case "inventory.count":
      if (!form.variantId || quantity === null || quantity < 0) return null;
      return {
        ...base,
        operation,
        subjectId: form.variantId,
        // The advisory snapshot version is freshness evidence only — never canonical stock.
        baseVersion: context.advisory ? String(context.advisory.version) : null,
        payload: {
          variantId: form.variantId,
          countedQuantity: quantity,
          observedAdvisoryQuantity: context.advisory?.snapshotOnHand ?? null,
          note,
        },
      };
    case "settings.change_request":
      if (!/^[a-z][a-z0-9_.]*$/.test(form.settingKey.trim()) || form.reason.trim() === "")
        return null;
      return {
        ...base,
        operation,
        subjectId: null,
        payload: {
          settingKey: form.settingKey.trim(),
          requestedValue: form.requestedValue.slice(0, 500),
          reason: form.reason.trim(),
        },
      };
    case "settings.device_revoke_request":
      if (!context.deviceId || form.reason.trim() === "") return null;
      return {
        ...base,
        operation,
        subjectId: context.deviceId,
        payload: { targetDeviceId: context.deviceId, reason: form.reason.trim() },
      };
  }
}

/**
 * Offline capture of a desk action as a PROVISIONAL REQUEST. Shown only while the desk is offline and
 * only for operations the register's server policy enables. It never changes stock, settings or device
 * state on this till: it records a signed request that the server receives for review on reconnect.
 */
export function OfflineIntentPanel({
  operations,
  bridge = typeof window === "undefined" ? undefined : window.offline,
}: {
  operations: ReadonlyArray<DeskIntentOperation>;
  bridge?: OfflineBridge;
}) {
  const { t, locale } = useI18n();
  const [enabled, setEnabled] = useState<ReadonlyArray<OfflineIntentOperation>>([]);
  const [recent, setRecent] = useState<ReadonlyArray<LocalIntent>>([]);
  const [catalog, setCatalog] = useState<ReadonlyArray<CachedCatalogItem>>([]);
  const [inventory, setInventory] = useState<ReadonlyArray<ProjectedInventoryItem>>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [operation, setOperation] = useState<DeskIntentOperation | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const needsCatalog = operations.some((value) => value.startsWith("inventory."));
  const fetchState = useCallback(async () => {
    if (!bridge) return null;
    const [intents, readiness, items, stock] = await Promise.all([
      bridge.getLocalIntents(),
      bridge.getReadiness(),
      needsCatalog ? bridge.getCachedCatalog() : Promise.resolve([]),
      needsCatalog ? bridge.getProjectedInventory() : Promise.resolve([]),
    ]);
    return { intents, readiness, items, stock };
  }, [bridge, needsCatalog]);

  const apply = useCallback(
    (state: Awaited<ReturnType<typeof fetchState>>) => {
      if (!state) return;
      setEnabled(state.intents.enabledOperations);
      setRecent(
        state.intents.recent.filter((intent) => operations.includes(intent.operation as never)),
      );
      setDeviceId(state.readiness.ready ? state.readiness.deviceId : null);
      setCatalog(state.items);
      setInventory(state.stock);
    },
    [operations],
  );

  async function refresh() {
    apply(await fetchState());
  }

  useEffect(() => {
    let active = true;
    fetchState().then(
      (state) => {
        if (active) apply(state);
      },
      () => {
        if (active) setMessage({ tone: "error", text: t("intent.loadFailed") });
      },
    );
    return () => {
      active = false;
    };
  }, [fetchState, apply, t]);

  const available = useMemo(
    () => operations.filter((value) => enabled.includes(value)),
    [operations, enabled],
  );
  const advisory = inventory.find((item) => item.variantId === form.variantId);
  const intent = operation ? buildDeskIntent(operation, form, { deviceId, advisory }) : null;

  if (!bridge) return null;

  async function submit() {
    if (!bridge || !intent) return;
    setSaving(true);
    setMessage(null);
    try {
      await bridge.recordIntent(intent);
      setMessage({ tone: "ok", text: t("intent.saved") });
      setForm(EMPTY);
      setOperation(null);
      await refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error && error.message ? error.message : t("intent.saveFailed"),
      });
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.target.value })),
  });

  return (
    <section className="intent-panel" aria-labelledby="intent-panel-title">
      <h3 id="intent-panel-title">{t("intent.title")}</h3>
      <p className="intent-panel__honesty">{t("intent.honesty")}</p>
      {available.length === 0 ? (
        <p className="inline-state">{t("intent.noneEnabled")}</p>
      ) : (
        <div className="intent-actions" role="group" aria-label={t("intent.chooseAction")}>
          {available.map((value) => (
            <button
              key={value}
              className={`button ${operation === value ? "" : "button--quiet"}`}
              aria-pressed={operation === value}
              onClick={() => {
                setOperation(value);
                setForm({ ...EMPTY, reason: value === "inventory.adjust" ? "damaged" : "" });
                setMessage(null);
              }}
            >
              {t(`intent.op.${value}`)}
            </button>
          ))}
        </div>
      )}

      {operation ? (
        <form
          className="intent-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {operation.startsWith("inventory.") ? (
            <label>
              {t("intent.field.variant")}
              <select {...field("variantId")} required>
                <option value="">{t("intent.field.chooseVariant")}</option>
                {catalog.map((item) => (
                  <option key={item.variantId} value={item.variantId}>
                    {item.productName} · {item.sku}
                    {item.optionSummary ? ` · ${item.optionSummary}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {operation === "inventory.count" && advisory ? (
            <p className="intent-form__hint">
              {t("intent.field.advisory", { quantity: String(advisory.snapshotOnHand) })}
            </p>
          ) : null}
          {operation.startsWith("inventory.") ? (
            <label>
              {t(
                operation === "inventory.adjust"
                  ? "intent.field.delta"
                  : operation === "inventory.count"
                    ? "intent.field.counted"
                    : "intent.field.quantity",
              )}
              <input inputMode="numeric" {...field("quantity")} required />
            </label>
          ) : null}
          {operation === "inventory.receive" ? (
            <label>
              {t("intent.field.reference")}
              <input maxLength={200} {...field("reference")} />
            </label>
          ) : null}
          {operation === "inventory.adjust" ? (
            <label>
              {t("intent.field.reason")}
              <select {...field("reason")}>
                {ADJUST_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`intent.reason.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {operation === "settings.change_request" ? (
            <>
              <label>
                {t("intent.field.settingKey")}
                <input maxLength={100} {...field("settingKey")} required />
              </label>
              <label>
                {t("intent.field.requestedValue")}
                <input maxLength={500} {...field("requestedValue")} />
              </label>
            </>
          ) : null}
          {operation.startsWith("settings.") ? (
            <label>
              {t("intent.field.why")}
              <textarea maxLength={500} {...field("reason")} required />
            </label>
          ) : (
            <label>
              {t("intent.field.note")}
              <textarea maxLength={500} {...field("note")} />
            </label>
          )}
          {operation === "settings.device_revoke_request" ? (
            <p className="intent-form__hint">{t("intent.revokeHonesty")}</p>
          ) : null}
          <button className="button" type="submit" disabled={!intent || saving}>
            {t("intent.save")}
          </button>
        </form>
      ) : null}

      {message ? (
        <p className="inline-state" role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {recent.length > 0 ? (
        <>
          <h4>{t("intent.recent")}</h4>
          <ul className="intent-recent">
            {recent.slice(0, 10).map((item) => (
              <li key={item.localIntentId}>
                {t(`intent.op.${item.operation}`)} · {formatDateTime(item.acceptedAt, locale)} ·{" "}
                {t(
                  item.outboxState === "blocked"
                    ? "intent.state.blocked"
                    : item.disposition
                      ? `intent.state.${item.disposition}`
                      : item.lifecycle === "received"
                        ? "intent.state.received"
                        : "intent.state.queued",
                )}
                {item.dispositionCode ? ` (${item.dispositionCode})` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
