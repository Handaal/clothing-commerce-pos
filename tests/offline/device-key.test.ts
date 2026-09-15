import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceKeyStore, DeviceKeyUnavailableError } from "../../src/main/offline/device-key";
import { makeHarness, TestSecureStorage } from "./fixtures";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe("protected Ed25519 device key", () => {
  it("generates, protects, reloads, and signs with the same identity", () => {
    const harness = makeHarness({ install: false });
    disposals.push(() => harness.dispose());
    const first = harness.keys.loadPublicKey();
    const serialized = readFileSync(harness.keys.path, "utf8");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(first.encoding).toBe("spki_der_base64");

    const reloaded = new DeviceKeyStore(harness.directory, new TestSecureStorage());
    expect(reloaded.loadPublicKey()).toEqual(first);
    expect(reloaded.signCanonical('{"sale":"one"}')).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("fails closed when secure storage is unavailable", () => {
    const harness = makeHarness({ install: false });
    disposals.push(() => harness.dispose());
    const unavailable = new DeviceKeyStore(harness.directory, new TestSecureStorage(false));
    expect(() => unavailable.loadPublicKey()).toThrow(DeviceKeyUnavailableError);
  });

  it("preserves a corrupt key file and fails closed", () => {
    const harness = makeHarness({ install: false });
    disposals.push(() => harness.dispose());
    writeFileSync(harness.keys.path, "corrupt", "utf8");
    expect(() => harness.keys.loadPublicKey()).toThrow(DeviceKeyUnavailableError);
    expect(readFileSync(harness.keys.path, "utf8")).toBe("corrupt");
  });
});
