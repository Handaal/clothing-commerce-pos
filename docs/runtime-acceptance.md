# Connected POS Runtime Acceptance

Acceptance was completed on 2026-09-05 against the local Commerce API and local Supabase stack with
a real Clerk development session. No Clerk subject, credential, token, or server secret is recorded
here.

## Runtime and bootstrap

- Electron renderer origin: `http://127.0.0.1:5173`
- Packaged-style origin independently probed: `http://127.0.0.1:4173`
- Exact CORS and Clerk authorized-party allowlists accepted both origins; opaque `null` was not
  allowed.
- The authenticated bootstrap resolved tenant `Dev Local`, register `Dev Front Register`, branch
  `Dev Flagship`, default location `Dev Flagship Stockroom`, and selling currency `USD`.
- The deterministic fixture branch explicitly operates the `Dev Threads` brand required by the POS
  sale invariant.

## Cash sale

- Product: `Dev Linen Shirt`, variant `Medium`, SKU `DEV-LS-001-M`
- Quantity: 1
- Authoritative inventory: 22 before, 21 after
- Authoritative unit price and total: USD 25.99
- Cash received: USD 30.00
- Server-computed change: USD 4.01
- Order: number `2`, id `7bea922c-ca22-4e4d-93e5-d4c342035fb3`, channel `pos`, status `placed`
- Captured cash payment: `81c4152a-0040-49f9-b769-09045aa88ae2`
- Completed fulfillment: `7472ef1b-fc0b-4e66-8822-1c1731fa040f`

The Electron receipt rendered the same item, totals, cash, change, payment status, and fulfillment
status returned by `createPosSale`.

## Server readback and replay

The management Orders surface returned exactly one POS order with the same id, order number,
currency, total, line price, and quantity. Its fulfillment progress was `fulfilled` for the full
ordered quantity. Inventory readback satisfied `21 = 22 - 1` and advanced exactly one version.

Replaying the exact successful request with the same idempotency key returned the same order,
payment, fulfillment, and inventory-operation identifiers. The POS order count remained one and
inventory remained 21 after replay.

# Phase 2I PR2 local persistence acceptance

Acceptance was completed on 2026-09-08 with Electron 43.3.0, its embedded Node 24.18.1 and SQLite
3.53.1, the real `node:sqlite` driver, real production persistence/services, and Windows-backed
Electron `safeStorage`. The isolated harness did not contain a token, call an API, or fabricate a
production-authorized grant; it installed a clearly non-production server-contract fixture solely to
exercise local durability. The earlier real Clerk connected acceptance above remains the connected
regression evidence. A fresh authenticated offline bootstrap was not practical because this checkout
contains no Clerk credential, which is intentional.

The driver was also independently executed inside a Windows `electron-builder` packaged directory.
It created its database under that app's real userData path and reported WAL, FULL synchronous mode,
foreign keys enabled, and the expected readback value.

## Committed cash event

- Product: `Runtime Acceptance Tee`; SKU: `ACCEPT-BLK-M`
- Cached advisory stock: 10
- Quantity: 2; projected availability: 10 before, 8 after
- Total: USD 51.98; cash received: USD 60.00; change: USD 8.02
- Local sale ID: `1bcc770b-4d6f-4428-afc6-8f5dc6321e6b`
- Local receipt: `0948-000001`
- Sync command ID: `8839a809-e005-4c95-8705-80e9d444623b`
- Canonical payload SHA-256: `8abc149d70431128105f61267ddd7ee89a6f909b6f90cd4a51f4aab8df08212c`
- Returned lifecycle: `accepted_pending_sync`

The harness intentionally recorded zero ingestion requests and has no connected-sale call, so it
could not create a server Order. It then terminated Electron with `app.exit` after commit and after
claiming the outbox item, bypassing normal database shutdown.

On restart, the OS-protected Ed25519 key reloaded successfully. The same sale ID, receipt, command ID,
payload hash, line/tender totals, and projected quantity 8 were read from SQLite. One expired lease was
recovered and the exact command was claimed again with attempt 2. No synchronization request was sent.
