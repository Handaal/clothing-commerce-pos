import type {
  CreatePosSaleInput,
  CreatePosSaleResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };

import type {
  ConnectedSaleError,
  ConnectedSaleIntent,
  ConnectedSaleOutcome,
  ConnectedSaleSession,
  SalesBridge,
} from "../../shared/sales";
import { ConnectedSaleStore, type ConnectedSaleRow } from "./store";

export interface ConnectedSaleServiceOptions {
  networkOnline?: () => boolean;
  /** Test seam to build the tenant client (and observe transport). Never exposed through IPC. */
  clientFactory?: (session: ConnectedSaleSession) => Promise<TenantCommerceClient>;
  /** Test-only crash seam invoked after the server responds but before acceptance is recorded. */
  afterResponse?: (row: ConnectedSaleRow, receipt: CreatePosSaleResponse) => void;
}

/**
 * Owns the durable connected-sale journal and drives the persist-before-send / replay-on-recovery
 * state machine. The idempotency key lives in SQLite (never renderer memory), so process death can
 * never cause the same economic sale to be dispatched under a fresh key.
 */
export class ConnectedSaleService implements SalesBridge {
  private busy = false;

  constructor(
    private readonly store: ConnectedSaleStore,
    private readonly apiBaseUrl: string,
    private readonly options: ConnectedSaleServiceOptions = {},
  ) {}

  async hasPending(): Promise<boolean> {
    return this.store.active() !== null;
  }

  async submit(
    session: ConnectedSaleSession,
    intent: ConnectedSaleIntent,
  ): Promise<ConnectedSaleOutcome> {
    return this.guard(async () => {
      const client = await this.authorize(session);
      const active = this.store.active();
      if (active) {
        // Never mint a second command while one is unresolved. Resolve the outstanding one instead.
        if (active.stage === "accepted")
          return { status: "accepted", workflowId: active.id, receipt: this.store.receipt(active) };
        return this.execute(client, active, false);
      }
      const row = this.store.prepare(
        { apiBaseUrl: this.apiBaseUrl, tenantId: session.tenantId },
        intent,
      );
      return this.execute(client, row, true);
    });
  }

  async recover(session: ConnectedSaleSession): Promise<ConnectedSaleOutcome | null> {
    const active = this.store.active();
    if (!active) return null;
    return this.guard(async () => {
      const row = this.store.active();
      if (!row) return null;
      if (row.stage === "accepted")
        return { status: "accepted", workflowId: row.id, receipt: this.store.receipt(row) };
      const client = await this.authorize(session);
      return this.execute(client, row, false);
    });
  }

  async acknowledge(session: ConnectedSaleSession, workflowId: string): Promise<void> {
    // A local, network-free write: the cashier saw the receipt. Scope-checked, never destructive.
    const row = this.store.get(workflowId);
    if (row.tenant_id !== session.tenantId)
      throw new Error("The connected sale belongs to another business session.");
    this.store.acknowledge(workflowId);
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("A connected sale operation is already running.");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private async authorize(session: ConnectedSaleSession): Promise<TenantCommerceClient> {
    if (this.options.networkOnline?.() === false) throw new Error("CONNECTION_REQUIRED");
    if (this.options.clientFactory) return this.options.clientFactory(session);
    const sdk = await import("@shifted/clothing-commerce-sdk");
    return sdk
      .createCommerceClient({
        baseUrl: this.apiBaseUrl,
        client: { type: "pos-desktop", version: "0.1.0" },
        getToken: () => session.accessToken,
      })
      .withTenant(session.tenantId);
  }

  private async execute(
    client: TenantCommerceClient,
    row: ConnectedSaleRow,
    firstAttempt: boolean,
  ): Promise<ConnectedSaleOutcome> {
    const command = this.store.command(row);
    let receipt: CreatePosSaleResponse;
    try {
      receipt = await client.createPosSale(command as CreatePosSaleInput);
    } catch (error) {
      const classified = await this.classify(error);
      // Only a definite first-attempt rejection (server did not commit) may close the workflow.
      // Any replay, or any uncertain outcome, keeps the command unresolved for a safe re-attempt.
      if (firstAttempt && !classified.uncertain) {
        this.store.reject(row.id, classified.code);
        return { status: "rejected", workflowId: row.id, error: classified };
      }
      return { status: "ambiguous", workflowId: row.id, error: classified };
    }
    this.options.afterResponse?.(row, receipt);
    const accepted = this.store.markAccepted(row.id, receipt);
    return { status: "accepted", workflowId: accepted.id, receipt: this.store.receipt(accepted) };
  }

  private async classify(error: unknown): Promise<ConnectedSaleError> {
    const { ApiHttpError, ApiNetworkError, ApiContractError } =
      await import("@shifted/clothing-commerce-sdk");
    if (error instanceof ApiNetworkError) {
      return {
        kind: "network",
        code: "NETWORK_ERROR",
        message: "The sale result is unknown because the API could not be reached.",
        authoritativeTotalMinor: null,
        uncertain: true,
      };
    }
    if (error instanceof ApiContractError) {
      return {
        kind: "contract",
        code: "CONTRACT_ERROR",
        message: "The API returned an unexpected response; the sale result is unknown.",
        authoritativeTotalMinor: null,
        uncertain: true,
      };
    }
    if (error instanceof ApiHttpError) {
      const http = error as unknown as {
        status: number;
        code: string;
        message: string;
        details?: Array<{ path: string[]; value: unknown }>;
      };
      // Ambiguous: the server may have committed. Retain and replay with the same key.
      if (
        http.status >= 500 ||
        http.status === 408 ||
        http.status === 425 ||
        http.status === 429 ||
        http.code === "IDEMPOTENCY_CONFLICT"
      ) {
        return {
          kind: http.code === "IDEMPOTENCY_CONFLICT" ? "conflict" : "server",
          code: http.code,
          message: http.message,
          authoritativeTotalMinor: null,
          uncertain: true,
        };
      }
      // Definite rejections: the server did not commit.
      if (http.code === "PRICE_CHANGED" || http.code === "CURRENCY_CHANGED") {
        return {
          kind: "price-changed",
          code: http.code,
          message: "The price changed. Review and confirm the refreshed total.",
          authoritativeTotalMinor: authoritativeTotal(http.details),
          uncertain: false,
        };
      }
      if (http.code === "PROMOTION_UNAVAILABLE") {
        return {
          kind: "promotion",
          code: http.code,
          message: "The promotion is no longer available. Review and confirm the refreshed total.",
          authoritativeTotalMinor: null,
          uncertain: false,
        };
      }
      if (http.code === "INSUFFICIENT_STOCK") {
        return {
          kind: "inventory",
          code: http.code,
          message: "There is not enough inventory to complete this sale.",
          authoritativeTotalMinor: null,
          uncertain: false,
        };
      }
      if (http.status === 401)
        return {
          kind: "auth",
          code: http.code,
          message: "Your session is no longer valid. Sign in again.",
          authoritativeTotalMinor: null,
          uncertain: false,
        };
      if (http.status === 403)
        return {
          kind: "forbidden",
          code: http.code,
          message: "You are not authorized to perform this action.",
          authoritativeTotalMinor: null,
          uncertain: false,
        };
      return {
        kind: http.status === 400 ? "validation" : "server",
        code: http.code,
        message: http.message,
        authoritativeTotalMinor: null,
        uncertain: false,
      };
    }
    // Unknown/local error before a definite server verdict — treat as uncertain to fail safe.
    return {
      kind: "server",
      code: "UNKNOWN_ERROR",
      message: error instanceof Error ? error.message : "An unexpected error occurred.",
      authoritativeTotalMinor: null,
      uncertain: true,
    };
  }
}

function authoritativeTotal(
  details: Array<{ path: string[]; value: unknown }> | undefined,
): number | null {
  const value = details?.find((detail) => detail.path.includes("expectedTotalMinor"))?.value;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}
