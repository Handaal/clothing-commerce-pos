import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMainApiOrigin } from "../../src/main/runtime-config";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pos-runtime-config-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(directory, "runtime-config.json"), JSON.stringify(value), "utf8");
}

describe("resolveMainApiOrigin", () => {
  it("reads the packaged artifact and normalizes it", () => {
    writeConfig({ commerceApiUrl: "https://api.example.com/" });
    expect(resolveMainApiOrigin({ configDirectory: directory, isDevelopment: false })).toBe(
      "https://api.example.com",
    );
  });

  it("prefers the packaged artifact even in development", () => {
    writeConfig({ commerceApiUrl: "https://packaged.example.com" });
    expect(
      resolveMainApiOrigin({
        configDirectory: directory,
        isDevelopment: true,
        env: { COMMERCE_API_URL: "https://ignored.example.com" } as NodeJS.ProcessEnv,
      }),
    ).toBe("https://packaged.example.com");
  });

  it("fails closed in a packaged app when the artifact is missing", () => {
    expect(() =>
      resolveMainApiOrigin({ configDirectory: directory, isDevelopment: false }),
    ).toThrow(/runtime configuration/i);
  });

  it("rejects a corrupt artifact rather than falling back to localhost", () => {
    writeFileSync(join(directory, "runtime-config.json"), "{ not json", "utf8");
    expect(() =>
      resolveMainApiOrigin({ configDirectory: directory, isDevelopment: false }),
    ).toThrow(/not valid JSON/i);
  });

  it("uses env then localhost only in development when no artifact exists", () => {
    expect(
      resolveMainApiOrigin({
        configDirectory: directory,
        isDevelopment: true,
        env: { COMMERCE_API_URL: "https://dev.example.com" } as NodeJS.ProcessEnv,
      }),
    ).toBe("https://dev.example.com");
    expect(
      resolveMainApiOrigin({
        configDirectory: directory,
        isDevelopment: true,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBe("http://localhost:3000");
  });
});
