import type { CommerceClient, MeTenantsResponse } from "@shifted/clothing-commerce-sdk";

export type Tenant = MeTenantsResponse[number];

export type TenantResolution =
  | { kind: "none" }
  | { kind: "selected"; tenants: readonly Tenant[]; tenantId: string }
  | { kind: "choose"; tenants: readonly Tenant[] };

export async function bootstrapTenants(client: CommerceClient): Promise<TenantResolution> {
  const tenants = await client.getMyTenants();
  if (tenants.length === 0) return { kind: "none" };
  if (tenants.length === 1) return { kind: "selected", tenants, tenantId: tenants[0].tenantId };
  return { kind: "choose", tenants };
}
