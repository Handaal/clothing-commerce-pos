import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isPosPinFormat,
  isTransportablePosPin,
  POS_AUTH_IPC_CHANNELS,
  POS_CREDENTIAL_MAX_CHARS,
  POS_PIN_MIN_LENGTH,
} from "../src/shared/pos-auth";

// ADR-043 boundary proofs: the POS has no Clerk anywhere in source/config/build, one PIN rule (digits, min 4,
// no product max), and no device-local credential channel.
const root = process.cwd();

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe("POS has no Clerk", () => {
  it("package.json declares no Clerk dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    expect(Object.keys(all).filter((name) => name.toLowerCase().includes("clerk"))).toEqual([]);
  });

  it("no source, preload, main, build config or env example imports or reads Clerk", () => {
    const sources = [
      ...files(path.join(root, "src")).filter(
        (file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."),
      ),
      path.join(root, "vite.config.mts"),
      path.join(root, ".env.example"),
      path.join(root, "index.html"),
    ];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/@clerk\//);
      expect(text, file).not.toMatch(/CLERK_PUBLISHABLE_KEY|ClerkProvider|useClerk|useSignIn/);
    }
  });

  it("the CSP no longer admits remote scripts, frames or form targets (the Clerk CDN allowances are gone)", () => {
    for (const file of ["index.html", "src/main/renderer-server.ts"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).toContain("script-src 'self';");
      expect(text, file).toContain("frame-src 'none'");
      expect(text, file).toContain("form-action 'none'");
      expect(text, file).not.toMatch(/script-src 'self' https:/);
    }
  });
});

describe("POS PIN rule", () => {
  it("is digits only, at least 4, with no product maximum", () => {
    expect(POS_PIN_MIN_LENGTH).toBe(4);
    for (const pin of ["1234", "00000000", "123456789012", "1".repeat(13), "9".repeat(5000)])
      expect(isPosPinFormat(pin)).toBe(true);
    for (const pin of ["", "123", "12a4", "١٢٣٤", "１２３４", " 1234", "1234\n", null, 1234])
      expect(isPosPinFormat(pin)).toBe(false);
  });

  it("separates the transport ceiling (malformed message) from the PIN rule", () => {
    expect(POS_CREDENTIAL_MAX_CHARS).toBe(16_384);
    expect(isTransportablePosPin("7".repeat(POS_CREDENTIAL_MAX_CHARS))).toBe(true);
    expect(isTransportablePosPin("7".repeat(POS_CREDENTIAL_MAX_CHARS + 1))).toBe(false);
    expect(isPosPinFormat("7".repeat(POS_CREDENTIAL_MAX_CHARS + 1))).toBe(true);
  });

  it("no retired 8/12-digit cap survives in POS source", () => {
    const sources = files(path.join(root, "src")).filter(
      (file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."),
    );
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/POS_PIN_MAX_LENGTH|MAX_PIN\b|\{4,(8|12)\}|\d\{4,8\}/);
    }
  });
});

describe("no device-local credential channel", () => {
  it("the roster-cache IPC has no login/PIN/verify channel", () => {
    expect(Object.keys(POS_AUTH_IPC_CHANNELS).sort()).toEqual([
      "count",
      "replaceRosterCache",
      "roster",
    ]);
    const preload = readFileSync(path.join(root, "src", "preload", "preload.ts"), "utf8");
    expect(preload).not.toMatch(/pos-auth:(login|set-pin|verify-pin|create-user|update-user)/);
  });
});
