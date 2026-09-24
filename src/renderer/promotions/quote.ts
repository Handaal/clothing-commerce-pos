import type { PosQuoteResponse, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

import { classifyCommerceError, type CommerceErrorView } from "../commerce/errors";

export interface QuoteBasket {
  readonly registerId: string;
  readonly lines: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
}

/**
 * The authoritative pricing view. Tender and checkout are permitted only in the `ready` status so the
 * cashier never settles against a stale or in-flight quote. `previous` is retained purely so the UI can
 * dim the last figures while a newer quote is loading; it is never used to authorize a sale.
 */
export type QuoteState =
  | { status: "idle" }
  | { status: "loading"; previous: PosQuoteResponse | null }
  | { status: "ready"; quote: PosQuoteResponse }
  | { status: "error"; error: CommerceErrorView; previous: PosQuoteResponse | null };

function signatureOf(basket: QuoteBasket, appliedCode: string | null): string {
  const lines = basket.lines
    .map((line) => `${line.variantId}:${line.quantity}`)
    .sort()
    .join(",");
  return `${basket.registerId}|${lines}|code=${appliedCode ?? ""}`;
}

/**
 * Requests server-authoritative connected-POS quotes for the current basket plus optional applied code.
 *
 * The controller keeps the typed code out entirely — callers pass only the *applied* (server-submitted)
 * code, so keystrokes in the code field never quote. Basket/code changes are coalesced through a short
 * debounce; each fired request carries a monotonic sequence and a basket signature, and a resolved
 * response is dropped unless it is still the latest for the current basket. That guarantees a slow
 * response for an older basket can never overwrite a newer one.
 */
export class QuoteController {
  private state: QuoteState = { status: "idle" };
  private seq = 0;
  private signature: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastGood: PosQuoteResponse | null = null;
  private readonly listeners = new Set<(state: QuoteState) => void>();

  constructor(private readonly delayMs = 250) {}

  snapshot(): QuoteState {
    return this.state;
  }

  subscribe(listener: (state: QuoteState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reconcile the controller with the current cashier state. Safe to call on every render/change; it
   * only schedules a network quote when the basket signature actually changes. `nonce` forces a fresh
   * quote for the same signature (used after a final-sale revalidation).
   */
  sync(
    client: TenantCommerceClient | null,
    basket: QuoteBasket | null,
    appliedCode: string | null,
    nonce = 0,
  ): void {
    if (!client || !basket || basket.lines.length === 0) {
      this.reset();
      return;
    }
    const signature = `${signatureOf(basket, appliedCode)}#${nonce}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.emit({ status: "loading", previous: this.lastGood });
    this.schedule(client, basket, appliedCode, signature);
  }

  /** Drop any in-flight quote and clear pricing. Used when the basket empties or connection is lost. */
  reset(): void {
    this.cancelTimer();
    this.seq += 1;
    this.signature = null;
    this.lastGood = null;
    if (this.state.status !== "idle") this.emit({ status: "idle" });
  }

  private schedule(
    client: TenantCommerceClient,
    basket: QuoteBasket,
    appliedCode: string | null,
    signature: string,
  ): void {
    this.cancelTimer();
    const seq = (this.seq += 1);
    const fire = () => void this.fire(client, basket, appliedCode, signature, seq);
    if (this.delayMs <= 0) {
      fire();
      return;
    }
    this.timer = setTimeout(fire, this.delayMs);
  }

  private async fire(
    client: TenantCommerceClient,
    basket: QuoteBasket,
    appliedCode: string | null,
    signature: string,
    seq: number,
  ): Promise<void> {
    try {
      const quote = await client.posQuote({
        registerId: basket.registerId,
        lines: basket.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        ...(appliedCode ? { promotionCode: appliedCode } : {}),
      });
      if (this.isStale(seq, signature)) return;
      this.lastGood = quote;
      this.emit({ status: "ready", quote });
    } catch (error) {
      if (this.isStale(seq, signature)) return;
      this.emit({ status: "error", error: classifyCommerceError(error), previous: this.lastGood });
    }
  }

  private isStale(seq: number, signature: string): boolean {
    return seq !== this.seq || signature !== this.signature;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(state: QuoteState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
