import { ApiHttpError } from "@shifted/clothing-commerce-sdk";
export type { ReturnIntent } from "../../shared/returns";
export const CONNECTION_REQUIRED =
  "Connection is required to process a return/refund. Returns cannot be submitted offline.";

export function returnFailure(error: unknown): { message: string; uncertain: boolean } {
  if (error instanceof ApiHttpError && error.status < 500) {
    const messages: Record<string, string> = {
      RETURN_QUANTITY_EXCEEDED:
        "Remaining return eligibility changed. Refresh the order before trying again.",
      IDEMPOTENCY_CONFLICT:
        "This return intent conflicts with a previously submitted command. Review the order's return history before starting another return.",
    };
    return {
      message:
        messages[error.code] ??
        (error.status === 403
          ? "You are not authorized to perform this return/refund action."
          : error.status === 401
            ? "Your session expired. Restore your connection and session before retrying."
            : error.message),
      uncertain: error.code === "IDEMPOTENCY_CONFLICT",
    };
  }
  return {
    message:
      "The return/refund result is unknown. Reconnect and recover the saved command. Do not hand back cash again.",
    uncertain: true,
  };
}
