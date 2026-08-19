import type { WebPreferences } from "electron";

export const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const satisfies WebPreferences;
