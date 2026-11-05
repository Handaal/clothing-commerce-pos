import type { PosUser } from "../../shared/pos-auth";
import type { Capabilities } from "../shell/sections";

// Every management section on. Used for an admin operator and as the permissive default when no local
// operator gates the session (e.g. a non-Electron test host with no posAuth bridge).
const ALL_CAPABILITIES: Capabilities = {
  isManager: true,
  orders: true,
  inventory: true,
  customers: true,
  reports: true,
  vouchers: true,
  suppliers: true,
  staff: true,
  activity: true,
  settings: true,
};

// Map a locally-authenticated operator to the sidebar capability surface. Admins see everything; a
// cashier sees only the sections explicitly granted in `permissions` (POS selling is always available
// via the section definition itself). Null operator → permissive default (unchanged legacy behaviour).
export function capabilitiesForOperator(operator: PosUser | null): Capabilities {
  if (!operator || operator.role === "admin") return ALL_CAPABILITIES;
  const granted = new Set(operator.permissions ?? []);
  return {
    isManager: false,
    orders: granted.has("orders"),
    inventory: granted.has("inventory"),
    customers: granted.has("customers"),
    reports: granted.has("reports"),
    vouchers: granted.has("vouchers"),
    suppliers: granted.has("suppliers"),
    staff: granted.has("staff"),
    activity: granted.has("activity"),
    settings: granted.has("settings"),
  };
}
