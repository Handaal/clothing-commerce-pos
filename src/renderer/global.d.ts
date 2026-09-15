import type { OfflineBridge } from "../shared/offline";

declare global {
  interface ImportMetaEnv {
    readonly COMMERCE_API_URL?: string;
  }

  interface Window {
    readonly foundation: {
      readonly platform: string;
      readonly versions: Readonly<{ electron: string; chrome: string }>;
    };
    readonly offline: OfflineBridge;
  }
}

export {};
