export const POS_CLIENT = { type: "pos-desktop", version: "0.1.0" } as const;

export function commerceApiBaseUrl(): string {
  const value = import.meta.env.COMMERCE_API_URL?.trim();
  if (!value) throw new Error("COMMERCE_API_URL is required.");
  return value.replace(/\/+$/, "");
}
