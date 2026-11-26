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
  | "website"
  | "suppliers"
  | "staff"
  | "activity"
  | "review"
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
  /** Website Management (storefront content, sales, publication, checkout). */
  website: boolean;
  suppliers: boolean;
  staff: boolean;
  activity: boolean;
  settings: boolean;
}

// Sidebar groups, in display order: selling first, then the store, insights, and till/team admin.
export type SectionGroup = "sell" | "store" | "insights" | "admin";
export const SECTION_GROUPS: readonly SectionGroup[] = ["sell", "store", "insights", "admin"];

export interface SectionDef {
  id: SectionId;
  group: SectionGroup;
  labelKey: string;
  icon: IconName;
  // Returns whether this operator may see the section. `pos` is always available to any signed-in
  // operator; management sections require their capability (or manager fallback).
  visible: (caps: Capabilities) => boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "pos", group: "sell", labelKey: "nav.pos", icon: "pos", visible: () => true },
  { id: "orders", group: "sell", labelKey: "nav.orders", icon: "orders", visible: (c) => c.orders },
  {
    id: "customers",
    group: "sell",
    labelKey: "nav.customers",
    icon: "customers",
    visible: (c) => c.customers,
  },
  {
    id: "inventory",
    group: "store",
    labelKey: "nav.inventory",
    icon: "inventory",
    visible: (c) => c.inventory,
  },
  {
    id: "suppliers",
    group: "store",
    labelKey: "nav.suppliers",
    icon: "suppliers",
    visible: (c) => c.suppliers,
  },
  // Inside the desk, `/me/context` further narrows each area to what the server allows this operator.
  {
    id: "website",
    group: "store",
    labelKey: "nav.website",
    icon: "website",
    visible: (c) => c.website,
  },
  {
    id: "vouchers",
    group: "store",
    labelKey: "nav.vouchers",
    icon: "vouchers",
    visible: (c) => c.vouchers,
  },
  {
    id: "reports",
    group: "insights",
    labelKey: "nav.reports",
    icon: "reports",
    visible: (c) => c.reports,
  },
  {
    id: "activity",
    group: "insights",
    labelKey: "nav.activity",
    icon: "activity",
    visible: (c) => c.activity,
  },
  { id: "staff", group: "admin", labelKey: "nav.staff", icon: "staff", visible: (c) => c.staff },
  // The offline sync review belongs to the till itself (whoever operates it must be able to see work
  // the server refused), so it is visible to every signed-in operator. It reads only local state.
  { id: "review", group: "admin", labelKey: "nav.review", icon: "sync", visible: () => true },
  {
    id: "settings",
    group: "admin",
    labelKey: "nav.settings",
    icon: "settings",
    visible: (c) => c.settings,
  },
] as const;

export function accessibleSections(caps: Capabilities): readonly SectionDef[] {
  return SECTIONS.filter((section) => section.visible(caps));
}
