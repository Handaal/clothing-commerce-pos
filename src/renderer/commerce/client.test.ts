import { describe, expect, it, vi } from "vitest";

import { createConfiguredCommerceClient } from "./client";

describe("Commerce SDK boundary", () => {
  it("supplies the current Clerk token and lets the SDK own client and tenant headers", async () => {
    const getToken = vi.fn(async () => "session-token");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me/tenants")) {
        return new Response(
          JSON.stringify([
            {
              tenantId: "00000000-0000-4000-8000-000000000001",
              tenantName: "Store",
              membershipId: "00000000-0000-4000-8000-000000000002",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          business: {
            tenant: { displayName: "Store", legalName: null, taxIdentifier: null },
          },
          registers: [],
        }),
        { status: 200 },
      );
    });
    const client = createConfiguredCommerceClient({
      baseUrl: "https://api.example.test",
      getToken,
      fetch,
    });

    await client.getMyTenants();
    await client.withTenant("00000000-0000-4000-8000-000000000001").getPosContext();

    expect(getToken).toHaveBeenCalledTimes(2);
    const bootstrapHeaders = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(bootstrapHeaders.get("Authorization")).toBe("Bearer session-token");
    expect(bootstrapHeaders.get("X-Client-Type")).toBe("pos-desktop");
    expect(bootstrapHeaders.get("X-Client-Version")).toBe("0.1.0");
    expect(bootstrapHeaders.has("X-Tenant-Id")).toBe(false);
    const tenantHeaders = new Headers(fetch.mock.calls[1][1]?.headers);
    expect(tenantHeaders.get("X-Tenant-Id")).toBe("00000000-0000-4000-8000-000000000001");
  });
});
