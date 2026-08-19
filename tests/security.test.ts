import { describe, expect, it } from "vitest";

import { secureWebPreferences } from "../src/main/security";

describe("Electron renderer security", () => {
  it("isolates and sandboxes the renderer without Node integration", () => {
    expect(secureWebPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});
