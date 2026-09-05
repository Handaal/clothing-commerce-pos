import {
  createCommerceClient,
  type CommerceClient,
  type TokenProvider,
} from "@shifted/clothing-commerce-sdk";

import { commerceApiBaseUrl, POS_CLIENT } from "../config";

export interface CommerceClientFactoryOptions {
  getToken: TokenProvider;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export type CommerceClientFactory = (options: CommerceClientFactoryOptions) => CommerceClient;

export const createConfiguredCommerceClient: CommerceClientFactory = ({
  getToken,
  baseUrl,
  fetch,
}) =>
  createCommerceClient({
    baseUrl: baseUrl ?? commerceApiBaseUrl(),
    client: POS_CLIENT,
    getToken,
    fetch,
  });
