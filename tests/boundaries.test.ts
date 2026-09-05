import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = path.join(directory, entry);
    return statSync(filePath).isDirectory() ? sourceFiles(filePath) : [filePath];
  });
}

describe("packaged SDK and renderer boundaries", () => {
  it("locks the verified standalone SDK 0.4.0 artifact", () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["@shifted/clothing-commerce-sdk"]).toBe(
      "file:vendor/shifted-clothing-commerce-sdk-0.4.0.tgz",
    );
    const artifact = readFileSync(
      path.join(root, "vendor", "shifted-clothing-commerce-sdk-0.4.0.tgz"),
    );
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(
      "dc25109cd790d21e640a1501cf967e3926e79eb03e13345e29e08cf2a712410d",
    );
  });

  it("keeps Node, Electron, and server credentials out of renderer production code", () => {
    const rendererFiles = sourceFiles(path.join(root, "src", "renderer")).filter(
      (filePath) => !filePath.includes(".test."),
    );
    const rendererSource = rendererFiles
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");
    expect(rendererSource).not.toMatch(/from ["'](?:node:|electron)/);
    expect(rendererSource).not.toContain("CLERK_SECRET_KEY");
    expect(rendererSource).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("keeps the preload bridge limited to immutable runtime metadata", () => {
    const preload = readFileSync(path.join(root, "src", "preload", "preload.ts"), "utf8");
    expect(preload).toContain('exposeInMainWorld("foundation"');
    expect(preload).not.toMatch(/ipcRenderer|fetch\(|Authorization|token|secret/i);
  });
});
