import {
  ApiNetworkError,
  type PosQuoteResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { describe, expect, it, vi } from "vitest";

import { QuoteController, type QuoteBasket, type QuoteState } from "./quote";

function makeQuote(totalMinor: number, gross = totalMinor): PosQuoteResponse {
  return {
    currency: "USD",
    grossSubtotalMinor: gross,
    discountTotalMinor: gross - totalMinor,
    totalMinor,
    codeStatus: "none",
    promotion: null,
  };
}

function client(posQuote: TenantCommerceClient["posQuote"]): TenantCommerceClient {
  return { posQuote } as TenantCommerceClient;
}

function basket(quantity: number): QuoteBasket {
  return { registerId: "register-1", lines: [{ variantId: "variant-1", quantity }] };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connected POS quote controller", () => {
  it("requotes on a basket change and applies the current basket result", async () => {
    const posQuote = vi
      .fn<TenantCommerceClient["posQuote"]>()
      .mockResolvedValueOnce(makeQuote(1000))
      .mockResolvedValueOnce(makeQuote(2000));
    const controller = new QuoteController(0);
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    expect(controller.snapshot()).toMatchObject({ status: "ready", quote: { totalMinor: 1000 } });
    controller.sync(client(posQuote), basket(2), null);
    await settle();
    expect(posQuote).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({ status: "ready", quote: { totalMinor: 2000 } });
  });

  it("never lets a stale response overwrite a newer basket", async () => {
    const resolvers: Array<(quote: PosQuoteResponse) => void> = [];
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>(
      () => new Promise<PosQuoteResponse>((resolve) => resolvers.push(resolve)),
    );
    const controller = new QuoteController(0);
    controller.sync(client(posQuote), basket(1), null); // seq 1 (older)
    controller.sync(client(posQuote), basket(2), null); // seq 2 (newer)
    expect(posQuote).toHaveBeenCalledTimes(2);

    resolvers[1](makeQuote(2000)); // newer resolves first
    await settle();
    expect(controller.snapshot()).toMatchObject({ status: "ready", quote: { totalMinor: 2000 } });

    resolvers[0](makeQuote(1000)); // older resolves late and must be ignored
    await settle();
    expect(controller.snapshot()).toMatchObject({ status: "ready", quote: { totalMinor: 2000 } });
  });

  it("does not requote when the basket signature is unchanged", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>().mockResolvedValue(makeQuote(1000));
    const controller = new QuoteController(0);
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    expect(posQuote).toHaveBeenCalledTimes(1);
  });

  it("threads the applied code and omits it when none is applied", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>().mockResolvedValue(makeQuote(1000));
    const controller = new QuoteController(0);
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    expect(posQuote.mock.calls[0][0]).not.toHaveProperty("promotionCode");
    controller.sync(client(posQuote), basket(1), "SAVE10");
    await settle();
    expect(posQuote.mock.calls[1][0]).toMatchObject({ promotionCode: "SAVE10" });
  });

  it("clears to idle when the basket empties", async () => {
    const posQuote = vi.fn<TenantCommerceClient["posQuote"]>().mockResolvedValue(makeQuote(1000));
    const controller = new QuoteController(0);
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    controller.sync(client(posQuote), { registerId: "register-1", lines: [] }, null);
    expect(controller.snapshot()).toEqual({ status: "idle" });
  });

  it("surfaces a network failure as a connection-aware error", async () => {
    const posQuote = vi
      .fn<TenantCommerceClient["posQuote"]>()
      .mockRejectedValue(new ApiNetworkError("offline"));
    const controller = new QuoteController(0);
    const states: QuoteState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.sync(client(posQuote), basket(1), null);
    await settle();
    expect(controller.snapshot()).toMatchObject({
      status: "error",
      error: { kind: "network" },
    });
  });
});
