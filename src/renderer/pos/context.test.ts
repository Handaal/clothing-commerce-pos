import type { PosContextResponse } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it } from "vitest";

import { resolveRegisters } from "./context";

function register(id: string): PosContextResponse["registers"][number] {
  return {
    registerId: id,
    registerName: `Register ${id}`,
    branchId: `branch-${id}`,
    branchName: `Branch ${id}`,
    defaultInventoryLocationId: `location-${id}`,
    defaultInventoryLocationName: `Stockroom ${id}`,
    sellingCurrency: "USD",
    canSell: true,
  };
}

describe("POS context resolution", () => {
  it("blocks zero registers", () => {
    expect(resolveRegisters({ registers: [] })).toEqual({ kind: "none" });
  });

  it("auto-selects one server-returned register", () => {
    expect(resolveRegisters({ registers: [register("one")] })).toMatchObject({
      kind: "selected",
      registerId: "one",
    });
  });

  it("requires selection when multiple registers are authorized", () => {
    expect(resolveRegisters({ registers: [register("one"), register("two")] })).toMatchObject({
      kind: "choose",
      registers: [
        expect.objectContaining({
          branchId: "branch-one",
          defaultInventoryLocationId: "location-one",
          sellingCurrency: "USD",
        }),
        expect.objectContaining({ branchId: "branch-two" }),
      ],
    });
  });
});
