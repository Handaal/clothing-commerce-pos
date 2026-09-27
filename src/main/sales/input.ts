import type { ConnectedSaleIntent, ConnectedSaleSession } from "../../shared/sales";

function boundedString(value: unknown, field: string, maximumLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value as number;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value as number;
}

export function parseConnectedSaleSession(value: unknown): ConnectedSaleSession {
  if (!value || typeof value !== "object")
    throw new TypeError("Connected sale session is invalid.");
  const input = value as Record<string, unknown>;
  return {
    tenantId: boundedString(input.tenantId, "tenantId"),
    accessToken: boundedString(input.accessToken, "accessToken", 16_384),
  };
}

export function parseConnectedSaleIntent(value: unknown): ConnectedSaleIntent {
  if (!value || typeof value !== "object") throw new TypeError("Connected sale intent is invalid.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new TypeError("Connected sale lines are invalid.");
  }
  const promotionCode =
    input.promotionCode === undefined || input.promotionCode === null
      ? undefined
      : boundedString(input.promotionCode, "promotionCode");
  return {
    registerId: boundedString(input.registerId, "registerId"),
    expectedTotalMinor: safeNonNegativeInteger(input.expectedTotalMinor, "expectedTotalMinor"),
    cashReceivedMinor: safeNonNegativeInteger(input.cashReceivedMinor, "cashReceivedMinor"),
    lines: input.lines.map((raw) => {
      if (!raw || typeof raw !== "object") throw new TypeError("Connected sale line is invalid.");
      const line = raw as Record<string, unknown>;
      return {
        variantId: boundedString(line.variantId, "variantId"),
        quantity: safePositiveInteger(line.quantity, "quantity"),
      };
    }),
    ...(promotionCode !== undefined ? { promotionCode } : {}),
  };
}
