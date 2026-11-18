import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ids, makeHarness, type OfflineHarness } from "./fixtures";

// ADR-043 §5.1: every offline sale carries, inside the DEVICE-SIGNED command, the member operating the till —
// supplied only by the main process (verified offline PIN unlock, else the signed-in online operator).

const harnesses: OfflineHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const CASHIER = "2a000012-0000-4000-8000-0000000000c1";
const ONLINE = "2a000012-0000-4000-8000-0000000000a1";

function sell(harness: OfflineHarness) {
  const accepted = harness.sales.acceptCashSale({
    lines: [{ variantId: ids.variant, quantity: 1 }],
    cashReceivedMinor: 3_000,
  });
  const row = harness.database.connection
    .prepare("SELECT canonical_command, request_json FROM outbox WHERE sync_command_id = ?")
    .get(accepted.syncCommandId) as { canonical_command: string; request_json: string };
  const local = harness.database.connection
    .prepare("SELECT unlocked_by_membership_id FROM local_sale WHERE local_sale_id = ?")
    .get(accepted.localSaleId) as { unlocked_by_membership_id: string | null };
  return {
    command: JSON.parse(row.canonical_command) as Record<string, unknown>,
    request: JSON.parse(row.request_json) as { signature: { value: string } },
    canonical: row.canonical_command,
    local: local.unlocked_by_membership_id,
  };
}

describe("offline sale operator attribution", () => {
  it("stamps the main-process operator into the signed command and the local sale", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    let operator: string | null = CASHIER;
    harness.sales.setOperatorResolver(() => operator);

    const first = sell(harness);
    expect(first.command.unlockedByMembershipId).toBe(CASHIER);
    expect(first.local).toBe(CASHIER);
    // Covered by the device signature: the server verifies exactly these bytes.
    const key = createPublicKey({
      key: Buffer.from(harness.keys.loadPublicKey().value, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(first.canonical, "utf8"),
        key,
        Buffer.from(first.request.signature.value, "base64"),
      ),
    ).toBe(true);

    operator = ONLINE;
    expect(sell(harness).command.unlockedByMembershipId).toBe(ONLINE);
  });

  it("omits the field when no operator is known (canonical form identical to an older till)", () => {
    const harness = makeHarness();
    harnesses.push(harness);
    const sale = sell(harness);
    expect(sale.command).not.toHaveProperty("unlockedByMembershipId");
    expect(sale.canonical).not.toContain("unlockedByMembershipId");
    expect(sale.local).toBeNull();
  });
});
