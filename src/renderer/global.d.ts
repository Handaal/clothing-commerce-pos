import type { ActivityBridge } from "../shared/activity";
import type { OfflineBridge } from "../shared/offline";
import type { PosAuthBridge } from "../shared/pos-auth";
import type { PosSessionBridge } from "../shared/pos-session";
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
    readonly view?: { readonly setZoom: (factor: number) => void };
    readonly offline: OfflineBridge;
    readonly returns: ReturnsBridge;
    readonly sales: SalesBridge;
    readonly activity: ActivityBridge;
    readonly posAuth?: PosAuthBridge;
    readonly posSession?: PosSessionBridge;
  }
}

export {};
