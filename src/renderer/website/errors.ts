import { ApiHttpError } from "@shifted/clothing-commerce-sdk";

import { classifyCommerceError } from "../commerce/errors";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// Website-management wording for API failures. The shared classifier's network/conflict copy talks
// about *sales* at the till, so the desk maps kinds to its own keys and keeps the server's message for
// validation (it names the offending field). Mirrors Admin Mobile's `describePromotionWriteError`.
export function describeWebsiteError(error: unknown, t: Translate): string {
  if (error instanceof ApiHttpError) {
    switch (error.code) {
      case "PROMOTION_ECONOMICS_LOCKED":
        return t("website.err.economicsLocked");
      case "IDEMPOTENCY_CONFLICT":
        return t("website.err.duplicate");
      case "ORDER_ALREADY_FULFILLED":
        return t("website.err.orderShipped");
      case "ORDER_CANCELLED":
        return t("website.err.orderCancelled");
      case "ORDER_NOT_FULLY_SHIPPED":
        return t("website.err.notFullyShipped");
      case "PAYMENT_NOT_CASH_ON_DELIVERY":
        return t("website.err.notCod");
      case "OVER_FULFILLMENT":
        return t("website.err.overFulfilment");
      case "INSUFFICIENT_STOCK":
        return t("website.err.noStock");
      case "FULFILLMENT_LOCATION_UNRESOLVED":
        return t("website.err.noReservation");
      case "LOCATION_INACTIVE":
      case "LOCATION_CAPABILITY_DENIED":
        return t("website.err.locationUnavailable");
      case "ORDER_NOT_FOUND":
      case "PROMOTION_NOT_FOUND":
      case "SALE_NOT_FOUND":
      case "NOT_FOUND":
        return t("website.err.notFound");
      default:
        break;
    }
  }
  const view = classifyCommerceError(error);
  switch (view.kind) {
    case "network":
      return t("website.err.network");
    case "auth":
      return t("website.err.auth");
    case "forbidden":
      return t("website.err.forbidden");
    case "contract":
      return t("website.err.contract");
    case "conflict":
      return view.message || t("website.err.changed");
    default:
      return view.message || t("website.err.generic");
  }
}
