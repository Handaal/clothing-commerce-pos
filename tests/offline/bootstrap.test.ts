import { afterEach, describe, expect, it, vi } from "vitest";

import { OfflineBootstrapService } from "../../src/main/offline/bootstrap";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("authenticated enrollment and offline bootstrap foundation", () => {
  it("enrolls once, installs complete caches, and reuses the device on refresh", async () => {
    const harness = makeHarness({ install: false, enroll: false });
    harnesses.push(harness);
    const firstBootstrap = bootstrapFixture();
    const secondBootstrap = bootstrapFixture({
      grantId: "40000000-0000-4000-8000-000000000008",
      snapshotId: "40000000-0000-4000-8000-000000000009",
      issuedAt: "2026-09-08T11:00:00.000Z",
    });
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    let bootstrapCount = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, headers, body });
      if (url.endsWith("/api/v1/pos/devices")) {
        return Response.json({
          deviceId: ids.device,
          credentialId: ids.credential,
          registerId: ids.register,
          status: "active",
          publicKeyFingerprint: harness.keys.loadPublicKey().fingerprint,
          activatedAt: "2026-09-08T10:00:00.000Z",
          revokedAt: null,
        });
      }
      if (url.endsWith("/api/v1/pos/offline-bootstrap")) {
        const response = bootstrapCount === 0 ? firstBootstrap : secondBootstrap;
        bootstrapCount += 1;
        return Response.json(response);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new OfflineBootstrapService(
      "https://commerce.example.test",
      harness.authority,
      harness.keys,
      () => new Date("2026-09-08T12:00:00.000Z"),
    );
    const input = {
      tenantId: ids.tenant,
      registerId: ids.register,
      displayName: "Front Register",
      accessToken: "clerk-test-token-must-not-persist",
    };
    await expect(service.bootstrap(input)).resolves.toMatchObject({
      deviceId: ids.device,
      grantId: ids.grant,
      snapshotId: ids.snapshot,
      catalogItemCount: 1,
    });
    await expect(service.bootstrap(input)).resolves.toMatchObject({
      deviceId: ids.device,
      grantId: secondBootstrap.grantId,
      snapshotId: secondBootstrap.snapshotId,
    });
    expect(calls.filter(({ url }) => url.endsWith("/api/v1/pos/devices"))).toHaveLength(1);
    expect(calls.filter(({ url }) => url.endsWith("/api/v1/pos/offline-bootstrap"))).toHaveLength(
      2,
    );
    for (const call of calls) {
      expect(call.headers.get("Authorization")).toBe("Bearer clerk-test-token-must-not-persist");
      expect(call.headers.get("X-Tenant-Id")).toBe(ids.tenant);
      expect(call.headers.get("Idempotency-Key")).toMatch(/^[a-f0-9-]{36}$/);
    }
    const serializedRows = harness.database.connection
      .prepare(
        `SELECT group_concat(value, '|') AS values_text FROM (
          SELECT payload_json AS value FROM offline_grant
          UNION ALL SELECT payload_json FROM context_snapshot
          UNION ALL SELECT request_json FROM outbox
        )`,
      )
      .get() as { values_text: string | null };
    expect(serializedRows.values_text ?? "").not.toContain("clerk-test-token-must-not-persist");
    expect(harness.sales.getReadiness()).toMatchObject({ ready: true, deviceId: ids.device });
  });
});
