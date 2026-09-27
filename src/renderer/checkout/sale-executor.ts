import type {
  ConnectedSaleError,
  ConnectedSaleIntent,
  ConnectedSaleOutcome,
} from "../../shared/sales";
import type { CreatePosSaleResponse } from "@shifted/clothing-commerce-sdk";

/**
 * The connected sale intent. `promotionCode` threads the optional entered-code intent; automatic
 * promotions carry no code and are re-evaluated by the server. The idempotency key is owned by the
 * durable main-process journal, not this renderer state, so it survives process death.
 */
export type SaleIntent = ConnectedSaleIntent;

export type SaleExecutionState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "recovering" }
  | { phase: "ambiguous"; error: ConnectedSaleError }
  | { phase: "price-changed"; error: ConnectedSaleError; authoritativeTotalMinor: number | null }
  | { phase: "promotion-changed"; error: ConnectedSaleError }
  | { phase: "error"; error: ConnectedSaleError }
  | { phase: "success"; receipt: CreatePosSaleResponse; workflowId: string };

/**
 * Abstracts the durable connected-sale bridge (window.sales) so the executor is testable and never
 * talks to the SDK directly. Every method resolves against the main-process journal, which persists
 * the command and idempotency key BEFORE dispatch and replays the same key on recovery.
 */
export interface SalesGateway {
  hasPending(): Promise<boolean>;
  submit(intent: ConnectedSaleIntent): Promise<ConnectedSaleOutcome>;
  recover(): Promise<ConnectedSaleOutcome | null>;
  acknowledge(workflowId: string): Promise<void>;
}

export class SaleExecutor {
  private state: SaleExecutionState = { phase: "idle" };
  private acceptedWorkflowId: string | null = null;
  private lifecycle = 0;
  private readonly listeners = new Set<(state: SaleExecutionState) => void>();

  constructor(private readonly gateway: SalesGateway) {}

  snapshot(): SaleExecutionState {
    return this.state;
  }

  subscribe(listener: (state: SaleExecutionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private busy(): boolean {
    return this.state.phase === "submitting" || this.state.phase === "recovering";
  }

  /** Persist + dispatch a new connected sale. The durable journal owns the idempotency key. */
  submit(intent: SaleIntent): boolean {
    if (this.busy()) return false;
    const lifecycle = ++this.lifecycle;
    this.emit({ phase: "submitting" });
    void this.drive(lifecycle, () => this.gateway.submit(intent));
    return true;
  }

  /**
   * Replay the retained unresolved command with its ORIGINAL key. Used both for an in-session
   * ambiguous retry and for startup recovery. Never mints a new key.
   */
  recover(): boolean {
    if (this.busy()) return false;
    const lifecycle = ++this.lifecycle;
    this.emit({ phase: "recovering" });
    void (async () => {
      try {
        const outcome = await this.gateway.recover();
        if (lifecycle !== this.lifecycle) return;
        if (!outcome) {
          this.emit({ phase: "idle" });
          return;
        }
        this.apply(outcome);
      } catch (error) {
        if (lifecycle !== this.lifecycle) return;
        this.emit({ phase: "ambiguous", error: uncertainError(error) });
      }
    })();
    return true;
  }

  /** In-session retry of an ambiguous result: replays the same durable command/key. */
  retry(): boolean {
    if (this.state.phase !== "ambiguous") return false;
    return this.recover();
  }

  /** Acknowledge the accepted sale (cashier finished the receipt), then return to idle. */
  async acknowledge(): Promise<void> {
    const workflowId = this.acceptedWorkflowId;
    this.acceptedWorkflowId = null;
    this.lifecycle += 1;
    this.emit({ phase: "idle" });
    if (workflowId) await this.gateway.acknowledge(workflowId);
  }

  invalidate(): void {
    // Only meaningful for closed/idle states; ambiguous and accepted states lock the cart upstream.
    this.lifecycle += 1;
    this.acceptedWorkflowId = null;
    this.emit({ phase: "idle" });
  }

  reset(): void {
    this.invalidate();
  }

  private async drive(
    lifecycle: number,
    run: () => Promise<ConnectedSaleOutcome | null>,
  ): Promise<void> {
    try {
      const outcome = await run();
      if (lifecycle !== this.lifecycle) return;
      if (!outcome) {
        this.emit({ phase: "idle" });
        return;
      }
      this.apply(outcome);
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      // A thrown error (e.g. the IPC/transport itself) is uncertain: the command is retained.
      this.emit({ phase: "ambiguous", error: uncertainError(error) });
    }
  }

  private apply(outcome: ConnectedSaleOutcome): void {
    if (outcome.status === "accepted") {
      this.acceptedWorkflowId = outcome.workflowId;
      this.emit({ phase: "success", receipt: outcome.receipt, workflowId: outcome.workflowId });
      return;
    }
    if (outcome.status === "ambiguous") {
      this.emit({ phase: "ambiguous", error: outcome.error });
      return;
    }
    this.acceptedWorkflowId = null;
    if (outcome.error.kind === "price-changed") {
      this.emit({
        phase: "price-changed",
        error: outcome.error,
        authoritativeTotalMinor: outcome.error.authoritativeTotalMinor,
      });
    } else if (outcome.error.kind === "promotion") {
      this.emit({ phase: "promotion-changed", error: outcome.error });
    } else {
      this.emit({ phase: "error", error: outcome.error });
    }
  }

  private emit(state: SaleExecutionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function uncertainError(error: unknown): ConnectedSaleError {
  return {
    kind: "network",
    code: "SALE_RESULT_UNKNOWN",
    message:
      error instanceof Error
        ? error.message
        : "The sale result is unknown. Retry sends the exact same sale with the same key.",
    authoritativeTotalMinor: null,
    uncertain: true,
  };
}
