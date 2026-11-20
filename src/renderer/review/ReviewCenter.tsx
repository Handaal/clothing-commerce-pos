import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  OfflineBridge,
  ReviewItem,
  ReviewLane,
  ReviewQuery,
  ReviewStatus,
} from "../../shared/offline";
import { formatDateTime } from "../format";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";

const LANES: ReadonlyArray<ReviewLane | "all"> = [
  "all",
  "sale",
  "payment",
  "attendance",
  "return",
  "intent",
];
const STATUSES: ReadonlyArray<NonNullable<ReviewQuery["status"]>> = [
  "attention",
  "all",
  "queued",
  "syncing",
  "retry_wait",
  "blocked",
  "server_received",
  "accepted",
  "needs_review",
  "rejected",
  "policy_blocked",
];
const TONE: Record<ReviewStatus, string> = {
  queued: "review-status--info",
  syncing: "review-status--info",
  retry_wait: "review-status--warn",
  blocked: "review-status--bad",
  server_received: "review-status--info",
  accepted: "review-status--good",
  needs_review: "review-status--bad",
  rejected: "review-status--bad",
  policy_blocked: "review-status--warn",
};

function newActionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `act-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Shared review / reconciliation center for every offline lane (sales, customer payments, attendance,
 * returns, provisional intents). It reads only durable local state through the narrow preload bridge,
 * so it is restart-safe and works offline. It distinguishes local state from server state, never offers
 * to edit an accepted command or delete anything, and every action is idempotent (one action id per
 * attempt, reused until the main process records an outcome) and audited in the local ledger.
 */
export function ReviewCenter({
  bridge = typeof window === "undefined" ? undefined : window.offline,
}: {
  bridge?: OfflineBridge;
}) {
  const { t, locale } = useI18n();
  const [lane, setLane] = useState<ReviewLane | "all">("all");
  const [status, setStatus] = useState<NonNullable<ReviewQuery["status"]>>("attention");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ReadonlyArray<ReviewItem>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  const fetchItems = useCallback(
    () => (bridge ? bridge.getReviewItems({ lane, status, search }) : Promise.resolve([])),
    [bridge, lane, status, search],
  );

  const load = useCallback(async () => {
    try {
      setItems(await fetchItems());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [fetchItems]);

  // Poll durable local state; results are applied asynchronously and ignored after unmount.
  useEffect(() => {
    let active = true;
    const tick = () =>
      fetchItems().then(
        (value) => {
          if (!active) return;
          setItems(value);
          setFailed(false);
        },
        () => {
          if (active) setFailed(true);
        },
      );
    void tick();
    const timer = setInterval(() => void tick(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchItems]);

  const selected = useMemo(
    () => items.find((item) => `${item.lane}:${item.syncCommandId}` === selectedId) ?? null,
    [items, selectedId],
  );

  if (!bridge) return null;

  async function runRetry(item: ReviewItem) {
    if (!bridge) return;
    const actionId = pendingActionId ?? newActionId();
    setPendingActionId(actionId);
    setBusy(true);
    setMessage(null);
    try {
      const result = await bridge.reviewRetry({
        actionId,
        lane: item.lane,
        syncCommandId: item.syncCommandId,
      });
      setPendingActionId(null);
      setMessage(t(`review.outcome.${result.outcome}`));
      await load();
    } catch {
      // Keep the same action id so a retry of this click is idempotent in main.
      setMessage(t("review.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="review-center" aria-labelledby="review-center-title">
      <div className="section-heading">
        <h2 id="review-center-title">{t("review.title")}</h2>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("review.refresh")}
        </button>
      </div>
      <p className="review-center__intro">{t("review.intro")}</p>

      <div className="review-filters" role="search">
        <label>
          {t("review.filter.lane")}
          <Select<ReviewLane | "all">
            ariaLabel={t("review.filter.lane")}
            value={lane}
            onChange={setLane}
            options={LANES.map((value) => ({ value, label: t(`review.lane.${value}`) }))}
          />
        </label>
        <label>
          {t("review.filter.status")}
          <Select<NonNullable<ReviewQuery["status"]>>
            ariaLabel={t("review.filter.status")}
            value={status}
            onChange={setStatus}
            options={STATUSES.map((value) => ({ value, label: t(`review.status.${value}`) }))}
          />
        </label>
        <label>
          {t("review.filter.search")}
          <input
            type="search"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {failed ? (
        <p className="inline-state" role="alert">
          {t("review.loadFailed")}
        </p>
      ) : null}
      {message ? (
        <p className="inline-state" role="status">
          {message}
        </p>
      ) : null}

      {items.length === 0 && !failed ? (
        <p className="inline-state">{t("review.empty")}</p>
      ) : (
        <table className="review-table">
          <caption className="visually-hidden">{t("review.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("review.col.lane")}</th>
              <th scope="col">{t("review.col.item")}</th>
              <th scope="col">{t("review.col.status")}</th>
              <th scope="col">{t("review.col.saved")}</th>
              <th scope="col">{t("review.col.attempts")}</th>
              <th scope="col">{t("review.col.lastError")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const key = `${item.lane}:${item.syncCommandId}`;
              return (
                <tr key={key} aria-selected={key === selectedId}>
                  <td>{t(`review.lane.${item.lane}`)}</td>
                  <td>
                    <button
                      className="button button--link"
                      onClick={() => {
                        setSelectedId(key);
                        setPendingActionId(null);
                        setMessage(null);
                      }}
                    >
                      {item.lane === "intent" ? t(`intent.op.${item.label}`) : item.label}
                    </button>
                  </td>
                  <td>
                    <span className={`review-status ${TONE[item.status]}`}>
                      {t(`review.status.${item.status}`)}
                    </span>
                  </td>
                  <td>{formatDateTime(item.createdAt, locale)}</td>
                  <td>{item.attempts}</td>
                  <td>{item.lastErrorCode ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected ? (
        <article className="review-detail" aria-labelledby="review-detail-title">
          <h3 id="review-detail-title">
            {t(`review.lane.${selected.lane}`)} · {t(`review.status.${selected.status}`)}
          </h3>
          <p className="review-detail__meaning">{t(`review.meaning.${selected.status}`)}</p>
          <dl className="review-evidence">
            <dt>{t("review.field.localId")}</dt>
            <dd>{selected.localId}</dd>
            <dt>{t("review.field.syncCommandId")}</dt>
            <dd>{selected.syncCommandId}</dd>
            <dt>{t("review.field.serverId")}</dt>
            <dd>{selected.serverIngestionId ?? t("review.field.notYet")}</dd>
            <dt>{t("review.field.serverReceivedAt")}</dt>
            <dd>
              {selected.serverReceivedAt
                ? formatDateTime(selected.serverReceivedAt, locale)
                : t("review.field.notYet")}
            </dd>
            <dt>{t("review.field.updatedAt")}</dt>
            <dd>{formatDateTime(selected.updatedAt, locale)}</dd>
            <dt>{t("review.field.payloadHash")}</dt>
            <dd className="review-evidence__mono">{selected.payloadHash.slice(0, 16)}…</dd>
            {selected.lastErrorMessage ? (
              <>
                <dt>{t("review.field.lastError")}</dt>
                <dd>
                  {selected.lastErrorCode}: {selected.lastErrorMessage}
                </dd>
              </>
            ) : null}
            {selected.evidence.map((entry) => (
              <FragmentRow key={entry.key} label={entry.key} value={entry.value} />
            ))}
          </dl>

          {selected.actions.length > 0 ? (
            <>
              <h4>{t("review.history")}</h4>
              <ul className="review-history">
                {selected.actions.map((action) => (
                  <li key={action.actionId}>
                    {formatDateTime(action.createdAt, locale)} —{" "}
                    {t(`review.action.${action.action}`)}
                    {": "}
                    {t(`review.outcome.${action.outcome}`)}
                    {action.note ? ` — ${action.note}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {selected.allowedActions.length === 0 ? (
            <p className="inline-state">{t("review.noActions")}</p>
          ) : null}
          {selected.allowedActions.includes("retry") ? (
            <button className="button" disabled={busy} onClick={() => void runRetry(selected)}>
              {t("review.retry")}
            </button>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <>
      <dt>{t(`review.evidence.${label}`)}</dt>
      <dd>{value}</dd>
    </>
  );
}
