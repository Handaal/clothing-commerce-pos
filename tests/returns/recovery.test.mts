import {
  ApiHttpError,
  type CommerceClient,
  type ReturnDetailResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "../../src/main/offline/database.js";
import { ReturnStore } from "../../src/main/returns/store.js";
import { ReturnService } from "../../src/main/returns/service.js";
import { parseReturnIntent, parseReturnSession } from "../../src/main/returns/input.js";
import { makeHarness, ids, type OfflineHarness } from "../offline/fixtures.js";
import type { ReturnIntent } from "../../src/shared/returns.js";

const intent: ReturnIntent = {
  orderId: ids.product,
  lines: [
    { orderLineId: ids.variant, quantity: 1, reason: "Size did not fit", disposition: "restock" },
  ],
  inventoryLocationId: ids.location,
  refundMode: "pending",
  settlementReference: null,
};
const session = { tenantId: ids.tenant, accessToken: "SESSION-MUST-NOT-BE-PERSISTED" };
const result: ReturnDetailResponse = {
  id: ids.snapshot,
  orderId: ids.product,
  channel: "pos",
  source: "pos",
  actorMembershipId: ids.membership,
  status: "accepted",
  currency: "USD",
  amountMinor: 2599,
  inventoryLocationId: ids.location,
  inventoryOperationId: ids.grant,
  createdAt: "2026-09-20T12:00:00Z",
  lines: [{ ...intent.lines[0], lineNumber: 1, variantId: ids.variant, amountMinor: 2599 }],
  refund: {
    id: ids.credential,
    paymentId: ids.device,
    returnId: ids.snapshot,
    method: "cash",
    status: "pending",
    amountMinor: 2599,
    currency: "USD",
    settlementReference: null,
    settledAt: null,
  },
};
const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});
function fixture() {
  const h = makeHarness();
  harnesses.push(h);
  const createReturn = vi.fn<TenantCommerceClient["createReturn"]>(async () =>
    structuredClone(result),
  );
  const settled = {
    ...result,
    refund: {
      ...result.refund,
      status: "succeeded" as const,
      settlementReference: "Till 42",
      settledAt: "2026-09-20T12:01:00Z",
    },
  };
  const settleRefund = vi.fn<TenantCommerceClient["settleRefund"]>(async () => settled);
  const client = {
    createReturn,
    settleRefund,
    getReturn: vi.fn(async () => result),
    getOrder: vi.fn(async () => ({ header: { orderNumber: "POS-42" } })),
  } as unknown as TenantCommerceClient;
  const root = {
    getMyTenants: vi.fn(async () => [{ tenantId: ids.tenant, membershipId: ids.membership }]),
    withTenant: vi.fn(() => client),
  } as unknown as CommerceClient;
  const options = { clientFactory: async () => root, networkOnline: () => true };
  const store = new ReturnStore(h.database);
  const service = new ReturnService(store, "http://local.test", options);
  return { h, store, service, options, client, root, createReturn, settleRefund };
}

describe("durable connected returns with real SQLite", () => {
  it("commits exact creation/key before transport and retains it across database restart", async () => {
    const f = fixture();
    let saved = "";
    f.createReturn.mockImplementationOnce(async () => {
      saved = f.store.active()!.create_command!;
      expect(JSON.parse(saved)).toEqual(f.createReturn.mock.calls[0][0]);
      throw new Error("response lost");
    });
    const reply = await f.service.start(session, intent);
    expect(reply.workflow?.stage).toBe("prepared");
    const file = f.h.database.path;
    f.h.database.close();
    const reopened = new LocalDatabase(file);
    try {
      const store = new ReturnStore(reopened);
      expect(store.active()!.create_command).toBe(saved);
      const recovered = await new ReturnService(store, "http://local.test", f.options).recover(
        session,
      );
      expect(recovered.workflow?.stage).toBe("return_acknowledged");
      expect(f.createReturn.mock.calls[0]).toEqual(f.createReturn.mock.calls[1]);
      expect(
        JSON.stringify(
          reopened.connection.prepare("SELECT * FROM connected_return_workflow").all(),
        ),
      ).not.toContain(session.accessToken);
    } finally {
      reopened.close();
    }
  });
  it("persists distinct settlement command/key before transport and recovers exact evidence", async () => {
    const f = fixture();
    await f.service.start(session, intent);
    const create = f.store.active()!.create_key;
    let saved = "";
    f.settleRefund.mockImplementationOnce(async () => {
      saved = f.store.active()!.settlement_command!;
      expect(JSON.parse(saved)).toEqual(f.settleRefund.mock.calls[0][0]);
      throw new Error("lost");
    });
    await f.service.settle(session, result.id, "Till 42");
    expect(f.store.active()!.settlement_key).not.toBe(create);
    const file = f.h.database.path;
    f.h.database.close();
    const reopened = new LocalDatabase(file);
    try {
      const store = new ReturnStore(reopened);
      expect(store.active()!.settlement_command).toBe(saved);
      const reply = await new ReturnService(store, "http://local.test", f.options).recover(session);
      expect(reply.workflow).toMatchObject({
        stage: "completed",
        result: { refund: { status: "succeeded" } },
      });
      expect(f.settleRefund.mock.calls[0]).toEqual(f.settleRefund.mock.calls[1]);
      expect(store.active()).toBeNull();
      expect(store.get(reply.workflow!.id).settlement_command).toBe(saved);
    } finally {
      reopened.close();
    }
  });
  it("cannot change a saved uncertain intent and allows a fresh key only after acknowledgement/archive", async () => {
    const f = fixture();
    f.createReturn.mockRejectedValueOnce(new Error("lost"));
    await f.service.start(session, intent);
    const key = f.store.active()!.create_key;
    await f.service.start(session, { ...intent, lines: [{ ...intent.lines[0], quantity: 2 }] });
    expect(f.createReturn).toHaveBeenCalledTimes(1);
    expect(f.store.active()!.create_key).toBe(key);
    await f.service.recover(session);
    await f.service.finish(session, f.store.active()!.id);
    expect(await f.service.hasPending()).toBe(false);
    await f.service.start(session, intent);
    expect(f.store.active()!.create_key).not.toBe(key);
  });
  it("waits offline without preparing a new return or touching the sales outbox/projection", async () => {
    const f = fixture();
    let online = false;
    const service = new ReturnService(f.store, "http://local.test", {
      ...f.options,
      networkOnline: () => online,
    });
    const before = f.h.sales.getProjectedInventory();
    expect((await service.start(session, intent)).error).toBeTruthy();
    expect(f.store.active()).toBeNull();
    online = true;
    f.createReturn.mockRejectedValueOnce(new Error("lost"));
    await service.start(session, intent);
    const row = f.store.active();
    online = false;
    await service.recover(session);
    expect(f.store.active()).toEqual(row);
    expect(f.createReturn).toHaveBeenCalledTimes(1);
    expect(f.h.sales.getProjectedInventory()).toEqual(before);
    expect(f.h.outbox.listDue()).toEqual([]);
  });
  it("archives only definite first rejection; authorization rejection during replay stays unresolved", async () => {
    const f = fixture();
    f.createReturn.mockRejectedValueOnce(
      new ApiHttpError("Too many", 409, "RETURN_QUANTITY_EXCEEDED", null),
    );
    const rejected = await f.service.start(session, intent);
    expect(rejected.error?.uncertain).toBe(false);
    expect(f.store.active()).toBeNull();
    f.createReturn.mockRejectedValueOnce(new Error("lost"));
    await f.service.start(session, intent);
    f.createReturn.mockRejectedValueOnce(new ApiHttpError("Denied", 403, "FORBIDDEN", null));
    await f.service.recover(session);
    expect(f.store.active()?.stage).toBe("prepared");
  });
  it("prevents cross-operator, cross-tenant and changed API recovery without exposing records", async () => {
    const f = fixture();
    f.createReturn.mockRejectedValueOnce(new Error("lost"));
    await f.service.start(session, intent);
    expect(
      (await new ReturnService(f.store, "http://different.test", f.options).recover(session))
        .workflow,
    ).toBeNull();
    expect((await f.service.inspect({ ...session, tenantId: ids.brand })).workflow).toBeNull();
    vi.mocked(f.root.getMyTenants).mockResolvedValue([
      { tenantId: ids.tenant, tenantName: "Test", membershipId: ids.device },
    ]);
    expect((await f.service.recover(session)).workflow).toBeNull();
    expect(f.createReturn).toHaveBeenCalledTimes(1);
  });
  it("retains immutable archives and rejects command corruption", async () => {
    const f = fixture();
    await f.service.start(session, intent);
    const row = f.store.active()!;
    expect(() =>
      f.h.database.connection
        .prepare("UPDATE connected_return_workflow SET create_command='{}' WHERE id=?")
        .run(row.id),
    ).toThrow();
    expect(() => f.store.command({ ...row, create_hash: "wrong" })).toThrow();
    await f.service.finish(session, row.id);
    expect(() =>
      f.h.database.connection
        .prepare("DELETE FROM connected_return_workflow WHERE id=?")
        .run(row.id),
    ).toThrow();
    expect(() =>
      f.h.database.connection
        .prepare("UPDATE connected_return_workflow SET stage='prepared' WHERE id=?")
        .run(row.id),
    ).toThrow();
  });
  it("validates narrow inputs and rejects secrets, arbitrary prices/keys/paths and early manual settlement", () => {
    expect(parseReturnIntent(intent)).toEqual(intent);
    for (const extra of [
      { idempotencyKey: "renderer-owned" },
      { amountMinor: 1 },
      { databasePath: "somewhere" },
      { accessToken: "secret" },
      { refundMode: "manual_confirmed" },
    ])
      expect(() => parseReturnIntent({ ...intent, ...extra })).toThrow();
    expect(() => parseReturnSession({ ...session, path: "elsewhere" })).toThrow();
  });
});
