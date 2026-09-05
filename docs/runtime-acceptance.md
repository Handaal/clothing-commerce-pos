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
