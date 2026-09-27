import type {
  CreatePosSaleInput,
  CreatePosSaleResponse,
} from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

/** The connected sale intent minus the idempotency key, which the durable journal owns and retains. */
export type ConnectedSaleIntent = Omit<CreatePosSaleInput, "idempotencyKey">;

/** Operator session needed for the main process to build an authorized SDK client. */
export interface ConnectedSaleSession {
  readonly tenantId: string;
  readonly accessToken: string;
}

/**
 * Durable lifecycle of a connected sale command:
 *   prepared      — command + idempotency key persisted, dispatched or dispatching (ambiguous while
 *                   the transport result is unknown; survives process death here)
 *   accepted      — the server returned a canonical sale; response persisted, awaiting the cashier
 *   acknowledged  — the cashier has seen the receipt; terminal
 *   rejected      — the server definitively rejected the first attempt without committing; terminal
 */
export type ConnectedSaleStage = "prepared" | "accepted" | "acknowledged" | "rejected";

export interface ConnectedSaleError {
  /** Drives the renderer state machine (network/conflict/contract/server = unresolved-safe). */
  readonly kind: string;
  readonly code: string;
  readonly message: string;
  /** Authoritative total surfaced by a PRICE_CHANGED rejection, else null. */
  readonly authoritativeTotalMinor: number | null;
  /** True when the sale may have committed server-side; the command stays unresolved for replay. */
  readonly uncertain: boolean;
}

/**
 * Outcome of a submit/recover. `accepted` carries the canonical receipt and the durable workflow id
 * used to acknowledge it. `ambiguous` means the command is retained unresolved (replay with the same
 * key). `rejected` means the server did not commit and the workflow is closed.
 */
export type ConnectedSaleOutcome =
  | {
      readonly status: "accepted";
      readonly workflowId: string;
      readonly receipt: CreatePosSaleResponse;
    }
  | {
      readonly status: "ambiguous";
      readonly workflowId: string;
      readonly error: ConnectedSaleError;
    }
  | {
      readonly status: "rejected";
      readonly workflowId: string | null;
      readonly error: ConnectedSaleError;
    };

export interface SalesBridge {
  /** Whether an unresolved (prepared or accepted-but-unacknowledged) connected sale exists. */
  hasPending(): Promise<boolean>;
  /** Persist the command + idempotency key, then dispatch it. Blocks if one is already unresolved. */
  submit(session: ConnectedSaleSession, intent: ConnectedSaleIntent): Promise<ConnectedSaleOutcome>;
  /** Replay the retained unresolved command with its ORIGINAL key, or return null if none. */
  recover(session: ConnectedSaleSession): Promise<ConnectedSaleOutcome | null>;
  /** Record that the cashier acknowledged an accepted sale receipt; clears the workflow. */
  acknowledge(session: ConnectedSaleSession, workflowId: string): Promise<void>;
}

export const SALES_IPC_CHANNELS = Object.freeze({
  hasPending: "sales:has-pending",
  submit: "sales:submit",
  recover: "sales:recover",
  acknowledge: "sales:acknowledge",
});
