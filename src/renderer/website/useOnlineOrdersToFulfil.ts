import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useEffect, useState } from "react";

import { websiteAccess } from "./access";
import { ONLINE_ORDERS_CHANGED_EVENT } from "./online-orders-events";
import { loadOnlineOrders } from "./OnlineOrdersPanel";

const POLL_MS = 60_000;

/**
 * How many website orders are waiting to be shipped, for the sidebar badge — so a new online order is
 * noticed at the till instead of only when someone opens Website Management. One list read per minute
 * (the list carries fulfilment status since SDK 0.51; no per-order detail). `null` = unknown (no
 * orders.read, offline, an older server, or a failed read) and the badge stays hidden.
 */
export function useOnlineOrdersToFulfil(
  client: Pick<TenantCommerceClient, "getContext" | "listOrders"> | null,
  enabled: boolean,
): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!client || !enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const access = websiteAccess(await client.getContext());
        if (!access.ordersRead) {
          if (active) setCount(null);
          return; // No permission: stop polling.
        }
        const orders = await loadOnlineOrders(client);
        if (!active) return;
        if (orders.some((order) => order.status === "placed" && !order.fulfillmentStatus)) {
          setCount(null); // Server predates the list status; don't guess.
        } else {
          setCount(
            orders.filter(
              (order) => order.status === "placed" && order.fulfillmentStatus !== "fulfilled",
            ).length,
          );
        }
      } catch {
        if (active) setCount(null);
      }
      if (active) timer = setTimeout(() => void tick(), POLL_MS);
    };
    const refreshNow = () => {
      if (timer) clearTimeout(timer);
      void tick();
    };
    void tick();
    window.addEventListener(ONLINE_ORDERS_CHANGED_EVENT, refreshNow);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener(ONLINE_ORDERS_CHANGED_EVENT, refreshNow);
    };
  }, [client, enabled]);

  return enabled ? count : null;
}
