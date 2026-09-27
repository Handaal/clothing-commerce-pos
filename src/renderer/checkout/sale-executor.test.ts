import type { CreatePosSaleResponse } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import type { ConnectedSaleError, ConnectedSaleOutcome } from "../../shared/sales";
import { SaleExecutor, type SalesGateway, type SaleIntent } from "./sale-executor";

const receipt = { saleStatus: "completed" } as CreatePosSaleResponse;
const intent: SaleIntent = {
  registerId: "register-1",
  expectedTotalMinor: 2599,
  cashReceivedMinor: 3000,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

function error(
  kind: string,
  code: string,
  authoritativeTotalMinor: number | null = null,
): ConnectedSaleError {
  return {
    kind,
    code,
    message: `${kind} ${code}`,
    authoritativeTotalMinor,
    uncertain: kind === "network",
  };
}

function gateway(overrides: Partial<SalesGateway> = {}): SalesGateway {
  return {
    hasPending: vi.fn(async () => false),
    submit: vi.fn(
      async () => ({ status: "accepted", workflowId: "wf-1", receipt }) as ConnectedSaleOutcome,
    ),
    recover: vi.fn(async () => null),
    acknowledge: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connected sale executor", () => {
  it("submits once, blocks duplicate taps, and surfaces the accepted receipt with its workflow id", async () => {
    let resolveSale: (value: ConnectedSaleOutcome) => void = () => undefined;
    const submit = vi.fn<SalesGateway["submit"]>(
      async () => new Promise<ConnectedSaleOutcome>((r) => (resolveSale = r)),
    );
    const executor = new SaleExecutor(gateway({ submit }));
    expect(executor.submit(intent)).toBe(true);
    expect(executor.submit(intent)).toBe(false); // in-flight: no second dispatch
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(intent);
    // The intent carries no idempotency key — the durable journal owns it.
    expect(submit.mock.calls[0][0]).not.toHaveProperty("idempotencyKey");
    resolveSale({ status: "accepted", workflowId: "wf-1", receipt });
    await settle();
    expect(executor.snapshot()).toEqual({ phase: "success", receipt, workflowId: "wf-1" });
  });

  it("acknowledges the accepted workflow when the cashier finishes the receipt", async () => {
    const g = gateway();
    const executor = new SaleExecutor(g);
    executor.submit(intent);
    await settle();
    await executor.acknowledge();
    expect(g.acknowledge).toHaveBeenCalledWith("wf-1");
    expect(executor.snapshot()).toEqual({ phase: "idle" });
  });

  it("keeps an ambiguous result unresolved and retries via recover (same durable command)", async () => {
    const submit = vi.fn(
      async () =>
        ({
          status: "ambiguous",
          workflowId: "wf-1",
          error: error("network", "NETWORK_ERROR"),
        }) as ConnectedSaleOutcome,
    );
    const recover = vi.fn(
      async () => ({ status: "accepted", workflowId: "wf-1", receipt }) as ConnectedSaleOutcome,
    );
    const executor = new SaleExecutor(gateway({ submit, recover }));
    executor.submit(intent);
    await settle();
    expect(executor.snapshot().phase).toBe("ambiguous");
    expect(executor.retry()).toBe(true);
    await settle();
    expect(recover).toHaveBeenCalledTimes(1); // replay, not a fresh submit
    expect(submit).toHaveBeenCalledTimes(1);
    expect(executor.snapshot()).toMatchObject({ phase: "success", workflowId: "wf-1" });
  });

  it("treats a thrown transport error as uncertain (ambiguous), never a fresh sale", async () => {
    const submit = vi.fn(async () => {
      throw new Error("ipc exploded");
    });
    const executor = new SaleExecutor(gateway({ submit }));
    executor.submit(intent);
    await settle();
    expect(executor.snapshot()).toMatchObject({ phase: "ambiguous", error: { uncertain: true } });
  });

  it("maps a PRICE_CHANGED rejection to reconfirmation and exposes the authoritative total", async () => {
    const submit = vi.fn(
      async () =>
        ({
          status: "rejected",
          workflowId: "wf-1",
          error: error("price-changed", "PRICE_CHANGED", 2799),
        }) as ConnectedSaleOutcome,
    );
    const executor = new SaleExecutor(gateway({ submit }));
    executor.submit(intent);
    await settle();
    expect(executor.snapshot()).toMatchObject({
      phase: "price-changed",
      authoritativeTotalMinor: 2799,
    });
    expect(executor.retry()).toBe(false); // rejected is terminal; no replay
  });

  it("maps a PROMOTION_UNAVAILABLE rejection to reconfirmation", async () => {
    const submit = vi.fn(
      async () =>
        ({
          status: "rejected",
          workflowId: "wf-1",
          error: error("promotion", "PROMOTION_UNAVAILABLE"),
        }) as ConnectedSaleOutcome,
    );
    const executor = new SaleExecutor(gateway({ submit }));
    executor.submit({ ...intent, promotionCode: "EXPIRED" });
    await settle();
    expect(executor.snapshot()).toMatchObject({
      phase: "promotion-changed",
      error: { code: "PROMOTION_UNAVAILABLE" },
    });
  });

  it("maps other definite rejections to a terminal error state", async () => {
    const submit = vi.fn(
      async () =>
        ({
          status: "rejected",
          workflowId: null,
          error: error("validation", "INSUFFICIENT_CASH"),
        }) as ConnectedSaleOutcome,
    );
    const executor = new SaleExecutor(gateway({ submit }));
    executor.submit(intent);
    await settle();
    expect(executor.snapshot()).toMatchObject({
      phase: "error",
      error: { kind: "validation", code: "INSUFFICIENT_CASH" },
    });
    expect(executor.retry()).toBe(false);
  });

  it("recovers an unresolved sale on startup, replaying the retained command", async () => {
    const recover = vi.fn(
      async () => ({ status: "accepted", workflowId: "wf-9", receipt }) as ConnectedSaleOutcome,
    );
    const executor = new SaleExecutor(gateway({ recover }));
    expect(executor.recover()).toBe(true);
    await settle();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(executor.snapshot()).toMatchObject({ phase: "success", workflowId: "wf-9" });
  });
});
