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
keys, tokens, database access, arbitrary IPC, or an unrestricted SDK. **Connected** sales support
server-authoritative promotions (Phase 2P); the server evaluates automatic promotions plus one
optional entered code and applies the greatest eligible saving. Hardware integration, card or split
tender, manual cashier discounts, loyalty, barcode scanning, receipt printing, cash-drawer control,
a tax engine, and any offline promotions remain absent.

## Technology and contract

Electron, React, TypeScript, Vite, Clerk React, Vitest, ESLint, Prettier, electron-builder, and pnpm.
The application consumes only the vendored, packed `@shifted/clothing-commerce-sdk` **0.19.0**:

- artifact: `vendor/shifted-clothing-commerce-sdk-0.19.0.tgz`
- SHA-256: `78ca20340b19364ccba6936c048492e05fc2d7d6c444a2ee0ef52380e38f3c30`
- dependency: `file:vendor/shifted-clothing-commerce-sdk-0.19.0.tgz`

The pinned artifact and SHA are enforced by `tests/boundaries.test.ts`. SDK 0.19.0 includes the
existing selling/workforce/customer surface plus supplier purchase money, standalone payments,
server-computed dues, and payment reminders.

## Supplier payables desk

The Suppliers back-office desk records one atomic multi-line clothing-variant purchase into an
authorized inventory location. Each line carries an immutable supplier unit cost in tenant-currency
minor units; that cost is AP/history data only and is not inventory valuation or COGS. The API owns
stock receipt atomicity, purchase totals, due computation, overpayment/no-dues guards, reminder lead
windows, authorization, and exact replay. Standalone payments appear against purchase history
oldest-first without being stored as invoice allocations. The renderer uses only SDK `0.19.0` and
does not add preload, Node, Electron, SQLite, or server-secret access.

There is no API workspace link or API source import. The renderer supplies only the current Clerk
session-token callback to the SDK. The SDK owns `Authorization`, `X-Client-*`, `X-Tenant-Id`, and
`Idempotency-Key` transport behavior.

## Authentication and selling bootstrap

Phase 2P adds **connected promotions** to the cashier (see [Connected promotions](#connected-promotions)
and [Phase 2P details](docs/phase-2p-promotions.md)). Phase 2M adds **Returns and refunds** to the
connected cashier. Browse the current branch's
connected POS orders, filter loaded pages by order number, inspect server eligibility, select received
quantities/reasons/dispositions, and confirm. The API creates the return and a pending refund; its
exact amount is then displayed. Authorized cash settlement requires explicit hand-back attestation
and a settlement reference. Electronic refunds remain pending. The offline cashier disables returns;
no return is queued or applied to local inventory. See [Phase 2M details](docs/phase-2m-returns.md).

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

Cashier acknowledgement is durable and separate from synchronization. Each accepted sale carries a
write-once `acknowledged_at`; it is set only when the cashier finishes the receipt, never because the
sale synced. If the app is interrupted after the local commit but before acknowledgement, startup
recovery surfaces the exact committed sale (by receipt, not an aggregate "N waiting" count) and blocks
new selling until the operator acknowledges it — so the same cash sale cannot be rung twice. If
several unacknowledged sales somehow exist, they are recovered deterministically, oldest first, and
none is discarded.

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
- the authoritative **net** quote total as `expectedTotalMinor`;
- cashier-entered whole integer `cashReceivedMinor`;
- the optional entered `promotionCode` intent (omitted when none is applied); and
- one secure UUID idempotency key.

The client never submits a unit price, branch, inventory location, currency, discount amount, separate
payment amount, or tax data. The on-screen change before submission is a preview; final change is
always the server response.

## Connected promotions

Connected selling quotes the server for authoritative pricing: **cart → POS quote → optional code →
gross / discount / net → tender → final server sale revalidation → receipt**. The renderer never
calculates a discount.

The cashier sees a minimal promotion panel: a promotion-code input with **Apply**/**Remove**, a
loading state, the applied and automatic promotion summaries, and a concise error state. Typing a
code never quotes; only **Apply** does. The typed draft and the server-applied code are separate
state. Automatic promotions appear with no cashier action, and the app requotes on relevant connected
cart changes (add, remove, quantity, clear) and register changes. Each quote carries a basket
signature and sequence, so a slow response for an older basket can never overwrite a newer one.

The server applies the **greatest eligible saving** — an entered code does not automatically beat a
better automatic promotion; the app displays exactly what the server selected. Tender always uses the
current authoritative net amount, and checkout is blocked while a fresh quote is loading or
unavailable. The final `createPosSale()` re-evaluates: if the promotion expires, a code exhausts,
eligibility or the winner changes, or the total changes, the sale stops, refreshes pricing, and
requires cashier reconfirmation. A changed amount is never silently finalized. Existing POS
idempotency and `409 PRICE_CHANGED` handling are preserved.

When the quote cannot be reached the panel states **“Promotions require a connection.”** The cashier
may reconnect or explicitly continue at normal authorized offline prices. Offline selling remains
promotion-free: switching to offline invalidates any connected promotion pricing so a connected
discounted total is never carried into an offline sale. Offline grants, SQLite state, the signed
offline request format, outbox schemas, replay, and bootstrap authority are unchanged.

## Idempotency and connected-sale crash recovery

A connected sale is a durable command, not renderer memory. Before any network call, the main
process persists the normalized command, its idempotency key, the register/tenant scope, and a
prepared timestamp to SQLite (`connected_sale_workflow`), mirroring the connected-return journal.
The lifecycle is `prepared → accepted → acknowledged`, with `rejected` as the terminal state for a
definite server refusal that did not commit. At most one connected sale may be unresolved at a time,
so a new sale cannot begin until the previous one is acknowledged.

Duplicate submit taps are blocked. If the response is lost in an ambiguous failure (network, 5xx,
timeout, or idempotency conflict) the command stays unresolved and the explicit **Retry same sale**
action replays it — with the **same** idempotency key. Crucially, this survives process death: if
the app is killed after the server commits but before the receipt is seen, startup recovery replays
the retained command with its original key, so server idempotency returns the same Order rather than
creating a second one. The renderer never mints a key, so a restart can never produce a duplicate.

Server acceptance and cashier acknowledgement are distinct. The accepted receipt stays durable until
the cashier explicitly finishes it (**New sale**), which records the acknowledgement and clears the
workflow. Only then does ordinary selling resume.

`409 PRICE_CHANGED` is never retried automatically. Because the server did not commit, the workflow
closes; the application shows the authoritative total from the SDK error when present, reloads
current prices, requires cashier confirmation, and starts a new command with a new key.
`IDEMPOTENCY_CONFLICT` and 5xx are treated as uncertain (retained for same-key replay), never
blindly retried as fresh sales.

## Receipt and fiscal boundary

The completion view uses the immutable `createPosSale()` response for order number,
product/variant/SKU lines, quantities, authoritative unit and line totals, captured cash, cash
received, server-computed change, and completed fulfillment confirmation. The gross subtotal is the
sum of the returned line totals and the promotion discount is the difference between that gross and
the net `order.totalMinor`; the promotion name/code is taken from the quote the sale was confirmed
against, never reconstructed from current configuration. There is no printer integration.

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

### One canonical packaged API origin

The renderer and the Electron main process must never resolve different Commerce API origins. A
release build resolves the origin exactly once and both processes consume that single artifact:

1. `pnpm gen:runtime-config` reads `COMMERCE_API_URL` (from the environment or `.env`), validates it
   as an absolute http(s) URL, and writes `dist-electron/runtime-config.json`.
2. `pnpm build:renderer` bakes the value from that same artifact into the renderer bundle.
3. `electron-builder` packages `dist-electron/**`, so the artifact ships with the app. At runtime the
   main process reads it (`resolveMainApiOrigin`) instead of `process.env`.

`pnpm build` runs these in order. In development (`pnpm dev`, identified by `VITE_DEV_SERVER_URL`) the
main process may fall back to `COMMERCE_API_URL` or `http://localhost:3000`. In a packaged build the
origin is **required and validated**: a missing or invalid configuration fails the build (and a
missing packaged artifact fails main startup) rather than silently pointing main at localhost. The
operator does not need to launch Electron from a shell with a matching environment variable, and the
two processes cannot drift.

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
disable `webSecurity`, use `no-cors`, or allow the opaque `null` origin.

`pnpm origin:check` is the Commerce API-origin consistency gate: it generates the runtime-config with
a distinguishing non-default origin, builds the renderer, and asserts the origin baked into the
renderer bundle equals the origin the main process resolves from the packaged artifact — plus that
invalid origins are rejected and a missing production origin fails closed.

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
pnpm.cmd acceptance:origin
pnpm.cmd acceptance:persistence
pnpm.cmd acceptance:sqlite-packaged
pnpm.cmd acceptance:sale-recovery
pnpm.cmd acceptance:offline-ack
$env:COMMERCE_API_URL = "https://api.example.com"; pnpm.cmd build
```

`build` resolves the canonical API origin, compiles main/preload, bundles the renderer, and creates
an unpacked Electron application. No installer publication or automatic update is part of this phase.

### Release gates (CI)

The GitHub workflow runs two required jobs. `verify` (Linux) runs format, lint, typecheck, unit
tests, and a packaged smoke `build`. `windows-acceptance` (Windows, because the packaged gates use
`electron.exe`, `%APPDATA%`, and the packaged `node:sqlite` runtime) runs the release-blocking
acceptances automatically:

| Gate                         | Proves                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| `acceptance:origin`          | renderer and main resolve one canonical API origin; fail-closed        |
| `acceptance:persistence`     | durable local persistence across an Electron restart                   |
| `acceptance:sqlite-packaged` | the packaged SQLite runtime (WAL, FULL sync, FK) is healthy            |
| `acceptance:sale-recovery`   | a connected sale replays the SAME key after a crash — one Order (P1-2) |
| `acceptance:offline-ack`     | an offline sale is recovered and must be acknowledged (P1-3)           |

`acceptance:returns` drives the disposable API stack, so it runs in a separate job only when a
sibling `clothing-commerce-api` checkout is provided via the `COMMERCE_API_CHECKOUT` repository
variable; run it in the release environment where the API is available.
