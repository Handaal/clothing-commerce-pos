import {
  ApiHttpError,
  type CreateReturnInput,
  type ReturnDetailResponse,
  type SettleRefundInput,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";

export const CONNECTION_REQUIRED =
  "Connection is required to process a return/refund. Returns cannot be submitted offline.";
export type ReturnIntent = Omit<CreateReturnInput, "idempotencyKey">;

/** Memory-only connected commands. Never handed to the offline bridge or sales outbox. */
export class ReturnCommands {
  private creation: CreateReturnInput | null = null;
  private settlement: SettleRefundInput | null = null;
  private fingerprint = "";
  private inFlight: Promise<ReturnDetailResponse> | null = null;

  constructor(private readonly key: () => string = () => crypto.randomUUID()) {}

  newReturnIntent(): void {
    if (this.inFlight) throw new Error("Resolve the current return before changing intent.");
    this.creation = null;
    this.fingerprint = "";
  }

  create(
    client: TenantCommerceClient,
    intent: ReturnIntent,
    online: boolean,
  ): Promise<ReturnDetailResponse> {
    if (!online) return Promise.reject(new Error(CONNECTION_REQUIRED));
    if (this.inFlight) return this.inFlight;
    const fingerprint = JSON.stringify(intent);
    if (!this.creation || fingerprint !== this.fingerprint) {
      this.creation = structuredClone({ ...intent, idempotencyKey: this.key() });
      this.fingerprint = fingerprint;
    }
    const input = structuredClone(this.creation);
    return this.run(() => client.createReturn(input));
  }

  settle(
    client: TenantCommerceClient,
    returnId: string,
    settlementReference: string,
    online: boolean,
  ): Promise<ReturnDetailResponse> {
    if (!online) return Promise.reject(new Error(CONNECTION_REQUIRED));
    if (this.inFlight) return this.inFlight;
    if (
      !this.settlement ||
      this.settlement.returnId !== returnId ||
      this.settlement.settlementReference !== settlementReference
    ) {
      this.settlement = { returnId, settlementReference, idempotencyKey: this.key() };
    }
    const input = { ...this.settlement };
    return this.run(() => client.settleRefund(input));
  }

  private run(command: () => Promise<ReturnDetailResponse>): Promise<ReturnDetailResponse> {
    this.inFlight = Promise.resolve()
      .then(command)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

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
      "The return/refund result is unknown. Keep this screen open, reconnect, and retry the exact command. Do not hand back cash again.",
    uncertain: true,
  };
}
