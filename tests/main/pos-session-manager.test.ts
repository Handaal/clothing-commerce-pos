// Offline PIN v2, same-PIN model: the connected sign-in hands the just-accepted credential to the offline PIN
// refresh in the MAIN process only — after success, never on failure, and without delaying or failing sign-in.
import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ posPinLogin: vi.fn() }));
vi.mock("@shifted/clothing-commerce-sdk", () => ({
  SDK_VERSION: "test",
  createCommerceClient: () => ({ posPinLogin: sdk.posPinLogin }),
}));

import { classifyPosAuthFailure, PosSessionManager } from "../../src/main/pos-session/manager";
import type { PosSessionStore } from "../../src/main/pos-session/store";

const operator = {
  membershipId: "20000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000001",
  username: "dana",
  displayName: "Dana",
  role: "cashier" as const,
  permissions: [],
};
const store = { save: vi.fn() } as unknown as PosSessionStore;

describe("PosSessionManager — offline PIN refresh after sign-in", () => {
  it("passes the accepted credential to the refresh after a successful sign-in", async () => {
    sdk.posPinLogin.mockResolvedValueOnce({
      accessToken: "token",
      expiresAt: "2026-11-16T00:00:00.000Z",
      operator,
    });
    const onSignedIn = vi.fn(async () => undefined);
    const manager = new PosSessionManager("http://127.0.0.1:1", store, undefined, onSignedIn);
    await expect(manager.login("dana", "4821")).resolves.toMatchObject({ ok: true });
    expect(onSignedIn).toHaveBeenCalledWith({
      tenantId: operator.tenantId,
      membershipId: operator.membershipId,
      accessToken: "token",
      username: "dana",
      pin: "4821",
    });
  });

  it("never calls the refresh when sign-in fails", async () => {
    sdk.posPinLogin.mockRejectedValueOnce(
      Object.assign(new Error("bad"), { status: 401, code: "INVALID_CREDENTIALS" }),
    );
    const onSignedIn = vi.fn(async () => undefined);
    const manager = new PosSessionManager("http://127.0.0.1:1", store, undefined, onSignedIn);
    await expect(manager.login("dana", "0000")).resolves.toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("a failing or slow refresh never fails or delays the sign-in", async () => {
    sdk.posPinLogin.mockResolvedValueOnce({
      accessToken: "token",
      expiresAt: "2026-11-16T00:00:00.000Z",
      operator,
    });
    const onSignedIn = vi.fn(
      () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("x")), 50)),
    );
    const manager = new PosSessionManager("http://127.0.0.1:1", store, undefined, onSignedIn);
    await expect(manager.login("dana", "4821")).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 80)); // rejection is swallowed (no unhandled error)
  });
});

// ADR-043 §4: only a genuine outage may lead to offline fallback; every definitive rejection must not.
describe("classifyPosAuthFailure", () => {
  it.each([
    [{ name: "ApiNetworkError" }, "OFFLINE"],
    [{ name: "ApiHttpError", status: 502 }, "OFFLINE"],
    [{ name: "ApiHttpError", status: 503 }, "OFFLINE"],
    [{ name: "ApiHttpError", status: 504 }, "OFFLINE"],
    [{ name: "ApiHttpError", status: 503, code: "POS_AUTH_NOT_CONFIGURED" }, "NOT_CONFIGURED"],
    [{ name: "ApiHttpError", status: 400, code: "VALIDATION_ERROR" }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 401, code: "INVALID_CREDENTIALS" }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 403 }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 404 }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 413, code: "PAYLOAD_TOO_LARGE" }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 429, code: "ACCOUNT_LOCKED" }, "INVALID_CREDENTIALS"],
    [{ name: "ApiHttpError", status: 500 }, "ERROR"],
    [{ name: "ApiContractError" }, "ERROR"],
    [new Error("boom"), "ERROR"],
    [undefined, "ERROR"],
  ])("%j → %s", (error, expected) => {
    expect(classifyPosAuthFailure(error)).toBe(expected);
  });

  it("verifyCredentials (step-up) never caches a session", async () => {
    const save = vi.fn();
    sdk.posPinLogin.mockResolvedValueOnce({
      accessToken: "step-up-token",
      expiresAt: "2026-11-16T00:00:00.000Z",
      operator: { ...operator, role: "admin" },
    });
    const manager = new PosSessionManager("http://127.0.0.1:1", {
      save,
    } as unknown as PosSessionStore);
    await expect(manager.verifyCredentials("mariam", "4821")).resolves.toEqual({
      ok: true,
      role: "admin",
    });
    expect(save).not.toHaveBeenCalled();
  });
});
