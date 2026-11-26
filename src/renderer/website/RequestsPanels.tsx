import type {
  ReturnRequest,
  SubscriberSummary,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { describeWebsiteError } from "./errors";
import { PanelHead } from "./PanelHead";

// Customer requests from the website (parity with Admin Mobile): return requests to approve / decline /
// complete (no stock or money moves — staff arrange the pickup), and drop-alert sign-ups. Both need
// orders.read; status changes are authorized by the server.

export type ReturnRequestsClient = Pick<
  TenantCommerceClient,
  "listReturnRequests" | "updateReturnRequestStatus"
>;
type Filter = "open" | "all";

export function ReturnRequestsPanel({ client }: { client: ReturnRequestsClient }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("open");
  const [items, setItems] = useState<ReturnRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      setItems((await client.listReturnRequests({ status: filter, limit: 100 })).requests);
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, filter, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  async function decide(request: ReturnRequest, status: "approved" | "declined" | "completed") {
    setBusyId(request.id);
    try {
      const note = notes[request.id]?.trim();
      await client.updateReturnRequestStatus({
        requestId: request.id,
        status,
        ...(note ? { note } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(t(`website.returns.done.${status}`));
      await load();
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="staff-card" data-testid="website-returns">
      <PanelHead
        title={t("website.tab.returns")}
        count={items?.length ?? null}
        intro={t("website.returns.intro")}
      >
        <div className="button-row">
          {(["open", "all"] as const).map((id) => (
            <button
              key={id}
              className={`report-tab${filter === id ? " report-tab--active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {t(`website.returns.filter.${id}`)}
            </button>
          ))}
        </div>
      </PanelHead>
      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : items === null ? (
        <SkeletonLines lines={3} label={t("website.returns.loading")} />
      ) : items.length === 0 ? (
        <p className="staff-empty">{t("website.returns.none")}</p>
      ) : (
        items.map((request) => (
          <div
            className="website-site-item"
            key={request.id}
            data-testid={`website-return-${request.reference}`}
          >
            <div className="button-row">
              <strong>
                {request.reference} · #{request.orderNumber}
              </strong>
              <span className="pill">{t(`website.returns.status.${request.status}`)}</span>
              <span className="muted">
                {new Date(request.createdAt).toLocaleString(locale)} ·{" "}
                {t(`website.returns.pref.${request.preference}`)}
              </span>
            </div>
            <span>{[request.customerName, request.customerPhone].filter(Boolean).join(" · ")}</span>
            <ul>
              {request.lines.map((line) => (
                <li key={line.lineNumber}>
                  {line.quantity} × {line.productName}
                  {line.optionSummary ? ` (${line.optionSummary})` : ""} —{" "}
                  {t(`website.returns.reason.${line.reason}`)}
                </li>
              ))}
            </ul>
            {request.customerNote ? <p className="muted">“{request.customerNote}”</p> : null}
            {request.staffNote ? (
              <p className="muted">
                {t("website.returns.staffNote")}: {request.staffNote}
              </p>
            ) : null}
            {request.status === "requested" || request.status === "approved" ? (
              <>
                <label className="field">
                  {t("website.returns.note")}
                  <input
                    value={notes[request.id] ?? ""}
                    data-testid={`website-return-note-${request.reference}`}
                    onChange={(e) => setNotes({ ...notes, [request.id]: e.target.value })}
                  />
                </label>
                <div className="button-row">
                  {request.status === "requested" ? (
                    <>
                      <button
                        type="button"
                        className="button button--complete"
                        disabled={busyId === request.id}
                        data-testid={`website-return-approve-${request.reference}`}
                        onClick={() => void decide(request, "approved")}
                      >
                        {t("website.returns.approve")}
                      </button>
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={busyId === request.id}
                        data-testid={`website-return-decline-${request.reference}`}
                        onClick={() => void decide(request, "declined")}
                      >
                        {t("website.returns.decline")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button button--complete"
                      disabled={busyId === request.id}
                      data-testid={`website-return-complete-${request.reference}`}
                      onClick={() => void decide(request, "completed")}
                    >
                      {t("website.returns.complete")}
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}

export type SignupsClient = Pick<TenantCommerceClient, "listSubscribers">;

export function SignupsPanel({ client }: { client: SignupsClient }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<{ subscribers: SubscriberSummary[]; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await client.listSubscribers({ limit: 1000 }));
    } catch (err) {
      setError(describeWebsiteError(err, t));
    }
  }, [client, t]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  function download() {
    if (!data) return;
    const csv = [
      "email,signed_up,source",
      ...data.subscribers.map((s) => `${s.email},${s.createdAt},${s.source}`),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "website-sign-ups.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.subscribers.map((s) => s.email).join("\n"));
      toast.success(t("website.signups.copied"));
    } catch {
      toast.error(t("website.signups.copyFailed"));
    }
  }

  return (
    <section className="staff-card" data-testid="website-signups">
      <PanelHead
        title={t("website.tab.signups")}
        count={data?.total ?? null}
        intro={t("website.signups.intro")}
      >
        {data && data.subscribers.length > 0 ? (
          <div className="button-row">
            <button type="button" className="button button--quiet" onClick={() => void copy()}>
              {t("website.signups.copy")}
            </button>
            <button
              type="button"
              className="button button--quiet"
              data-testid="website-signups-download"
              onClick={download}
            >
              {t("website.signups.download")}
            </button>
          </div>
        ) : null}
      </PanelHead>
      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button className="button button--quiet" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : data === null ? (
        <SkeletonLines lines={3} label={t("website.signups.loading")} />
      ) : data.subscribers.length === 0 ? (
        <p className="staff-empty">{t("website.signups.none")}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t("website.signups.email")}</th>
              <th>{t("website.signups.date")}</th>
            </tr>
          </thead>
          <tbody>
            {data.subscribers.map((s) => (
              <tr key={s.id}>
                <td>{s.email}</td>
                <td>{new Date(s.createdAt).toLocaleDateString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
