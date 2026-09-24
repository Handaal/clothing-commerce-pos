# Phase 2P — Connected POS Promotions

Connected-only, server-authoritative promotions for the cashier. The API owns all promotion money;
the desktop client never calculates a discount. Offline selling stays promotion-free and its
authority path is unchanged.

## Frozen V1 rules

- Exactly one promotion per order; no stacking.
- The server evaluates automatic promotions plus one optional entered code and applies the **greatest
  eligible saving**. A code does not automatically beat a better automatic promotion.
- No manual cashier discount, no customer-specific rules, no BOGO/tiers/gift cards.
- No offline promotions.

## SDK

Vendored `@shifted/clothing-commerce-sdk@0.12.0`
(`vendor/shifted-clothing-commerce-sdk-0.12.0.tgz`, SHA-256
`e2296c0300778ba3847065605d1863e86caea6042bd6063676bd60c40ef9b076`, enforced by
`tests/boundaries.test.ts`). The client uses the POS quote (`posQuote → PricingBreakdown`) and threads
the optional `promotionCode` intent into `createPosSale`. The SDK 0.12.0 runtime accepts
`promotionCode` on the POS sale request; the intent is added via a narrow extension of the SDK input
type rather than by hand-copying the DTO. No API source is imported.

## Connected flow

`cart → posQuote → optional code → gross / discount / net → tender → createPosSale (revalidates) →
receipt`.

- **Quote lifecycle** (`src/renderer/promotions/quote.ts`, `QuoteController`). Requotes on relevant
  basket/code/register changes, coalesced with a short debounce. Each request carries a monotonic
  sequence and a basket signature; a resolved response is discarded unless it is still the latest for
  the current basket, so a stale quote can never overwrite a newer one. The typed code draft is kept
  out of the controller — only the _applied_ code is quoted, so keystrokes never quote.
- **Sale intent** (`src/renderer/checkout/sale-executor.ts`). `expectedTotalMinor` is the authoritative
  net; `promotionCode` is included only when a code is applied (automatic promotions carry no code and
  are re-evaluated server-side).
- **Revalidation.** `PRICE_CHANGED`/`CURRENCY_CHANGED` and `PROMOTION_UNAVAILABLE` from the final sale
  stop the checkout, reload prices, force a fresh quote, and require explicit cashier reconfirmation
  before a new idempotency key is used. A changed amount is never silently finalized. Existing
  idempotency and ambiguous-retry behavior are preserved.

## UX

Minimal promotion panel in the checkout column: code input, Apply/Remove, loading state, applied and
automatic promotion summaries, gross subtotal, promotion discount, amount due, and a concise error
state. Tender (cash received/change) uses the net amount and is blocked while a quote is loading or
unavailable.

## Offline boundary

Untouched: offline grants, SQLite promotion-free state, the signed offline request format, outbox
schemas, replay, and bootstrap authority. When the quote is unreachable the panel says "Promotions
require a connection." and offers reconnect or continuing at authorized offline prices. Switching to
offline invalidates connected promotion pricing (`switchToOffline`), and the offline cashier builds
its own cart at authorized offline prices, so a connected discounted total is never carried into an
offline sale.

## Receipt

Uses the immutable returned sale: gross subtotal = Σ line totals, discount = gross − net
`order.totalMinor`, final total = net. The promotion name/code is taken from the quote the sale was
confirmed against, never reconstructed from current configuration.

## Returns

No change. The API already owns discounted refund calculations (net per-unit basis); the Return Desk
is compatible with SDK 0.12.0 and required no UI change.

## Tests

- `src/renderer/promotions/quote.test.ts` — requote on change, stale-response protection, signature
  de-duplication, applied-code threading, empty-basket reset, network error.
- `src/renderer/checkout/sale-executor.test.ts` — `promotionCode` reaches the request; final
  `PROMOTION_UNAVAILABLE` blocks a silent finalize.
- `src/renderer/App.test.tsx` — no-promotion sale, automatic promotion, valid code, invalid code,
  remove code, better automatic beats code, tender uses net, gross/discount/net + receipt rendering,
  final promotion change / usage exhaustion reconfirmation, promotions-require-connection, and
  connected→offline invalidation.
- Existing connected, offline, and Returns suites remain green.
