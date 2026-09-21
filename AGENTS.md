# POS Desktop Engineering Rules

**Before changing code, read (in order):**

1. This file and this repo's `README.md`.
2. The API canonical platform state: `clothing-commerce-api/docs/platform/current-v1-state.md`
   (verified merged state, invariants, current SDK, deferred decisions, roadmap).
3. The current SDK README (this repo vendors `@shifted/clothing-commerce-sdk`; see `package.json` for
   the pinned version) and the POS phase docs in the API repo (`docs/pos/*`).

Repo-specific invariants: **do not import API source.** Preserve the secure Electron boundary
(main/preload/renderer separation, context isolation, disabled Node integration, sandboxing). Preserve
offline durability and **exact-replay** ingestion — local SQLite/outbox is operational state only,
never global truth. The Commerce API is authoritative for rules, authorization, orders, and inventory.

---

1. TypeScript strict mode and zero TypeScript errors are mandatory.
2. This repository is an Electron desktop sales channel only.
3. Preserve main/preload/renderer separation, context isolation, disabled Node integration,
   renderer sandboxing, web security, and a minimal typed preload bridge.
4. Never expose unrestricted Node or Electron APIs to the renderer; isolate future hardware access.
5. Never store server secrets or directly access privileged business database tables.
6. The Commerce API is authoritative for business rules, authorization, orders, and inventory.
7. Future SQLite is cache/offline operational state only and is never globally authoritative.
8. Offline changes must eventually synchronize through versioned, idempotent API operations.
9. POS and online share one central product, inventory, order, and customer domain.
10. Maintain compatibility with supported API/SDK versions and installed-client grace periods.
11. Do not add checkout, hardware, SQLite, synchronization, or business features in Phase 1A-R.
12. Run install, format, lint, typecheck, tests, and production packaging for completed work.
