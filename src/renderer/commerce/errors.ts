import { ApiContractError, ApiHttpError, ApiNetworkError } from "@shifted/clothing-commerce-sdk";

export type CommerceErrorKind =
  | "auth"
  | "forbidden"
  | "validation"
  | "inventory"
  | "price-changed"
  | "promotion"
  | "conflict"
  | "network"
  | "contract"
  | "server";

export interface CommerceErrorView {
  kind: CommerceErrorKind;
  code: string;
  message: string;
  retryable: boolean;
}

export function classifyCommerceError(error: unknown): CommerceErrorView {
  if (error instanceof ApiNetworkError) {
    return {
      kind: "network",
      code: "NETWORK_ERROR",
      message: "The sale result is unknown because the API could not be reached.",
      retryable: true,
    };
  }
  if (error instanceof ApiContractError) {
    return {
      kind: "contract",
      code: "CONTRACT_ERROR",
      message: "The API returned an unexpected response.",
      retryable: false,
    };
  }
  if (error instanceof ApiHttpError) {
    if (error.status === 401) {
      return {
        kind: "auth",
        code: error.code,
        message: "Your session is no longer valid. Sign in again.",
        retryable: false,
      };
    }
    if (error.status === 403) {
      return {
        kind: "forbidden",
        code: error.code,
        message: "You are not authorized to perform this action.",
        retryable: false,
      };
    }
    if (error.code === "PRICE_CHANGED" || error.code === "CURRENCY_CHANGED") {
      return {
        kind: "price-changed",
        code: error.code,
        message: "The price changed. Review and confirm the refreshed total.",
        retryable: false,
      };
    }
    if (error.code === "PROMOTION_UNAVAILABLE") {
      return {
        kind: "promotion",
        code: error.code,
        message: "The promotion is no longer available. Review and confirm the refreshed total.",
        retryable: false,
      };
    }
    if (error.code === "INSUFFICIENT_STOCK") {
      return {
        kind: "inventory",
        code: error.code,
        message: "There is not enough inventory to complete this sale.",
        retryable: false,
      };
    }
    if (error.status === 400) {
      return {
        kind: "validation",
        code: error.code,
        message:
          error.code === "INSUFFICIENT_CASH"
            ? "Cash received is not sufficient for the authoritative total."
            : error.message,
        retryable: false,
      };
    }
    if (error.status === 409) {
      return {
        kind: "conflict",
        code: error.code,
        message:
          error.code === "IDEMPOTENCY_CONFLICT"
            ? "This sale key was already used for different sale details. Start a new attempt."
            : error.message,
        retryable: false,
      };
    }
    return {
      kind: "server",
      code: error.code,
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  return {
    kind: "server",
    code: "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : "An unexpected error occurred.",
    retryable: false,
  };
}

export function authoritativePrice(error: unknown): number | null {
  if (!(error instanceof ApiHttpError) || error.code !== "PRICE_CHANGED") return null;
  const value = error.details?.find((detail) => detail.path.includes("expectedTotalMinor"))?.value;
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : null;
}
