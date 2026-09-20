import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WorkflowRow } from "../../src/main/returns/store.js";

const url = process.env.POS_RETURNS_TEST_URL,
  token = process.env.POS_RETURNS_TEST_TOKEN;
describe.skipIf(!url || !token)("full Electron process crash recovery against real API", () => {
  it("F/G: survives commit-before-ack crashes with identical transport bytes, keys and canonical effects", async () => {
    const T = "2a000001-0000-4000-8000-000000000001",
      R = "2a000005-0000-4000-8000-000000000001",
      V = "2a000007-0000-4000-8000-000000000001",
      L = "2a000004-0000-4000-8000-000000000001";
    const client = createCommerceClient({
      baseUrl: url!,
      getToken: () => token,
      client: { type: "pos-desktop", version: "0.1.0" },
    }).withTenant(T);
    const sale = await client.createPosSale({
      registerId: R,
      lines: [{ variantId: V, quantity: 2 }],
      expectedTotalMinor: 5000,
      cashReceivedMinor: 5000,
      idempotencyKey: crypto.randomUUID(),
    });
    const stock = async () =>
      (await client.listInventory({ inventoryLocationId: L, variantId: V })).items[0];
    const before = await stock();
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "pos-return-crash-"));
    const json = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
    const row = () => {
      const db = new DatabaseSync(join(directory, "commerce-pos-ledger.sqlite3"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT * FROM connected_return_workflow")
          .get() as unknown as WorkflowRow;
      } finally {
        db.close();
      }
    };
    const run = (phase: string, expected: number) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        POS_RETURN_CRASH_DIRECTORY: directory,
        POS_RETURN_CRASH_PHASE: phase,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const processResult = spawnSync(
        resolve("node_modules/electron/dist/electron.exe"),
        [resolve("tests/runtime/return-recovery")],
        { cwd: process.cwd(), env, windowsHide: true, encoding: "utf8", timeout: 45000 },
      );
      expect(processResult.status, `Electron ${phase}: ${processResult.stderr}`).toBe(expected);
    };
    try {
      writeFileSync(
        join(directory, "input.json"),
        JSON.stringify({
          tenantId: T,
          intent: {
            orderId: sale.order.id,
            lines: [
              {
                orderLineId: sale.order.lines[0].id,
                quantity: 1,
                reason: "Crash recovery size test",
                disposition: "restock",
              },
            ],
            inventoryLocationId: L,
            refundMode: "pending",
            settlementReference: null,
          },
        }),
      );
      run("create-crash", 86);
      const prepared = row();
      expect(prepared.stage).toBe("prepared");
      expect(prepared.return_ack).toBeNull();
      const committed = json("create-crash-committed.json");
      expect((await client.listReturns(sale.order.id)).items).toHaveLength(1);
      const after = await stock();
      expect(after.onHand).toBe(before.onHand + 1);
      expect(after.version).toBe(before.version + 1);
      run("offline-wait", 0);
      expect(row().create_command).toBe(prepared.create_command);
      expect(row().stage).toBe("prepared");
      expect(json("offline-wait-result.json").pending).toBe(true);
      run("recover-create", 0);
      const acknowledged = row();
      expect(acknowledged.stage).toBe("return_acknowledged");
      expect(acknowledged.create_command).toBe(prepared.create_command);
      expect(acknowledged.create_key).toBe(prepared.create_key);
      expect(json("recover-create-requests.json")).toEqual(json("create-crash-requests.json"));
      expect(JSON.parse(acknowledged.return_ack!).id).toBe(committed.result.id);
      expect(json("recover-create-result.json").pid).not.toBe(committed.pid);
      expect(await stock()).toEqual(after);
      run("settle-crash", 86);
      const settlementPrepared = row();
      expect(settlementPrepared.stage).toBe("settlement_prepared");
      expect(settlementPrepared.refund_ack).toBeNull();
      expect(settlementPrepared.settlement_key).not.toBe(prepared.create_key);
      const settled = json("settle-crash-committed.json");
      expect(settled.result.refund.status).toBe("succeeded");
      run("recover-settle", 0);
      const completed = row();
      expect(completed.stage).toBe("completed");
      expect(completed.completed_at).not.toBeNull();
      expect(completed.settlement_command).toBe(settlementPrepared.settlement_command);
      expect(completed.settlement_key).toBe(settlementPrepared.settlement_key);
      expect(json("recover-settle-requests.json")).toEqual(json("settle-crash-requests.json"));
      expect(JSON.parse(completed.refund_ack!).refund).toEqual(settled.result.refund);
      expect(json("recover-settle-result.json").pid).not.toBe(settled.pid);
      run("completed-restart", 0);
      expect(json("completed-restart-result.json").pending).toBe(false);
      expect(row()).toEqual(completed);
      const history = (await client.listReturns(sale.order.id)).items;
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(committed.result.id);
      expect(history[0].inventoryOperationId).toBe(committed.result.inventoryOperationId);
      expect(history[0].refund).toEqual(settled.result.refund);
      expect(await stock()).toEqual(after);
      expect(JSON.stringify(completed)).not.toContain(token!);
      process.stdout.write(
        JSON.stringify({
          scenarios: "F/G passed",
          orderNumber: sale.order.orderNumber,
          distinctElectronProcesses: true,
          identicalCreateBytes: true,
          identicalSettlementBytes: true,
          returnCount: history.length,
          inventoryVersionBefore: before.version,
          inventoryVersionAfter: after.version,
          refundStatus: history[0].refund.status,
          stage: completed.stage,
        }) + "\n",
      );
    } finally {
      const target = realpathSync(directory);
      if (
        dirname(target) !== realpathSync(tmpdir()) ||
        !basename(target).startsWith("pos-return-crash-")
      )
        // eslint-disable-next-line no-unsafe-finally -- Fail closed rather than delete an unexpected directory.
        throw new Error("Unexpected cleanup path");
      rmSync(target, { recursive: true, force: true });
    }
  }, 180000);
});
