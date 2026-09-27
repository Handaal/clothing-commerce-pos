import type { OfflineBridge } from "../shared/offline";
import type { ReturnsBridge } from "../shared/returns";
import type { SalesBridge } from "../shared/sales";

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
    readonly returns: ReturnsBridge;
    readonly sales: SalesBridge;
  }
}

export {};
