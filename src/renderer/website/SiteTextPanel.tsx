import {
  buildSiteTextRequest,
  defaultSiteTextList,
  isSiteTextFormDirty,
  SITE_TEXT_FIELDS,
  SITE_TEXT_GROUPS,
  siteTextIssueMessage,
  siteTextPlaceholder,
  siteTextToForm,
  validateSiteTextForm,
  type SiteTextFaqItem,
  type SiteTextForm,
  type SiteTextIssues,
  type SiteTextLanguage,
  type SiteTextListKey,
  type SiteTextSection,
  type SiteTextTextKey,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../shell/i18n";
import { SkeletonLines } from "../shell/Skeleton";
import { useToast } from "../shell/Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeWebsiteError } from "./errors";
import { PanelHead } from "./PanelHead";

export type SiteTextClient = Pick<
  TenantCommerceClient,
  "getStorefrontSiteText" | "updateStorefrontSiteText"
>;

// Site text (SDK 0.52): every piece of website copy outside the catalog and the home hero — promo bar,
// home section titles, brand note, sign-up box, footer, search title/description, contact details and
// the FAQ / Terms / Shipping & returns pages. Fields, limits and their English/Arabic labels come from
// the SDK (shared with Admin Mobile), so both apps edit exactly the same document. A blank field keeps
// the website's built-in text (shown as the placeholder). Authorized by catalog.author on the server.
export function SiteTextPanel({ client }: { client: SiteTextClient }) {
  const { t, lang } = useI18n();
  const language: SiteTextLanguage = lang === "ar" ? "ar" : "en";
  const toast = useToast();
  const [saved, setSaved] = useState<SiteTextForm | null>(null);
  const [form, setForm] = useState<SiteTextForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issues, setIssues] = useState<SiteTextIssues>({});
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setForm(null);
    try {
      const result = await client.getStorefrontSiteText();
      const next = siteTextToForm(result.siteText);
      setSaved(next);
      setForm(next);
    } catch (err) {
      setLoadError(describeWebsiteError(err, t));
    }
  }, [client, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading transition for an external read
    void load();
  }, [load]);

  if (loadError) {
    return (
      <div className="notice notice--error" role="alert">
        <span>{loadError}</span>
        <button className="button button--quiet" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!form || !saved) return <SkeletonLines lines={6} label={t("website.siteText.loading")} />;

  const current = form;
  const dirty = isSiteTextFormDirty(current, saved);

  function setText(key: SiteTextTextKey, value: string) {
    setForm((f) => (f ? { ...f, texts: { ...f.texts, [key]: value } } : f));
    setIssues((i) => ({ ...i, [key]: undefined }));
  }
  function setList(key: SiteTextListKey, value: SiteTextForm[SiteTextListKey]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setIssues((i) => ({ ...i, [key]: undefined }));
  }

  async function save() {
    const next = validateSiteTextForm(current);
    setIssues(next);
    if (Object.values(next).some(Boolean)) {
      toast.error(t("website.err.fixFields"));
      return;
    }
    setSaving(true);
    try {
      const result = await client.updateStorefrontSiteText({
        siteText: buildSiteTextRequest(current),
        idempotencyKey: crypto.randomUUID(),
      });
      const nextForm = siteTextToForm(result.siteText);
      setSaved(nextForm);
      setForm(nextForm);
      toast.success(t("website.siteText.saved"));
    } catch (err) {
      toast.error(describeWebsiteError(err, t));
    } finally {
      setSaving(false);
    }
  }

  const issueText = (key: SiteTextTextKey | SiteTextListKey) => {
    const issue = issues[key];
    return issue ? siteTextIssueMessage(issue, language) : null;
  };

  return (
    <>
      <p className="notice website-desk-intro">{t("website.siteText.intro")}</p>

      {SITE_TEXT_GROUPS.map((group) => (
        <section
          className="staff-card"
          key={group.id}
          data-testid={`website-site-text-${group.id}`}
        >
          <PanelHead title={group.label[language]} />
          <div className="settings-grid">
            {group.fields.map((key) => {
              const def = SITE_TEXT_FIELDS[key];
              if (def.kind === "messages" || def.kind === "faq" || def.kind === "sections") {
                const listKey = key as SiteTextListKey;
                return (
                  <ListEditor
                    key={key}
                    fieldKey={listKey}
                    label={def.label[language]}
                    hint={def.hint?.[language]}
                    value={current[listKey]}
                    onChange={(value) => setList(listKey, value)}
                    error={issueText(listKey)}
                    disabled={saving}
                  />
                );
              }
              const textKey = key as SiteTextTextKey;
              const multiline = def.kind === "multiline";
              const value = current.texts[textKey];
              const error = issueText(textKey);
              return (
                <label className={`field${multiline ? " settings-grid__wide" : ""}`} key={key}>
                  {def.label[language]}
                  {multiline ? (
                    <textarea
                      rows={3}
                      value={value}
                      placeholder={siteTextPlaceholder(textKey, current)}
                      disabled={saving}
                      data-testid={`website-site-text-${key}`}
                      onChange={(event) => setText(textKey, event.target.value)}
                    />
                  ) : (
                    <input
                      value={value}
                      type={def.kind === "email" ? "email" : "text"}
                      inputMode={def.kind === "phone" ? "numeric" : undefined}
                      placeholder={siteTextPlaceholder(textKey, current)}
                      disabled={saving}
                      data-testid={`website-site-text-${key}`}
                      onChange={(event) => setText(textKey, event.target.value)}
                    />
                  )}
                  <small className="muted">
                    {def.hint ? `${def.hint[language]} · ` : ""}
                    {value.trim().length}/{def.max}
                  </small>
                  {error ? (
                    <span className="website-field-error" role="alert">
                      {error}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </section>
      ))}

      <div className="website-savebar">
        {dirty ? <span className="pill pill--warn">{t("website.unsaved")}</span> : null}
        <button
          type="button"
          className="button button--quiet"
          disabled={!dirty || saving}
          onClick={() => setConfirmDiscard(true)}
        >
          {t("website.discard")}
        </button>
        <button
          type="button"
          className="button button--complete"
          disabled={saving || !dirty}
          data-testid="website-site-text-save"
          onClick={() => void save()}
        >
          {saving ? t("website.saving") : t("website.siteText.save")}
        </button>
      </div>

      {confirmDiscard ? (
        <ConfirmDialog
          title={t("website.discardTitle")}
          message={t("website.discardMessage")}
          confirmLabel={t("website.discard")}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setForm(saved);
            setIssues({});
            setConfirmDiscard(false);
          }}
        />
      ) : null}
    </>
  );
}

type ListValue = SiteTextForm[SiteTextListKey];

/** A list field: "built-in" until the owner customizes it; then add / edit / reorder / remove. */
function ListEditor({
  fieldKey,
  label,
  hint,
  value,
  onChange,
  error,
  disabled,
}: {
  fieldKey: SiteTextListKey;
  label: string;
  hint?: string | undefined;
  value: ListValue;
  onChange: (value: ListValue) => void;
  error: string | null;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const def = SITE_TEXT_FIELDS[fieldKey];
  const testId = `website-site-text-${fieldKey}`;

  if (value === null) {
    return (
      <div className="settings-grid__wide website-site-list" data-testid={testId}>
        <strong>{label}</strong>
        <p className="muted">{t("website.siteText.usingBuiltIn")}</p>
        {hint ? <small className="muted">{hint}</small> : null}
        <div className="button-row">
          <button
            type="button"
            className="button button--quiet"
            disabled={disabled}
            data-testid={`${testId}-customize`}
            onClick={() => onChange(defaultSiteTextList(fieldKey) as ListValue)}
          >
            {t("website.siteText.customize")}
          </button>
        </div>
      </div>
    );
  }

  const items = value as unknown[];
  const replace = (index: number, item: unknown) =>
    onChange(items.map((cur, i) => (i === index ? item : cur)) as ListValue);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next as ListValue);
  };
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index) as ListValue);
  const add = () =>
    onChange([
      ...items,
      def.kind === "messages"
        ? ""
        : def.kind === "faq"
          ? { question: "", answer: "" }
          : { heading: "", body: "" },
    ] as ListValue);

  return (
    <div className="settings-grid__wide website-site-list" data-testid={testId}>
      <strong>{label}</strong>
      {hint ? <small className="muted">{hint}</small> : null}
      {items.length === 0 ? (
        <p className="muted">
          {def.kind === "messages"
            ? t("website.siteText.emptyPromo")
            : t("website.siteText.emptyList")}
        </p>
      ) : null}
      {items.map((item, index) => (
        <div className="website-site-item" key={index} data-testid={`${testId}-item-${index}`}>
          {def.kind === "messages" ? (
            <label className="field">
              {t("website.siteText.message", { n: index + 1 })}
              <input
                value={item as string}
                disabled={disabled}
                data-testid={`${testId}-${index}`}
                onChange={(e) => replace(index, e.target.value)}
              />
            </label>
          ) : def.kind === "faq" ? (
            <>
              <label className="field">
                {t("website.siteText.question", { n: index + 1 })}
                <input
                  value={(item as SiteTextFaqItem).question}
                  disabled={disabled}
                  data-testid={`${testId}-${index}-a`}
                  onChange={(e) =>
                    replace(index, { ...(item as SiteTextFaqItem), question: e.target.value })
                  }
                />
              </label>
              <label className="field">
                {t("website.siteText.answer")}
                <textarea
                  rows={3}
                  value={(item as SiteTextFaqItem).answer}
                  disabled={disabled}
                  data-testid={`${testId}-${index}-b`}
                  onChange={(e) =>
                    replace(index, { ...(item as SiteTextFaqItem), answer: e.target.value })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                {t("website.siteText.heading", { n: index + 1 })}
                <input
                  value={(item as SiteTextSection).heading}
                  disabled={disabled}
                  data-testid={`${testId}-${index}-a`}
                  onChange={(e) =>
                    replace(index, { ...(item as SiteTextSection), heading: e.target.value })
                  }
                />
              </label>
              <label className="field">
                {t("website.siteText.body")}
                <textarea
                  rows={5}
                  value={(item as SiteTextSection).body}
                  disabled={disabled}
                  data-testid={`${testId}-${index}-b`}
                  onChange={(e) =>
                    replace(index, { ...(item as SiteTextSection), body: e.target.value })
                  }
                />
              </label>
            </>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button button--quiet"
              disabled={disabled || index === 0}
              data-testid={`${testId}-${index}-up`}
              onClick={() => move(index, -1)}
            >
              {t("website.siteText.moveUp")}
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={disabled || index === items.length - 1}
              data-testid={`${testId}-${index}-down`}
              onClick={() => move(index, 1)}
            >
              {t("website.siteText.moveDown")}
            </button>
            <button
              type="button"
              className="link link--danger"
              disabled={disabled}
              data-testid={`${testId}-${index}-remove`}
              onClick={() => remove(index)}
            >
              {t("website.siteText.remove")}
            </button>
          </div>
        </div>
      ))}
      {error ? (
        <span className="website-field-error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}
      <div className="button-row">
        {items.length < def.max ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={disabled}
            data-testid={`${testId}-add`}
            onClick={add}
          >
            {t("website.siteText.add")}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--quiet"
          disabled={disabled}
          data-testid={`${testId}-reset`}
          onClick={() => onChange(null)}
        >
          {t("website.siteText.useBuiltIn")}
        </button>
      </div>
    </div>
  );
}
