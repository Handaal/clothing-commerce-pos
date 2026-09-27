import { createCommerceClient } from "@shifted/clothing-commerce-sdk";

import { commerceApiBaseUrl } from "./config";

export type ConnectionStatus = "connected" | "unavailable";

export interface CheckApiStatusOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export async function checkApiStatus({
  baseUrl = commerceApiBaseUrl(),
  fetch,
}: CheckApiStatusOptions = {}): Promise<ConnectionStatus> {
  const client = createCommerceClient({
    baseUrl,
    client: { type: "pos-desktop", version: "0.1.0" },
    fetch,
  });

  try {
    await client.getHealth();
    return "connected";
  } catch {
    return "unavailable";
  }
}
