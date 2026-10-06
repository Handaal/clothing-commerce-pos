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
  it("locks the verified combined (split-tender + attendance) SDK 0.16.0 artifact", () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["@shifted/clothing-commerce-sdk"]).toBe(
      "file:vendor/shifted-clothing-commerce-sdk-0.16.0.tgz",
    );
    const artifact = readFileSync(
      path.join(root, "vendor", "shifted-clothing-commerce-sdk-0.16.0.tgz"),
    );
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(
      "65c6d1b42e8b9513b255664f3beca1eaff3fcca2c25458ef2c021827c975114f",
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

  it("keeps the preload bridge limited to named typed capabilities", () => {
    const preload = readFileSync(path.join(root, "src", "preload", "preload.ts"), "utf8");
    expect(preload).toContain('exposeInMainWorld("foundation"');
    expect(preload).toContain('exposeInMainWorld("offline"');
    expect(preload).not.toMatch(/executeSql|databasePath|readFile|writeFile|privateKey|signature/i);
    expect(preload).not.toContain("ipcRenderer.send");
    expect(preload).not.toMatch(/import\s*\{[^}]*OFFLINE_IPC_CHANNELS/);
  });
});
