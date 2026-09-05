import type { CommerceClient } from "@shifted/clothing-commerce-sdk";
import { describe, expect, it } from "vitest";

import { bootstrapTenants } from "./tenant";

function clientWith(tenants: Awaited<ReturnType<CommerceClient["getMyTenants"]>>): CommerceClient {
  return { getMyTenants: async () => tenants } as CommerceClient;
}

describe("tenant bootstrap", () => {
  it("reports no tenant", async () => {
    await expect(bootstrapTenants(clientWith([]))).resolves.toEqual({ kind: "none" });
  });

  it("auto-selects exactly one tenant", async () => {
    await expect(
      bootstrapTenants(
        clientWith([{ tenantId: "tenant-1", tenantName: "Store", membershipId: "member-1" }]),
      ),
    ).resolves.toMatchObject({ kind: "selected", tenantId: "tenant-1" });
  });

  it("requires selection for multiple tenants", async () => {
    const tenants = [
      { tenantId: "tenant-1", tenantName: "One", membershipId: "member-1" },
      { tenantId: "tenant-2", tenantName: "Two", membershipId: "member-2" },
    ];
    await expect(bootstrapTenants(clientWith(tenants))).resolves.toEqual({
      kind: "choose",
      tenants,
    });
  });
});
