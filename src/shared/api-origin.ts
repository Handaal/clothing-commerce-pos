/**
 * Single canonical Commerce API origin contract shared by the Electron main process, the Vite
 * renderer build, and the release tooling. Keeping one validator here is what prevents the renderer
 * (build-time baked) and main (runtime) processes from silently resolving different origins.
 */

/** Development-only default. Never used to satisfy a production/packaged build. */
export const DEV_DEFAULT_API_ORIGIN = "http://localhost:3000";

/** Packaged runtime-config artifact shipped inside `dist-electron/` and read by the main process. */
export const RUNTIME_CONFIG_FILENAME = "runtime-config.json";

export interface RuntimeConfig {
  readonly commerceApiUrl: string;
}

/**
 * Validate and normalize a Commerce API origin. Throws on anything that is not a syntactically valid
 * absolute http/https URL. Trailing slashes are stripped so both processes compare byte-for-byte.
 */
export function normalizeApiOrigin(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw new Error("COMMERCE_API_URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`COMMERCE_API_URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`COMMERCE_API_URL must be an http(s) URL: ${trimmed}`);
  }
  return trimmed.replace(/\/+$/, "");
}

export type ResolutionMode = "development" | "production";

/**
 * Resolve the canonical origin from a candidate value. In production a missing/blank value fails
 * closed rather than silently falling back to localhost. In development the localhost default is
 * permitted so `pnpm dev` needs no configuration.
 */
export function resolveApiOrigin(input: {
  readonly value: string | undefined | null;
  readonly mode: ResolutionMode;
}): string {
  const candidate = typeof input.value === "string" ? input.value.trim() : "";
  if (candidate) return normalizeApiOrigin(candidate);
  if (input.mode === "development") return DEV_DEFAULT_API_ORIGIN;
  throw new Error(
    "COMMERCE_API_URL is required for a production build and no value was configured. " +
      "Set it before building the release so the packaged app has one canonical API origin.",
  );
}

/** Validate a parsed runtime-config artifact, returning the normalized origin. */
export function readRuntimeConfigOrigin(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object" || !("commerceApiUrl" in parsed)) {
    throw new Error("Packaged runtime configuration is missing commerceApiUrl.");
  }
  const value = (parsed as { commerceApiUrl: unknown }).commerceApiUrl;
  if (typeof value !== "string") {
    throw new Error("Packaged runtime configuration commerceApiUrl must be a string.");
  }
  return normalizeApiOrigin(value);
}
