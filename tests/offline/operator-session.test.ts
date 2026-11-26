import { describe, expect, it } from "vitest";

import { OfflineRuntime } from "../../src/main/offline/runtime";

// ADR-043 §5.1: the operator stamped into offline sales lives ONLY in the main process. It is set solely by a
// successful device-bound PIN verification, never by a failure or by the renderer, cleared at sign-out or when an
// online sign-in takes over, and falls back to the signed-in online operator.

function makeRuntime(verify: (input: { username: string; pin: string }) => unknown) {
  let resolver: (() => string | null) | null = null;
  const sales = { setOperatorResolver: (fn: () => string | null) => (resolver = fn) };
  const staffRoster = { verifyPin: verify };
  const Ctor = OfflineRuntime as unknown as new (...args: unknown[]) => OfflineRuntime;
  const runtime = new Ctor(
    undefined, // database
    sales,
    undefined, // bootstrap
    undefined, // outbox
    undefined, // sync worker
    undefined, // initialization error
    undefined, // returns
    undefined, // connected sales
    undefined, // activity
    staffRoster,
  );
  return { runtime, stamped: () => resolver?.() ?? null };
}

const CASHIER = { membershipId: "m-cashier", username: "omar", displayName: "Omar" };

describe("offline operator session (main process)", () => {
  it("is set only by a successful offline PIN verification", () => {
    let next: unknown = { ok: false, reason: "INVALID" };
    const { runtime, stamped } = makeRuntime(() => next);
    runtime.verifyStaffPin({ username: "omar", pin: "0000" });
    expect(stamped()).toBeNull();
    next = { ok: true, operator: CASHIER };
    runtime.verifyStaffPin({ username: "omar", pin: "4821" });
    expect(stamped()).toBe("m-cashier");
    // A later failed attempt (e.g. someone else probing) never changes who is stamped.
    next = { ok: false, reason: "THROTTLED" };
    runtime.verifyStaffPin({ username: "dana", pin: "1111" });
    expect(stamped()).toBe("m-cashier");
  });

  it("falls back to the online operator and is cleared at sign-out / online takeover", () => {
    const { runtime, stamped } = makeRuntime(() => ({ ok: true, operator: CASHIER }));
    let online: string | null = null;
    runtime.setSessionOperatorResolver(() => online);
    expect(stamped()).toBeNull();
    online = "m-online";
    expect(stamped()).toBe("m-online");
    runtime.verifyStaffPin({ username: "omar", pin: "4821" });
    expect(stamped()).toBe("m-cashier"); // the offline unlock is who is at the till
    runtime.endStaffSession();
    expect(stamped()).toBe("m-online");
    online = null;
    expect(stamped()).toBeNull();
  });
});
