import { describe, expect, it } from "vitest";

import {
  DEV_DEFAULT_API_ORIGIN,
  normalizeApiOrigin,
  readRuntimeConfigOrigin,
  resolveApiOrigin,
} from "./api-origin";

describe("normalizeApiOrigin", () => {
  it("strips trailing slashes from a valid origin", () => {
    expect(normalizeApiOrigin("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeApiOrigin("https://api.example.com/base//")).toBe(
      "https://api.example.com/base",
    );
  });

  it("rejects blank, malformed, and non-http(s) origins", () => {
    expect(() => normalizeApiOrigin("")).toThrow();
    expect(() => normalizeApiOrigin("   ")).toThrow();
    expect(() => normalizeApiOrigin("not-a-url")).toThrow();
    expect(() => normalizeApiOrigin("ftp://api.example.com")).toThrow();
    expect(() => normalizeApiOrigin("file:///etc/passwd")).toThrow();
  });
});

describe("resolveApiOrigin", () => {
  it("returns a configured origin in either mode", () => {
    expect(resolveApiOrigin({ value: "https://api.example.com", mode: "production" })).toBe(
      "https://api.example.com",
    );
    expect(resolveApiOrigin({ value: "https://api.example.com", mode: "development" })).toBe(
      "https://api.example.com",
    );
  });

  it("falls back to localhost only in development", () => {
    expect(resolveApiOrigin({ value: "", mode: "development" })).toBe(DEV_DEFAULT_API_ORIGIN);
    expect(resolveApiOrigin({ value: undefined, mode: "development" })).toBe(
      DEV_DEFAULT_API_ORIGIN,
    );
  });

  it("fails closed in production when no origin is configured", () => {
    expect(() => resolveApiOrigin({ value: "", mode: "production" })).toThrow(/required/i);
    expect(() => resolveApiOrigin({ value: undefined, mode: "production" })).toThrow(/required/i);
  });

  it("rejects an invalid configured origin in production", () => {
    expect(() => resolveApiOrigin({ value: "localhost", mode: "production" })).toThrow();
  });
});

describe("readRuntimeConfigOrigin", () => {
  it("reads and normalizes a valid artifact", () => {
    expect(readRuntimeConfigOrigin({ commerceApiUrl: "https://api.example.com/" })).toBe(
      "https://api.example.com",
    );
  });

  it("rejects a malformed artifact", () => {
    expect(() => readRuntimeConfigOrigin(null)).toThrow();
    expect(() => readRuntimeConfigOrigin({})).toThrow();
    expect(() => readRuntimeConfigOrigin({ commerceApiUrl: 42 })).toThrow();
    expect(() => readRuntimeConfigOrigin({ commerceApiUrl: "ftp://x" })).toThrow();
  });
});
