import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCTION_RENDERER_ORIGIN, rendererFilePath } from "../src/main/renderer-origin";

describe("packaged renderer origin", () => {
  const root = path.resolve("dist");

  it("has one exact non-opaque production origin", () => {
    expect(PRODUCTION_RENDERER_ORIGIN).toBe("http://127.0.0.1:4173");
  });

  it("maps only renderer resources inside dist", () => {
    expect(rendererFilePath(root, "/index.html")).toBe(path.join(root, "index.html"));
    expect(rendererFilePath(root, "https://example.test/index.html")).toBeNull();
  });

  it("keeps normalized and encoded traversal inside the renderer root", () => {
    expect(rendererFilePath(root, "/%2e%2e/secret.txt")).toBe(path.join(root, "secret.txt"));
    expect(rendererFilePath(root, "/%2e%2e%5csecret.txt")).toBeNull();
  });
});
