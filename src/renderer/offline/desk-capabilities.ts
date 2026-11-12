import type { SectionId } from "../shell/sections";
import type { DeskOfflineCapability } from "./desk-status";

// The single source of truth for *what each management desk can do offline*, derived from the §13.3
// / §15.3 all-desks matrix in docs/offline-first-roadmap.md. The shell renders one `OfflineDeskBanner`
// per desk from this table, so a desk's offline honesty is declared in exactly one place instead of
// being re-decided inside each desk component.
//
// `pos` is intentionally absent: the cashier owns its own richer sync UI (OfflineRunwayNote + the
// sync badge in cashier.tsx), so the shell does not stack the generic banner on top of it.
export interface DeskOfflineProfile {
  readonly capability: DeskOfflineCapability;
  /** Precise reason key for online-only / blocked desks (omitted for offline-capable desks). */
  readonly reasonKey?: string;
}

export const DESK_OFFLINE_PROFILES: Partial<Record<SectionId, DeskOfflineProfile>> = {
  // Cached order detail re-opens offline; no offline mutation (OrdersDesk stale-while-revalidate cache).
  orders: { capability: "cached-read", reasonKey: "desk.reason.orders" },
  // Global append-only stock ledger authority (ADR-017/023) — no offline path today.
  inventory: { capability: "online-only", reasonKey: "desk.reason.inventory" },
  // Management directory is server-authoritative; cashier customer *capture* still rides the sale.
  customers: { capability: "online-only", reasonKey: "desk.reason.customers" },
  // Company-wide reports are server-built; the on-device summary is rendered separately below.
  reports: { capability: "online-only", reasonKey: "desk.reason.reports" },
  // Server-computed discount money; applying promotions offline is architecturally forbidden.
  vouchers: { capability: "online-only", reasonKey: "desk.reason.vouchers" },
  // Back-office AP money — needs a connection.
  suppliers: { capability: "online-only", reasonKey: "desk.reason.suppliers" },
  // Staff management is online-only; offline attendance capture (Deliverable B) lives in the cashier.
  staff: { capability: "online-only", reasonKey: "desk.reason.staff" },
  // Device-local activity ledger — fully available offline (not the server activity feed).
  activity: { capability: "local-only" },
  // Local POS-user/PIN prefs apply immediately; device/shared governance needs a connection.
  settings: { capability: "online-only", reasonKey: "desk.reason.settings" },
};
