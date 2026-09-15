# Clothing Commerce POS

Secure Electron cashier application with Connected POS Sale V1 and the complete Phase 2I offline
cashier and synchronization slice. An authenticated Clerk operator can select an authorized tenant
and register, sell through the connected Commerce API, enable offline selling from real server
authority, accept durable local cash sales without the API, and synchronize those sales later.

## Boundaries and ownership

This repository owns the desktop UI, Electron lifecycle, secure preload boundary, and cashier
interaction state. The Commerce API remains authoritative for operator authorization, register and
branch context, default inventory location, selling currency, prices, orders, payments,
fulfillments, and inventory issues.

Electron main owns the local SQLite ledger, protected enrolled-device identity, server-issued offline
cache, offline eligibility, projected advisory stock, immutable local cash-sale persistence, signing,
and synchronization. The sandboxed renderer can invoke only fixed typed operations and never receives
keys, tokens, database access, arbitrary IPC, or an unrestricted SDK. Hardware integration, card or
split tender, refunds/returns, discounts/promotions, loyalty, barcode scanning, receipt printing,
cash-drawer control, and a tax engine remain absent.

## Technology and contract

Electron, React, TypeScript, Vite, Clerk React, Vitest, ESLint, Prettier, electron-builder, and pnpm.
The application consumes only the vendored, packed `@shifted/clothing-commerce-sdk` **0.5.0**:

- artifact: `vendor/shifted-clothing-commerce-sdk-0.5.0.tgz`
- SHA-256: `58fd0f89bed94080a624a1d0e7af8db906a3b282bb473199beef3f6a019ca931`
- dependency: `file:vendor/shifted-clothing-commerce-sdk-0.5.0.tgz`

There is no API workspace link or API source import. The renderer supplies only the current Clerk
session-token callback to the SDK. The SDK owns `Authorization`, `X-Client-*`, `X-Tenant-Id`, and
`Idempotency-Key` transport behavior.

## Authentication and selling bootstrap

`@clerk/react` restores the real operator session and presents Clerk sign-in when unauthenticated.
Only `VITE_CLERK_PUBLISHABLE_KEY` is embedded in the renderer; no Clerk secret or API/server secret
belongs in this repository.

After authentication the application:

1. calls `getMyTenants()` and auto-selects one usable tenant or shows a selector;
2. creates an SDK tenant client with `withTenant(tenantId)`;
3. calls `getPosContext()` and uses only returned, sellable registers;
4. auto-selects one register or requires a choice when multiple are authorized; and
5. derives branch display, inventory-location display, currency, and catalog pricing from that
   server-returned context.

Zero tenants and zero registers are explicit blocked states. `401`, `403`, validation, stock,
conflict, network, contract, and server errors are surfaced without mock fallback.

## Offline selling and synchronization

From the connected cashier, **Enable offline selling** enrolls or reuses the device and installs one
atomic server generation containing the register binding, bounded grant, catalog/prices, and advisory
inventory. Connected selling remains available when this optional bootstrap is unavailable. Main
derives readiness and the renderer presents Connected, Offline ready/unavailable, Pending sync,
Synchronizing, and attention states with non-authoritative “projected available” stock wording.

An offline cash checkout calls the main-process acceptance service. One durable transaction validates
the installed authority and policy, allocates the local receipt, stores the immutable sale/tender and
lines, and persists the signed SDK request. The customer sale is complete at that commit; its receipt
is shown immediately and is not conditional on network delivery.

The main-process worker claims one leased outbox command at a time and posts through the packed SDK to
`POST /api/v1/pos/offline-sales`. It validates and sends the exact stored request JSON with the stored
tenant, credential, `syncCommandId`, and matching `Idempotency-Key`; it never rebuilds or re-signs a
sale. Network, timeout, `408`, `425`, `429`, and `5xx` failures use bounded exponential retry. Other
HTTP, contract, and unknown failures remain blocked for attention. Expired leases are recovered both
at startup and on worker passes, including a restart before the lease deadline.

A successful response is atomically mapped to the local sale and outbox as `synced` or
`needs_reconciliation`, including the server provenance IDs. A synced upload remains deducted from
projected stock until a later server bootstrap has an `issuedAt` at or after its `receivedAt`; only
then is its projection release marker written. Reconciliation outcomes stay deducted and visible for
management attention.

## Catalog, cart, and cash checkout

The catalog uses typed `listProducts({ status: "active" })` and `getProduct(productId)` calls. It
shows active variants with SKU, variant label, and the current price in the register's selling
currency. The cart is memory-only; duplicate variants combine, quantities are positive whole
pieces, and lines can be changed or removed.

At checkout, `createPosSale()` receives only:

- the server-returned `registerId`;
- cart `variantId` and whole-piece `quantity` lines;
- displayed cart total as `expectedTotalMinor`;
- cashier-entered whole integer `cashReceivedMinor`; and
- one secure UUID idempotency key.

The client never submits a unit price, branch, inventory location, currency, separate payment
amount, or tax data. The on-screen change before submission is a preview; final change is always the
server response.

## Idempotency and price reconfirmation

A new logical checkout creates one browser `crypto.randomUUID()` key. Duplicate submit taps are
blocked. If the response is lost in an ambiguous network failure, the explicit **Retry same sale**
action reuses exactly the same arguments and key. Editing the cart, cash, or register invalidates
that operation; the next checkout receives a new key. Success clears the cart, and **New sale**
starts a fresh lifecycle.

`409 PRICE_CHANGED` is never retried automatically. The application shows the authoritative total
from the SDK error when present, reloads current product prices, requires cashier confirmation, and
then creates a new operation with a new key. `IDEMPOTENCY_CONFLICT` and business conflicts are not
blindly retried.

## Receipt and fiscal boundary

The completion view uses the `createPosSale()` response for order number, product/variant/SKU lines,
quantities, authoritative unit and line totals, total/currency, captured cash, cash received,
server-computed change, and completed fulfillment confirmation. There is no printer integration.

Connected POS Sale V1 shows gross merchandise total only. It does not calculate or describe VAT,
tax-inclusive/exclusive treatment, or fiscal invoices. Tax and jurisdiction-specific fiscal
compliance must be completed before a production deployment where required.

## Configuration and renderer origins

Copy `.env.example` to `.env` and set the two public renderer values:

```powershell
Copy-Item .env.example .env
pnpm.cmd dev
```

| Variable                     | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `COMMERCE_API_URL`           | Reachable Commerce API base URL            |
| `VITE_CLERK_PUBLISHABLE_KEY` | Public key for the operator Clerk instance |

Electron web security remains enabled with context isolation, renderer sandboxing, and Node
integration disabled. The preload exposes immutable runtime metadata and only fixed, typed offline
capabilities; it exposes no generic invoke, SQL, filesystem, SDK, or key access.

The observed renderer origins are exact and non-opaque:

- development: `http://127.0.0.1:5173`
- packaged/production-style: `http://127.0.0.1:4173`

The packaged bundle is served by an app-owned, GET/HEAD-only static loopback listener bound to
`127.0.0.1:4173`. It does not proxy API calls or hold credentials. Configure the API exactly:

```text
COMMERCE_CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:4173
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:5173,http://127.0.0.1:4173
```

Merge these values with any other deliberately authorized application origins. Never use `*`,
disable `webSecurity`, use `no-cors`, or allow the opaque `null` origin. `pnpm origin:check` launches
real development and production-style Electron renderers and prints both observed origins.

## Local connected runtime

The API repository remains separate. From its merged main checkout:

1. start the API-capable local Supabase stack and reset migrations;
2. provision a real Clerk development user through `dev:provision-identity`;
3. provision the deterministic commerce fixture through `dev:provision-commerce-fixture`;
4. configure the exact two origins above and start Next.js; and
5. run this Electron app with the matching Clerk publishable key and sign in as that real user.

Never place the Clerk subject, user password, Clerk secret, Supabase service-role key, or bearer token
in this repository or acceptance notes.

The latest real connected-runtime result is recorded in
[`docs/runtime-acceptance.md`](docs/runtime-acceptance.md).

If synchronization does not advance, first confirm the Commerce API is reachable. **Sync now** asks
main to run due work immediately; transient failures retain the sale and retry automatically. A
blocked or reconciliation count means the sale remains accepted and requires management review—do
not delete the local database or create a replacement sale. Refresh offline data after reconnect to
install newer authority and reconcile projection release.

## Quality and build

Requirements: Node.js 24+, pnpm 10.33.1, Git, and supported Electron packaging prerequisites.

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd format:check
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd acceptance:persistence
pnpm.cmd origin:check
pnpm.cmd build
```

`build` compiles main/preload, bundles the renderer, and creates an unpacked Electron application.
No installer publication or automatic update is part of this phase.
