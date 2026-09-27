import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApiHttpError,
  ApiNetworkError,
  type CreatePosSaleInput,
  type CreatePosSaleResponse,
  type TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDatabase, localDatabasePath } from "../../src/main/offline/database.js";
import { ConnectedSaleService } from "../../src/main/sales/service.js";
import { ConnectedSaleStore } from "../../src/main/sales/store.js";
import type { ConnectedSaleIntent, ConnectedSaleSession } from "../../src/shared/sales.js";

const receipt = {
  saleStatus: "completed",
  order: { orderNumber: "POS-1" },
} as CreatePosSaleResponse;
const session: ConnectedSaleSession = { tenantId: "tenant-1", accessToken: "token" };
const intent: ConnectedSaleIntent = {
  registerId: "register-1",
  expectedTotalMinor: 2599,
  cashReceivedMinor: 3000,
  lines: [{ variantId: "variant-1", quantity: 1 }],
};

interface Harness {
  readonly directory: string;
  db: LocalDatabase;
  createPosSale: ReturnType<typeof vi.fn>;
  service: ConnectedSaleService;
  reopen(): void;
  dispose(): void;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function makeHarness(createPosSale: TenantCommerceClient["createPosSale"]): Harness {
  const directory = mkdtempSync(join(tmpdir(), "pos-connected-sale-"));
  const createPosSaleMock = vi.fn(createPosSale);
  const client = { createPosSale: createPosSaleMock } as unknown as TenantCommerceClient;
  const harness: Harness = {
    directory,
    db: undefined as unknown as LocalDatabase,
    createPosSale: createPosSaleMock,
    service: undefined as unknown as ConnectedSaleService,
    reopen() {
      this.db?.close();
      this.db = new LocalDatabase(localDatabasePath(directory));
      this.service = new ConnectedSaleService(new ConnectedSaleStore(this.db), "http://api.test", {
        clientFactory: async () => client,
      });
    },
    dispose() {
      this.db?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harness.reopen();
  harnesses.push(harness);
  return harness;
}

describe("connected sale durable journal", () => {
  it("persists the command and idempotency key before dispatch and accepts on success", async () => {
    const harness = makeHarness(async () => receipt);
    const outcome = await harness.service.submit(session, intent);
    expect(outcome.status).toBe("accepted");
    const key = (harness.createPosSale.mock.calls[0][0] as CreatePosSaleInput).idempotencyKey;
    expect(key).toBeTruthy();
    // Persisted before send: the outbox row exists with that exact key and normalized command.
    const row = harness.db.connection
      .prepare("SELECT idempotency_key, command_json, stage FROM connected_sale_workflow")
      .get() as { idempotency_key: string; command_json: string; stage: string };
    expect(row.idempotency_key).toBe(key);
    expect(row.stage).toBe("accepted");
    expect(JSON.parse(row.command_json)).toMatchObject({ ...intent, idempotencyKey: key });
  });

  it("keeps an ambiguous transport unresolved and replays the SAME key across a restart", async () => {
    let attempt = 0;
    const harness = makeHarness(async () => {
      attempt += 1;
      if (attempt === 1) throw new ApiNetworkError("connection lost");
      return receipt;
    });
    const first = await harness.service.submit(session, intent);
    expect(first.status).toBe("ambiguous");
    expect(await harness.service.hasPending()).toBe(true);
    const firstKey = (harness.createPosSale.mock.calls[0][0] as CreatePosSaleInput).idempotencyKey;

    // Simulate process death + restart: brand-new service/store over the same durable database.
    harness.reopen();
    expect(await harness.service.hasPending()).toBe(true);
    const recovered = await harness.service.recover(session);
    expect(recovered?.status).toBe("accepted");
    const secondKey = (harness.createPosSale.mock.calls[1][0] as CreatePosSaleInput).idempotencyKey;
    expect(secondKey).toBe(firstKey); // never a fresh key after a restart
  });

  it("does not create a second Order while an accepted sale is unacknowledged, and blocks new sales", async () => {
    const harness = makeHarness(async () => receipt);
    const accepted = await harness.service.submit(session, intent);
    expect(accepted.status).toBe("accepted");
    // A duplicate submit must not dispatch a second createPosSale; it returns the accepted result.
    const again = await harness.service.submit(session, { ...intent, cashReceivedMinor: 9999 });
    expect(again.status).toBe("accepted");
    expect(harness.createPosSale).toHaveBeenCalledTimes(1);
    // After acknowledgement the workflow clears and a genuinely new sale may proceed.
    if (accepted.status === "accepted")
      await harness.service.acknowledge(session, accepted.workflowId);
    expect(await harness.service.hasPending()).toBe(false);
    const next = await harness.service.submit(session, intent);
    expect(next.status).toBe("accepted");
    expect(harness.createPosSale).toHaveBeenCalledTimes(2);
  });

  it("closes the workflow on a definite first-attempt rejection without committing", async () => {
    const harness = makeHarness(async () => {
      throw new ApiHttpError("Price changed", 409, "PRICE_CHANGED", "req-1", [
        { path: ["expectedTotalMinor"], message: "refresh", value: 2799 },
      ]);
    });
    const outcome = await harness.service.submit(session, intent);
    expect(outcome).toMatchObject({
      status: "rejected",
      error: { kind: "price-changed", authoritativeTotalMinor: 2799 },
    });
    expect(await harness.service.hasPending()).toBe(false);
  });

  it("treats an idempotency conflict as uncertain and retains the command for replay", async () => {
    const harness = makeHarness(async () => {
      throw new ApiHttpError("Conflict", 409, "IDEMPOTENCY_CONFLICT", "req-1");
    });
    const outcome = await harness.service.submit(session, intent);
    expect(outcome.status).toBe("ambiguous");
    expect(await harness.service.hasPending()).toBe(true);
  });

  it("never rejects a replay, even on a definite error, because the first attempt may have committed", async () => {
    let attempt = 0;
    const harness = makeHarness(async () => {
      attempt += 1;
      if (attempt === 1) throw new ApiNetworkError("timeout");
      throw new ApiHttpError("Gone", 404, "NOT_FOUND", "req-1");
    });
    await harness.service.submit(session, intent); // ambiguous
    const recovered = await harness.service.recover(session);
    expect(recovered?.status).toBe("ambiguous"); // stays unresolved, not rejected
    expect(await harness.service.hasPending()).toBe(true);
  });

  it("keeps the stored command immutable", async () => {
    const harness = makeHarness(async () => receipt);
    await harness.service.submit(session, intent);
    expect(() =>
      harness.db.connection
        .prepare("UPDATE connected_sale_workflow SET command_json = '{}' WHERE 1=1")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      harness.db.connection.prepare("DELETE FROM connected_sale_workflow").run(),
    ).toThrow(/retained/);
  });
});
