import { describe, expect, it } from "vitest";

import { parseConnectedSaleIntent } from "../../src/main/sales/input.js";

// The renderer's split-tender PayModal submits a `tenders[]` array (and optional `customer`) and no
// top-level `cashReceivedMinor`. These lock the renderer -> IPC intent contract so the parser cannot
// again reject the live payload or silently drop tenders/customer from the durable command.

const base = {
  registerId: "register-1",
  expectedTotalMinor: 2599,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

describe("parseConnectedSaleIntent", () => {
  it("accepts a split-tender payload and forwards tenders", () => {
    const intent = parseConnectedSaleIntent({
      ...base,
      tenders: [
        { method: "cash", amountMinor: 2000, cashReceivedMinor: 3000 },
        { method: "card", amountMinor: 599 },
      ],
    });
    expect(intent.tenders).toEqual([
      { method: "cash", amountMinor: 2000, cashReceivedMinor: 3000 },
      { method: "card", amountMinor: 599 },
    ]);
    expect(intent).not.toHaveProperty("cashReceivedMinor");
  });

  it("forwards an optional customer", () => {
    const intent = parseConnectedSaleIntent({
      ...base,
      tenders: [{ method: "cash", amountMinor: 2599, cashReceivedMinor: 3000 }],
      customer: { name: "Jane", phone: "+201000000000" },
    });
    expect(intent.customer).toEqual({ name: "Jane", phone: "+201000000000" });
  });

  it("still accepts a legacy top-level cashReceivedMinor with no tenders", () => {
    const intent = parseConnectedSaleIntent({ ...base, cashReceivedMinor: 3000 });
    expect(intent.cashReceivedMinor).toBe(3000);
    expect(intent).not.toHaveProperty("tenders");
  });

  it("rejects a sale carrying neither tenders nor cashReceivedMinor", () => {
    expect(() => parseConnectedSaleIntent({ ...base })).toThrow(/payment is invalid/);
  });

  it("rejects an empty tenders array", () => {
    expect(() => parseConnectedSaleIntent({ ...base, tenders: [] })).toThrow(/tenders is invalid/);
  });

  it("rejects an unknown tender method", () => {
    expect(() =>
      parseConnectedSaleIntent({ ...base, tenders: [{ method: "crypto", amountMinor: 2599 }] }),
    ).toThrow(/tender.method is invalid/);
  });

  it("rejects a negative tender amount", () => {
    expect(() =>
      parseConnectedSaleIntent({ ...base, tenders: [{ method: "cash", amountMinor: -1 }] }),
    ).toThrow(/tender.amountMinor is invalid/);
  });
});
