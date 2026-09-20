import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReturnIntent } from "../../src/shared/returns.js";
import { ReturnService } from "../../src/main/returns/service.js";
import { ReturnStore } from "../../src/main/returns/store.js";
import { makeHarness } from "../offline/fixtures.js";

const url = process.env.POS_RETURNS_TEST_URL;
const token = process.env.POS_RETURNS_TEST_TOKEN;
const T = "2a000001-0000-4000-8000-000000000001";
const V = "2a000007-0000-4000-8000-000000000001";
const L = "2a000004-0000-4000-8000-000000000001";
const R = "2a000005-0000-4000-8000-000000000001";

describe.skipIf(!url || !token)("packed SDK POS returns against real local API/database", () => {
  it("runs the real connected return screen against the same isolated API", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "src/renderer/returns/runtime-ui.test.tsx",
        "--testTimeout=60000",
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: "inherit", env: process.env },
    );
    expect(result.status).toBe(0);
  });
  it("A/B/C/D/E: canonical cash refund, rejection, non-restock, replay, disconnected local invariants", async () => {
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
      throw new Error("Local API required");
    const client = createCommerceClient({
      baseUrl: url,
      getToken: () => token,
      client: { type: "pos-desktop", version: "0.1.0" },
    }).withTenant(T);
    const stock = async () =>
      (await client.listInventory({ inventoryLocationId: L, variantId: V })).items[0];
    const beforeSale = await stock();
    const sale = await client.createPosSale({
      registerId: R,
      lines: [{ variantId: V, quantity: 2 }],
      expectedTotalMinor: 5000,
      cashReceivedMinor: 5000,
      idempotencyKey: crypto.randomUUID(),
    });
    const afterSale = await stock();
    expect(afterSale.onHand).toBe(beforeSale.onHand - 2);
    const eligible = await client.getReturnEligibility(sale.order.id);
    expect(eligible.lines[0]).toMatchObject({
      purchasedQuantity: 2,
      returnedQuantity: 0,
      eligibleQuantity: 2,
    });
    const local = makeHarness();
    try {
      const store = new ReturnStore(local.database);
      const service = new ReturnService(store, url);
      const session = { tenantId: T, accessToken: token! };
      const create = async (intent: ReturnIntent) => {
        const reply = await service.start(session, intent);
        expect(reply.error).toBeUndefined();
        return reply.workflow!;
      };
      const settle = async (id: string, reference: string) => {
        const reply = await service.settle(session, id, reference);
        expect(reply.error).toBeUndefined();
        return reply.workflow!.result!;
      };
      const intent: ReturnIntent = {
        orderId: sale.order.id,
        lines: [
          {
            orderLineId: eligible.lines[0].orderLineId,
            quantity: 1,
            reason: "Size did not fit",
            disposition: "restock",
          },
        ],
        inventoryLocationId: L,
        refundMode: "pending",
        settlementReference: null,
      };
      const firstWorkflow = await create(intent);
      const accepted = firstWorkflow.result!;
      expect(accepted.refund).toMatchObject({ status: "pending", amountMinor: 2500 });
      const paid = await settle(accepted.id, "Disposable acceptance cash hand-back attestation");
      expect(paid.refund.status).toBe("succeeded");
      const afterRestock = await stock();
      expect(afterRestock.onHand).toBe(afterSale.onHand + 1);
      const historyBefore = await client.listReturns(sale.order.id);
      await expect(
        client.createReturn({
          ...intent,
          idempotencyKey: crypto.randomUUID(),
          lines: [{ ...intent.lines[0], quantity: 2 }],
        }),
      ).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
      expect(await client.listReturns(sale.order.id)).toEqual(historyBefore);
      expect(await stock()).toEqual(afterRestock);
      expect((await client.getReturnEligibility(sale.order.id)).lines[0].eligibleQuantity).toBe(1);
      const nonRestockIntent: ReturnIntent = {
        ...intent,
        inventoryLocationId: null,
        lines: [{ ...intent.lines[0], reason: "Damaged", disposition: "non_restock" }],
      };
      const nonRestock = (await create(nonRestockIntent)).result!;
      const secondPaid = await settle(nonRestock.id, "Disposable acceptance second cash hand-back");
      expect(secondPaid.refund.status).toBe("succeeded");
      expect(nonRestock.inventoryOperationId).toBeNull();
      expect(await stock()).toEqual(afterRestock);
      const replay = await client.createReturn(
        JSON.parse(store.get(firstWorkflow.id).create_command!),
      );
      expect(replay.id).toBe(accepted.id);
      expect(replay.refund.id).toBe(accepted.refund.id);
      expect(replay.inventoryOperationId).toBe(accepted.inventoryOperationId);
      expect(
        (await client.settleRefund(JSON.parse(store.get(firstWorkflow.id).settlement_command!)))
          .refund.id,
      ).toBe(paid.refund.id);
      expect((await client.listReturns(sale.order.id)).items).toHaveLength(2);
      expect(await stock()).toEqual(afterRestock);
      {
        const before = local.database.connection.prepare("SELECT * FROM outbox").all();
        const inventory = local.sales.getProjectedInventory();
        expect(
          (
            await new ReturnService(store, url, { networkOnline: () => false }).start(
              session,
              intent,
            )
          ).error,
        ).toBeTruthy();
        expect(local.database.connection.prepare("SELECT * FROM outbox").all()).toEqual(before);
        expect(local.sales.getProjectedInventory()).toEqual(inventory);
        expect(await stock()).toEqual(afterRestock);
      }
      console.log(
        JSON.stringify({
          scenarios: "A B C D E passed",
          orderNumber: sale.order.orderNumber,
          purchased: 2,
          stockBeforeSale: beforeSale.onHand,
          stockAfterSale: afterSale.onHand,
          stockAfterRestock: afterRestock.onHand,
          stockAfterNonRestockAndReplay: (await stock()).onHand,
          refundAmountsMinor: [paid.refund.amountMinor, secondPaid.refund.amountMinor],
          refundStates: [paid.refund.status, secondPaid.refund.status],
        }),
      );
    } finally {
      local.dispose();
    }
  });
});
