import { describe, expect, it } from "vitest";

import { receiptIdentity, type BranchIdentity, type BusinessIdentity } from "./receipt-identity";

function business(overrides: Partial<BusinessIdentity> = {}): BusinessIdentity {
  return {
    displayName: "Dev Store",
    legalName: "Dev Store LLC",
    taxIdentifier: "EG-123456789",
    ...overrides,
  };
}

function branch(overrides: Partial<BranchIdentity> = {}): BranchIdentity {
  return {
    displayName: "Flagship",
    addressLine1: "12 Nile Corniche",
    addressLine2: "Floor 2",
    city: "Cairo",
    region: "Cairo Governorate",
    postalCode: "11511",
    countryCode: "EG",
    contactEmail: "shop@example.com",
    contactPhone: "+20 2 1234 5678",
    receiptFooter: "Thank you for shopping with us!",
    ...overrides,
  };
}

describe("receiptIdentity", () => {
  it("maps business identity (display, legal, tax)", () => {
    const identity = receiptIdentity(business(), branch());
    expect(identity.businessName).toBe("Dev Store");
    expect(identity.legalName).toBe("Dev Store LLC");
    expect(identity.taxIdentifier).toBe("EG-123456789");
  });

  it("maps branch identity (name, address, contact, footer)", () => {
    const identity = receiptIdentity(business(), branch());
    expect(identity.branchName).toBe("Flagship");
    expect(identity.branchAddressLines).toEqual([
      "12 Nile Corniche",
      "Floor 2",
      "Cairo, Cairo Governorate, 11511",
      "EG",
    ]);
    expect(identity.branchContactLines).toEqual(["+20 2 1234 5678", "shop@example.com"]);
    expect(identity.receiptFooter).toBe("Thank you for shopping with us!");
  });

  it("treats a missing legal name as absent", () => {
    expect(receiptIdentity(business({ legalName: null }), branch()).legalName).toBeNull();
  });

  it("treats a missing tax identifier as absent", () => {
    expect(receiptIdentity(business({ taxIdentifier: null }), branch()).taxIdentifier).toBeNull();
  });

  it("omits absent optional branch fields cleanly", () => {
    const identity = receiptIdentity(
      business({ legalName: null, taxIdentifier: null }),
      branch({
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        contactEmail: null,
        contactPhone: null,
        receiptFooter: null,
      }),
    );
    expect(identity.branchAddressLines).toEqual([]);
    expect(identity.branchContactLines).toEqual([]);
    expect(identity.receiptFooter).toBeNull();
    // The required identity still renders.
    expect(identity.businessName).toBe("Dev Store");
    expect(identity.branchName).toBe("Flagship");
  });

  it("collapses a partial locality line without stray separators", () => {
    const identity = receiptIdentity(
      business(),
      branch({
        addressLine1: null,
        addressLine2: null,
        city: "Cairo",
        region: null,
        postalCode: null,
      }),
    );
    expect(identity.branchAddressLines).toEqual(["Cairo", "EG"]);
  });

  it("normalizes blank strings to absent", () => {
    const identity = receiptIdentity(
      business({ legalName: "   " }),
      branch({ receiptFooter: "  ", contactPhone: "  ", contactEmail: "shop@example.com" }),
    );
    expect(identity.legalName).toBeNull();
    expect(identity.receiptFooter).toBeNull();
    expect(identity.branchContactLines).toEqual(["shop@example.com"]);
  });
});
