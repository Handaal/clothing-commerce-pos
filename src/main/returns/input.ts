import type { ReturnIntent, ReturnSession } from "../../shared/returns";

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid return input.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("Unexpected return input field.");
  return input;
}
export function boundedText(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error("Invalid return text.");
  return value.trim();
}
export function uuid(value: unknown): string {
  const text = boundedText(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new Error("Invalid return identifier.");
  return text;
}
export function parseReturnSession(value: unknown): ReturnSession {
  const input = record(value, ["tenantId", "accessToken"]);
  return { tenantId: uuid(input.tenantId), accessToken: boundedText(input.accessToken, 16384) };
}
export function parseReturnIntent(value: unknown): ReturnIntent {
  const input = record(value, [
    "orderId",
    "lines",
    "inventoryLocationId",
    "refundMode",
    "settlementReference",
  ]);
  if (input.refundMode !== undefined && input.refundMode !== "pending")
    throw new Error("Create the pending return before recording cash settlement.");
  if (input.settlementReference != null)
    throw new Error("Settlement requires its own durable command.");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100)
    throw new Error("Invalid return lines.");
  const lines: ReturnIntent["lines"] = input.lines.map((raw) => {
    const line = record(raw, ["orderLineId", "quantity", "reason", "disposition"]);
    if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0)
      throw new Error("Invalid return quantity.");
    if (line.disposition !== "restock" && line.disposition !== "non_restock")
      throw new Error("Invalid disposition.");
    return {
      orderLineId: uuid(line.orderLineId),
      quantity: Number(line.quantity),
      reason: boundedText(line.reason, 500),
      disposition: line.disposition,
    };
  });
  if (new Set(lines.map((line) => line.orderLineId)).size !== lines.length)
    throw new Error("Duplicate return line.");
  const location = input.inventoryLocationId == null ? null : uuid(input.inventoryLocationId);
  if (lines.some((line) => line.disposition === "restock") !== (location !== null))
    throw new Error("Restock destination is invalid.");
  return {
    orderId: uuid(input.orderId),
    lines,
    inventoryLocationId: location,
    refundMode: "pending",
    settlementReference: null,
  };
}
