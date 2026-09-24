import type {
  CreatePosSaleInput,
  CreatePosSaleResponse,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";

import {
  authoritativePrice,
  classifyCommerceError,
  type CommerceErrorView,
} from "../commerce/errors";

/**
 * The connected sale intent. `promotionCode` threads the optional entered-code intent supported by SDK
 * 0.12.0; automatic promotions carry no code and are re-evaluated by the server. The SDK 0.12.0 runtime
 * accepts `promotionCode` on the POS sale request, so it is added here without hand-copying the DTO.
 */
export type SaleIntent = Omit<CreatePosSaleInput, "idempotencyKey"> & {
  readonly promotionCode?: string | null;
};

type SalePayload = CreatePosSaleInput & { readonly promotionCode?: string | null };

export type SaleExecutionState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "ambiguous"; error: CommerceErrorView }
  | { phase: "price-changed"; error: CommerceErrorView; authoritativeTotalMinor: number | null }
  | { phase: "promotion-changed"; error: CommerceErrorView }
  | { phase: "error"; error: CommerceErrorView }
  | { phase: "success"; receipt: CreatePosSaleResponse };

interface SaleOperation {
  readonly input: SalePayload;
}

export class SaleExecutor {
  private state: SaleExecutionState = { phase: "idle" };
  private operation: SaleOperation | null = null;
  private lifecycle = 0;
  private readonly listeners = new Set<(state: SaleExecutionState) => void>();

  constructor(private readonly createKey: () => string = () => crypto.randomUUID()) {}

  snapshot(): SaleExecutionState {
    return this.state;
  }

  subscribe(listener: (state: SaleExecutionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(client: TenantCommerceClient, intent: SaleIntent): boolean {
    if (this.state.phase === "submitting") return false;
    this.lifecycle += 1;
    this.operation = { input: { ...intent, idempotencyKey: this.createKey() } };
    void this.run(client, this.lifecycle);
    return true;
  }

  retry(client: TenantCommerceClient): boolean {
    if (this.state.phase !== "ambiguous" || this.operation === null) return false;
    this.lifecycle += 1;
    void this.run(client, this.lifecycle);
    return true;
  }

  invalidate(): void {
    this.lifecycle += 1;
    this.operation = null;
    this.emit({ phase: "idle" });
  }

  reset(): void {
    this.invalidate();
  }

  private emit(state: SaleExecutionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private async run(client: TenantCommerceClient, lifecycle: number): Promise<void> {
    const operation = this.operation;
    if (operation === null) return;
    this.emit({ phase: "submitting" });
    try {
      const receipt = await client.createPosSale(operation.input);
      if (lifecycle !== this.lifecycle || operation !== this.operation) return;
      this.operation = null;
      this.emit({ phase: "success", receipt });
    } catch (error) {
      if (lifecycle !== this.lifecycle || operation !== this.operation) return;
      const view = classifyCommerceError(error);
      if (view.kind === "network") {
        this.emit({ phase: "ambiguous", error: view });
        return;
      }
      this.operation = null;
      if (view.kind === "price-changed") {
        this.emit({
          phase: "price-changed",
          error: view,
          authoritativeTotalMinor: authoritativePrice(error),
        });
      } else if (view.kind === "promotion") {
        this.emit({ phase: "promotion-changed", error: view });
      } else {
        this.emit({ phase: "error", error: view });
      }
    }
  }
}
