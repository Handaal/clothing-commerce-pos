import {
  validateContentForm as validateContentIssues,
  type StorefrontContentForm,
} from "@shifted/clothing-commerce-sdk";

import { toFieldErrors, type FieldError } from "./form-issues";

// Home-page content editor. The rules (length limits, safe button link, featured limits) and the
// request builder are the SDK's shared management form rules (also used by Admin Mobile); this module
// only adds the POS wording. The API re-validates every field, id ownership and the image path.

export {
  buildContentRequest,
  contentToForm,
  isSafeCtaHref,
  MAX_FEATURED_COLLECTIONS,
  MAX_FEATURED_PRODUCTS,
  moveSelection,
  STOREFRONT_CONTENT_LIMITS as CONTENT_LIMITS,
  type StorefrontContentForm,
} from "@shifted/clothing-commerce-sdk";
export type { FieldError } from "./form-issues";

export type StorefrontContentErrors = Partial<Record<keyof StorefrontContentForm, FieldError>>;

export function validateContentForm(form: StorefrontContentForm): StorefrontContentErrors {
  return toFieldErrors<StorefrontContentForm>("content", validateContentIssues(form));
}
