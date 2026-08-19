import { describe, expect, it } from "vitest";

import { checkApiStatus } from "./api-status";

describe("POS API connectivity boundary", () => {
  it("reports connected for a valid health response", async () => {
    await expect(
      checkApiStatus({
        baseUrl: "https://api.example.test",
        fetch: async () => new Response(JSON.stringify({ status: "ok", version: "0.1.0" })),
      }),
    ).resolves.toBe("connected");
  });

  it("reports unavailable when the API cannot be reached", async () => {
    await expect(
      checkApiStatus({
        baseUrl: "https://api.example.test",
        fetch: async () => Promise.reject(new Error("offline")),
      }),
    ).resolves.toBe("unavailable");
  });

  it("reports unavailable for an invalid response", async () => {
    await expect(
      checkApiStatus({
        baseUrl: "https://api.example.test",
        fetch: async () => new Response(JSON.stringify({ status: "unknown", version: 1 })),
      }),
    ).resolves.toBe("unavailable");
  });
});
