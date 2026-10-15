import type { IconName } from "./icons";

// The ten workspace sections. `pos` is the connected cashier that already exists; the rest are
// scaffolded now and filled in subsequent phases. Order here is the sidebar order.
export type SectionId =
  | "pos"
  | "orders"
  | "inventory"
  | "customers"
  | "reports"
  | "vouchers"
  | "suppliers"
  | "staff"
  | "activity"
  | "settings";

// Coarse capability surface used for role-gating the sidebar. It is intentionally independent of
// any single SDK version: `App` builds it from the operator's server-resolved access guidance. Any
// unknown capability falls back to the `isManager` heuristic so a pure cashier sees only selling.
export interface Capabilities {
  isManager: boolean;
  orders: boolean;
  inventory: boolean;
  customers: boolean;
  reports: boolean;
  vouchers: boolean;
  suppliers: boolean;
  staff: boolean;
  activity: boolean;
  settings: boolean;
}

export interface SectionDef {
  id: SectionId;
  labelKey: string;
  icon: IconName;
  // Returns whether this operator may see the section. `pos` is always available to any signed-in
  // operator; management sections require their capability (or manager fallback).
  visible: (caps: Capabilities) => boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "pos", labelKey: "nav.pos", icon: "pos", visible: () => true },
  { id: "orders", labelKey: "nav.orders", icon: "orders", visible: (c) => c.orders },
  { id: "inventory", labelKey: "nav.inventory", icon: "inventory", visible: (c) => c.inventory },
  { id: "customers", labelKey: "nav.customers", icon: "customers", visible: (c) => c.customers },
  { id: "reports", labelKey: "nav.reports", icon: "reports", visible: (c) => c.reports },
  { id: "vouchers", labelKey: "nav.vouchers", icon: "vouchers", visible: (c) => c.vouchers },
  { id: "suppliers", labelKey: "nav.suppliers", icon: "suppliers", visible: (c) => c.suppliers },
  { id: "staff", labelKey: "nav.staff", icon: "staff", visible: (c) => c.staff },
  { id: "activity", labelKey: "nav.activity", icon: "activity", visible: (c) => c.activity },
  { id: "settings", labelKey: "nav.settings", icon: "settings", visible: (c) => c.settings },
] as const;

export function accessibleSections(caps: Capabilities): readonly SectionDef[] {
  return SECTIONS.filter((section) => section.visible(caps));
}
