import { describe, expect, it } from "vitest";

import { parseConnectedSaleIntent } from "./input";

const base = {
  registerId: "register-1",
  expectedTotalMinor: 150_000,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

describe("parseConnectedSaleIntent", () => {
  it("keeps the installment deposit and customer so the API records the balance", () => {
    const intent = parseConnectedSaleIntent({
      ...base,
      tenders: [{ method: "cash", amountMinor: 50_000, cashReceivedMinor: 50_000 }],
      customer: { name: "Samy", phone: "+201029197012" },
      amountPaidMinor: 50_000,
    });
    expect(intent.amountPaidMinor).toBe(50_000);
    expect(intent.customer).toEqual({ name: "Samy", phone: "+201029197012" });
  });

  it("omits amountPaidMinor for a normal fully-settled sale", () => {
    const intent = parseConnectedSaleIntent({
      ...base,
      tenders: [{ method: "cash", amountMinor: 150_000, cashReceivedMinor: 150_000 }],
    });
    expect("amountPaidMinor" in intent).toBe(false);
  });

  it("rejects a malformed deposit", () => {
    expect(() =>
      parseConnectedSaleIntent({
        ...base,
        tenders: [{ method: "cash", amountMinor: 1, cashReceivedMinor: 1 }],
        amountPaidMinor: -5,
      }),
    ).toThrow("amountPaidMinor is invalid.");
  });
});
