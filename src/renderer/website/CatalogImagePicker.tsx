import type {
  CatalogImage,
  CatalogImageInput,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { useState } from "react";

import { useI18n } from "../shell/i18n";
import { describeWebsiteError } from "./errors";
import { uploadErrorKey, uploadImage } from "./image-upload";

export type CatalogImageClient = Pick<TenantCommerceClient, "createCatalogImageIntent">;

/**
 * SDK 0.53: choose / replace / remove the website image of a collection (cover) or category (tile).
 * Uploads to the server-chosen "<tenant>/catalog/" destination, then `onSave` stores it (null = remove;
 * the website then uses a product photo). The description (alt text) is saved with the image.
 */
export function CatalogImagePicker({
  client,
  label,
  hint,
  image,
  onSave,
  fetchImpl = globalThis.fetch.bind(globalThis),
  testId,
}: {
  client: CatalogImageClient;
  label: string;
  hint: string;
  image: CatalogImage | null | undefined;
  onSave: (image: CatalogImageInput | null) => Promise<void>;
  fetchImpl?: typeof globalThis.fetch;
  testId: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alt, setAlt] = useState(image?.altText ?? "");

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      const key = uploadErrorKey(err);
      setError(key ? t(key) : describeWebsiteError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field settings-grid__wide" data-testid={testId}>
      <strong>{label}</strong>
      <small className="muted">{hint}</small>
      <span className="muted" data-testid={`${testId}-state`}>
        {image ? t("website.img.saved", { path: image.path }) : t("website.img.none")}
      </span>
      <div className="button-row">
        <label className="button button--quiet">
          {busy ? t("website.saving") : image ? t("website.img.replace") : t("website.img.choose")}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            hidden
            disabled={busy}
            data-testid={`${testId}-file`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void run(async () => {
                const saved = await uploadImage(
                  file,
                  (body) => client.createCatalogImageIntent(body),
                  fetchImpl,
                );
                await onSave({ ...saved, altText: alt.trim() || null });
              });
            }}
          />
        </label>
        {image ? (
          <button
            type="button"
            className="link link--danger"
            disabled={busy}
            data-testid={`${testId}-remove`}
            onClick={() => void run(() => onSave(null))}
          >
            {t("website.img.remove")}
          </button>
        ) : null}
      </div>
      {image ? (
        <label className="field">
          {t("website.home.imageAlt")}
          <input
            value={alt}
            disabled={busy}
            data-testid={`${testId}-alt`}
            onChange={(event) => setAlt(event.target.value)}
          />
          {alt.trim() !== (image.altText ?? "") ? (
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              data-testid={`${testId}-alt-save`}
              onClick={() =>
                void run(() =>
                  onSave({ bucket: image.bucket, path: image.path, altText: alt.trim() || null }),
                )
              }
            >
              {t("website.img.saveAlt")}
            </button>
          ) : null}
        </label>
      ) : null}
      {error ? (
        <span className="website-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
