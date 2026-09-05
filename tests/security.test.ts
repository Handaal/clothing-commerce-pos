import { describe, expect, it } from "vitest";

import { secureWebPreferences } from "../src/main/security";
import {
  isAllowedRendererNavigation,
  PRODUCTION_RENDERER_ORIGIN,
} from "../src/main/renderer-origin";

describe("Electron renderer security", () => {
  it("isolates and sandboxes the renderer without Node integration", () => {
    expect(secureWebPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it("uses an exact allowlistable packaged origin instead of an opaque file origin", () => {
    expect(PRODUCTION_RENDERER_ORIGIN).toBe("http://127.0.0.1:4173");
    expect(PRODUCTION_RENDERER_ORIGIN).not.toBe("null");
    expect(PRODUCTION_RENDERER_ORIGIN).not.toMatch(/^file:/);
  });

  it("allows Clerk to return within the renderer origin without permitting external navigation", () => {
    const rendererUrl = "http://127.0.0.1:5173";

    expect(isAllowedRendererNavigation("http://127.0.0.1:5173/?handshake=value", rendererUrl)).toBe(
      true,
    );
    expect(isAllowedRendererNavigation("http://127.0.0.1:5173/#/continue", rendererUrl)).toBe(true);
    expect(isAllowedRendererNavigation("https://accounts.example.test/", rendererUrl)).toBe(false);
    expect(isAllowedRendererNavigation("http://127.0.0.1:4173/", rendererUrl)).toBe(false);
    expect(isAllowedRendererNavigation("not a url", rendererUrl)).toBe(false);
  });
});
