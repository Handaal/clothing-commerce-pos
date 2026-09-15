import { afterEach, describe, expect, it } from "vitest";

import { OfflineAuthorityStore } from "../../src/main/offline/authority-store";
import { OfflineAcceptanceError } from "../../src/main/offline/offline-service";
import { bootstrapFixture, ids, makeHarness, type OfflineHarness } from "./fixtures";

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("atomic cache generations and offline eligibility", () => {
  it("activates a complete server snapshot and exposes trusted cached facts", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    expect(harness.sales.getReadiness()).toMatchObject({
      ready: true,
      deviceId: ids.device,
      registerId: ids.register,
      inventoryLocationId: ids.location,
      currency: "USD",
    });
    expect(harness.sales.getCachedCatalog()).toEqual([
      expect.objectContaining({
        variantId: ids.variant,
        sku: "TEE-BLK-M",
        unitPriceMinor: 2_599,
        priceId: ids.price,
      }),
    ]);
  });

  it("switches generations atomically and retains the old referenced generation", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    harness.sales.acceptCashSale({
      lines: [{ variantId: ids.variant, quantity: 1 }],
      cashReceivedMinor: 3_000,
    });
    const next = bootstrapFixture({
      grantId: "20000000-0000-4000-8000-000000000008",
      snapshotId: "20000000-0000-4000-8000-000000000009",
      issuedAt: "2026-09-08T11:00:00.000Z",
    });
    harness.authority.installBootstrap(next, "2026-09-08T12:01:00.000Z");
    const snapshots = harness.database.connection
      .prepare("SELECT snapshot_id, state FROM catalog_snapshot ORDER BY snapshot_id")
      .all();
    expect(snapshots).toEqual([
      { snapshot_id: ids.snapshot, state: "retired" },
      { snapshot_id: next.snapshotId, state: "active" },
    ]);
    expect(
      harness.database.connection
        .prepare("SELECT snapshot_id FROM local_sale WHERE snapshot_id = ?")
        .get(ids.snapshot),
    ).toEqual({ snapshot_id: ids.snapshot });
  });

  it("does not replace the active cache when installation is interrupted", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const failing = new OfflineAuthorityStore(harness.database, {
      afterStage(stage) {
        if (stage === "inventory") throw new Error("injected cache failure");
      },
    });
    const next = bootstrapFixture({
      grantId: "30000000-0000-4000-8000-000000000008",
      snapshotId: "30000000-0000-4000-8000-000000000009",
    });
    expect(() => failing.installBootstrap(next, "2026-09-08T12:01:00.000Z")).toThrow(
      "injected cache failure",
    );
    expect(
      harness.database.connection
        .prepare("SELECT snapshot_id FROM catalog_snapshot WHERE state = 'active'")
        .get(),
    ).toEqual({ snapshot_id: ids.snapshot });
    expect(
      harness.database.connection
        .prepare("SELECT snapshot_id FROM catalog_snapshot WHERE snapshot_id = ?")
        .get(next.snapshotId),
    ).toBeUndefined();
  });

  it("blocks expired grants and material local clock rollback", () => {
    let current = new Date("2026-09-08T12:00:00.000Z");
    const harness = makeHarness({ now: () => current });
    harnesses.push(harness);
    current = new Date("2026-09-08T20:00:00.001Z");
    expect(harness.sales.getReadiness()).toMatchObject({ ready: false, reason: "GRANT_EXPIRED" });
    current = new Date("2026-09-08T11:54:59.999Z");
    expect(harness.sales.getReadiness()).toMatchObject({ ready: false, reason: "CLOCK_ROLLBACK" });
  });

  it("blocks missing price, missing inventory, and local line limits", () => {
    const missingPrice = makeHarness({
      bootstrap: bootstrapFixture({ catalog: [] }),
    });
    harnesses.push(missingPrice);
    expect(() =>
      missingPrice.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 3_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "PRICE_MISSING" }));

    const missingInventory = makeHarness();
    harnesses.push(missingInventory);
    missingInventory.database.connection.exec("PRAGMA foreign_keys = OFF");
    missingInventory.database.connection
      .prepare("DELETE FROM inventory_snapshot WHERE snapshot_id = ?")
      .run(ids.snapshot);
    missingInventory.database.connection.exec("PRAGMA foreign_keys = ON");
    expect(() =>
      missingInventory.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 1 }],
        cashReceivedMinor: 3_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_MISSING" }));

    const limited = makeHarness({
      bootstrap: bootstrapFixture({
        policy: { ...bootstrapFixture().policy, maxQuantityPerLine: 1 },
      }),
    });
    harnesses.push(limited);
    expect(() =>
      limited.sales.acceptCashSale({
        lines: [{ variantId: ids.variant, quantity: 2 }],
        cashReceivedMinor: 6_000,
      }),
    ).toThrow(OfflineAcceptanceError);
  });
});
