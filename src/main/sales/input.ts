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

const TENDER_METHODS = new Set(["cash", "card", "instapay", "wallet"]);

// Split tender: one or more cashier-confirmed payment lines. The cash tender may carry the physical
// cash received for change. The API re-derives and validates amounts/change; this only guards the shape
// so the durable, replayable command never persists a malformed payment.
function parseTenders(value: unknown): NonNullable<ConnectedSaleIntent["tenders"]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError("tenders is invalid.");
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new TypeError("tender is invalid.");
    const tender = raw as Record<string, unknown>;
    if (typeof tender.method !== "string" || !TENDER_METHODS.has(tender.method)) {
      throw new TypeError("tender.method is invalid.");
    }
    return {
      method: tender.method as "cash" | "card" | "instapay" | "wallet",
      amountMinor: safeNonNegativeInteger(tender.amountMinor, "tender.amountMinor"),
      ...(tender.cashReceivedMinor === undefined
        ? {}
        : {
            cashReceivedMinor: safeNonNegativeInteger(
              tender.cashReceivedMinor,
              "tender.cashReceivedMinor",
            ),
          }),
    };
  });
}

function parseCustomer(value: unknown): { name: string; phone: string } {
  if (!value || typeof value !== "object") throw new TypeError("customer is invalid.");
  const customer = value as Record<string, unknown>;
  return {
    name: boundedString(customer.name, "customer.name"),
    phone: boundedString(customer.phone, "customer.phone"),
  };
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
  // Split tender (preferred) and/or a single cash-received amount; both are optional in the SDK
  // contract, but a sale with neither has no payment and must never be persisted as a durable command.
  const tenders =
    input.tenders === undefined || input.tenders === null ? undefined : parseTenders(input.tenders);
  const cashReceivedMinor =
    input.cashReceivedMinor === undefined || input.cashReceivedMinor === null
      ? undefined
      : safeNonNegativeInteger(input.cashReceivedMinor, "cashReceivedMinor");
  if (tenders === undefined && cashReceivedMinor === undefined) {
    throw new TypeError("Connected sale payment is invalid.");
  }
  const customer =
    input.customer === undefined || input.customer === null
      ? undefined
      : parseCustomer(input.customer);
  return {
    registerId: boundedString(input.registerId, "registerId"),
    expectedTotalMinor: safeNonNegativeInteger(input.expectedTotalMinor, "expectedTotalMinor"),
    lines: input.lines.map((raw) => {
      if (!raw || typeof raw !== "object") throw new TypeError("Connected sale line is invalid.");
      const line = raw as Record<string, unknown>;
      return {
        variantId: boundedString(line.variantId, "variantId"),
        quantity: safePositiveInteger(line.quantity, "quantity"),
      };
    }),
    ...(tenders !== undefined ? { tenders } : {}),
    ...(cashReceivedMinor !== undefined ? { cashReceivedMinor } : {}),
    ...(promotionCode !== undefined ? { promotionCode } : {}),
    ...(customer !== undefined ? { customer } : {}),
  };
}
