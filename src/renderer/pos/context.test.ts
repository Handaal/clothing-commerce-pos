import type { PosContextResponse } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it } from "vitest";

import { resolveRegisters } from "./context";

function branch(id: string): PosContextResponse["registers"][number]["branch"] {
  return {
    displayName: `Branch ${id}`,
    addressLine1: `${id} High Street`,
    addressLine2: null,
    city: "Cairo",
    region: null,
    postalCode: null,
    countryCode: "EG",
    contactEmail: null,
    contactPhone: null,
    receiptFooter: null,
  };
}

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
    branch: branch(id),
  };
}

function context(registers: PosContextResponse["registers"]): PosContextResponse {
  return {
    business: {
      tenant: { displayName: "Dev Store", legalName: null, taxIdentifier: null },
    },
    registers,
  };
}

describe("POS context resolution", () => {
  it("blocks zero registers", () => {
    expect(resolveRegisters(context([]))).toEqual({ kind: "none" });
  });

  it("auto-selects one server-returned register", () => {
    expect(resolveRegisters(context([register("one")]))).toMatchObject({
      kind: "selected",
      registerId: "one",
    });
  });

  it("requires selection when multiple registers are authorized", () => {
    expect(resolveRegisters(context([register("one"), register("two")]))).toMatchObject({
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

  it("maps server-owned business identity and per-register branch identity", () => {
    const resolved = resolveRegisters(context([register("one")]));
    expect(resolved.kind).toBe("selected");
    if (resolved.kind !== "selected") return;
    expect(resolved.registers[0]?.branch).toMatchObject({
      displayName: "Branch one",
      addressLine1: "one High Street",
      city: "Cairo",
      countryCode: "EG",
    });
  });
});
