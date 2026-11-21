/** Fired by the Online orders panel after a fulfil/cancel so the sidebar badge updates at once. */
export const ONLINE_ORDERS_CHANGED_EVENT = "pos:online-orders-changed";

export function announceOnlineOrdersChanged(): void {
  window.dispatchEvent(new Event(ONLINE_ORDERS_CHANGED_EVENT));
}
