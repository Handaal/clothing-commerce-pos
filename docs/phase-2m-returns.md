# Phase 2M connected POS returns

Starting clean main: `5c50d66774ad5be6ed3e0ffa83797d2410b52f93`.
Branch: `phase/2m-pos-returns`.

Before implementation, the final SDK 0.8.0 artifact was checked against the merged API's
`docs/development/phase-2m-validation.md`: SHA-256
`3bc355f638426993a7d7bd69c818855b1776540630d9701f03c770aa3fae3056`.
The vendored artifact, dependency, lockfile and boundary checksum test use that exact package.

## Cashier flow

1. Open **Returns and refunds** from an authenticated tenant/register session. The screen checks API
   health and browser connectivity; a browser offline event disables submission immediately.
2. Load authorized connected POS orders for the selected branch. Filter loaded pages by public order
   number, or load further pages. SDK 0.8.0 has no server order-number query; no unsupported search
   parameter is sent. Unsynchronized local receipts must synchronize before becoming connected orders.
3. Select an order. Order detail supplies product/SKU labels; eligibility supplies purchased,
   previously returned, remaining eligible quantities, original unit amounts and maximum refundable
   amount. The server's eligibility state/reason is displayed. No refund amount is computed locally.
4. Select received lines, whole positive quantities within server eligibility, and a reason per line.
   Tenant `allowedReasons` produces a dropdown; otherwise a controlled nonblank text field is capped
   at the SDK's 500 characters. Dispositions are exactly `restock` and `non_restock`.
5. RESTOCK clearly names the current register's default destination. The API independently enforces
   active sellable location and receiving permission. All NON-RESTOCK requests omit the destination
   (`null`) and do not increase sellable stock. This release does not add a cross-location selector.
6. Review and confirm received merchandise. `createReturn` sends quantities, reasons, dispositions,
   destination and `refundMode: pending`, with a stable idempotency header. The API calculates money
   and atomically records Return, Refund and any stock receipt.
7. Inspect the canonical amount/status. For eligible cash/COD, only after handing back that exact
   amount, enter settlement evidence (up to 200 characters), attest the cash hand-back, and use
   `settleRefund`. This command has its own stable key. The API records `succeeded`; the POS does not
   claim to physically move cash. Electronic refunds cannot be manually settled here.
8. The result shows the original order, product/SKU, returned quantities, disposition, reasons,
   server amounts, exact refund state and timestamps. Pending/failed states remain explicit.
   Paginated return history can reopen a pending return for later settlement or refresh its state.

## Retry and offline boundary

Commands are retained in memory during the connected return intent. Double submissions share an
in-flight request; exact retry reuses the key and payload. Editing intent, changing order, or explicitly
refreshing to start another return generates a new key, even for identical repeated partial returns.
Network, server, contract or other unknown write outcomes lock edits, register changes, sign-out,
offline mode and closing the return panel until exact retry resolves the outcome. A before-unload
guard protects normal window closure; forced process termination still loses in-memory intent.
After forced termination, inspect canonical return history before starting another return or handing
back cash. This phase adds no durable return queue or automatic retry worker.

The return module has no offline bridge, SQLite, inventory projection or outbox dependency. Offline
cashier UI explicitly disables returns. Health is polled every five seconds; network failure during
a write is an unknown result, never local success. Connected sales, offline sales, device grants,
receipt sequencing and synchronization retain their existing implementation. Refresh offline data
remains the canonical snapshot reconciliation path; return success makes no local stock adjustment.

## API contract limitations

- SDK 0.8.0 exposes an internal Return UUID but no public Return number/reference. The UI states that
  the reference is unavailable and shows original order plus timestamp. It does not expose or shorten
  UUIDs or invent a receipt number. A canonical public return reference is the remaining API blocker
  for the requested public-reference field.
- There is no quote/preview operation for the selected refund. The pre-confirmation screen therefore
  shows server eligibility amounts; the exact refund is displayed after canonical acceptance. Pending
  creation followed by explicit cash settlement avoids handing back a locally calculated amount.
- Tenant return/manual-settlement settings and operator permissions remain server-controlled and
  disabled by default for live tenants. No production policy or fake gateway settlement is introduced.

## Acceptance harness

`pnpm acceptance:returns` requires Docker and the merged API checkout (default sibling directory;
override with `COMMERCE_API_CHECKOUT`). It reuses the API's guarded disposable Supabase/Next.js runner,
without modifying the API checkout or touching the regular development database. The disposable
operator receives inventory-read permission solely for SDK stock assertions. POS test processes get
only the local API URL and locally signed Clerk-verifiable test session, never the generated service
role credential. No real customer cash is exchanged in automated acceptance.

The API's 19 HTTP tests and 228 RLS assertions run first. POS tests then exercise the packed SDK and
production command class against real HTTP/PostgreSQL for scenarios A–E. A separate test renders the
production return screen in JSDOM against that same API and drives lookup, disconnect/reconnect,
confirmation and cash settlement. The offline assertion uses the real local SQLite implementation
and compares outbox rows and projected inventory before/after denied submission. The regular unit
run skips these environment-dependent tests; the acceptance command executes them explicitly.

## Executed validation — 2026-09-20

- Frozen pnpm install; full Prettier format and check; ESLint; strict renderer/main/test TypeScript:
  passed with zero TypeScript errors.
- 83 unit/regression tests passed across 22 files, including eight return tests and the existing
  connected sale, offline sale, synchronization, receipt, inventory projection and security suites.
  Three runtime tests were skipped in the ordinary run and executed by the acceptance harness.
- Disposable API: 19 real HTTP tests and 228 RLS assertions passed. Packed SDK POS scenarios A–E
  passed, plus the production return screen against the same API in JSDOM. A two-unit sale followed
  by one RESTOCK return refunded USD 25.00 successfully and increased stock by one; excess quantity
  was rejected without changes; the second NON-RESTOCK return refunded USD 25.00 without increasing
  stock. Exact create/settlement replay preserved the Return/Refund/stock receipt and two-return count.
  Disconnected submission changed neither real SQLite outbox rows nor projected/authoritative stock.
- Electron persistence/restart acceptance passed with Windows secure storage, Electron 43.3.0,
  embedded Node 24.18.1 and SQLite 3.53.1. Receipt, command key, hash and projected stock survived
  abrupt termination and restart; the expired outbox lease was recovered.
- Packaged SQLite probe passed (WAL, FULL synchronous, foreign keys and durable readback).
- Production `pnpm build` created `release/win-unpacked/Commerce POS.exe`; origin checks passed for
  development port 5173 and packaged-style port 4173. This is a packaged directory build.
- `git diff --check` and staged diff checks passed. The API checkout was unchanged; the existing
  development Supabase containers remained running after disposable acceptance cleanup.

The return UI acceptance is automated component execution with real HTTP/database state, not a
claim that a human exchanged cash or manually operated a signed-in Electron window in this run.
