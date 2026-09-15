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

# Phase 2I PR3 real offline cashier and synchronization acceptance

Acceptance was completed on 2026-09-15 with the actual Electron application, Windows-backed
`safeStorage`, local SQLite, local Commerce API/Supabase, the packed SDK 0.5.0, and a real Clerk
development session. No Clerk subject, session token, password, secret, private key, or device
signature is recorded here.

The connected cashier resolved `Dev Front Register`, `Dev Flagship`, and `Dev Flagship Stockroom`.
The production bootstrap enrolled/reused the real device and installed a server-issued bounded grant,
catalog, prices, and inventory snapshot. Large `Dev Linen Shirt` stock was 39. The API listener was
then stopped, and the cached cashier accepted one Large shirt for USD 25.99 against USD 30.00 cash.
Receipt `0B05-000001` showed USD 4.01 change immediately.

- Local sale: `4b367b7e-ce07-4909-8cc3-303b71ac41b0`
- Sync command / Idempotency-Key: `9bc56c8c-6cd5-4a40-aa1b-8d3c63b69b66`
- Persisted canonical payload SHA-256: `4ba90c76f6d338d94c1b881400eef0ef45616f376d92e63071bfedab6777eb09`
- Server ingestion: `f1d13423-7701-4f0b-8c6f-035ec669b7d2`
- Canonical Order: number `2`, id `67b001a5-4ad9-4f24-90e7-4fa94144d260`
- Captured Payment: `19d0d63f-6042-4bbd-8a18-c61624cafff3`
- Completed Fulfillment: `173840b8-935c-4b33-a5c6-9113eab8a8e6`

An abrupt Electron process termination left `last_clean_shutdown_at` empty. Restarting while the API
was still absent preserved the same sale, receipt, command ID, and hash, reported one pending sale,
and retained the one-unit projected deduction.

For the mandatory server-commit/local-ack window, the test-only worker seam terminated the process
after the real server response but before SQLite delivery acknowledgment. The server had already
created the ingestion, Order, Payment, Fulfillment, and one inventory effect, while the local outbox
remained leased and the sale remained `accepted_pending_sync`. After lease expiry and restart, the
worker replayed the same 805-byte persisted request and the same idempotency key. The API returned the
same ingestion and canonical entities; the ingestion count remained exactly one, and inventory was
38/version 3 rather than being decremented twice.

The local delivery transaction then recorded `synced` plus every server ID. The authenticated
management `GET /api/v1/orders/{orderId}` returned HTTP 200 with the same POS Order, USD 25.99 line,
and fully fulfilled progress. Finally, **Refresh offline data** installed a newer server snapshot at
38/version 3, reported one released sale projection, and produced projected availability 38 with no
remaining local deduction.
