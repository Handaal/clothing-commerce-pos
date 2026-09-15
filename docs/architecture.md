# POS desktop architecture

```text
Sandboxed React renderer -> narrow typed preload -> Electron main -> local SQLite ledger
Sandboxed React renderer -> versioned SDK over HTTPS -> Commerce API -> authoritative commerce core
Electron main -> versioned SDK over HTTPS -> enrollment/offline-bootstrap endpoints
```

`contextIsolation`, renderer sandboxing, web security, and disabled Node integration remain mandatory.
The renderer has no SQL, filesystem path, device private key, unrestricted Node/Electron API, or
generic IPC channel. Main owns SQLite, OS-protected device keys, command signing, local eligibility,
and the future hardware boundary. The preload exposes only named offline queries/commands plus
immutable foundation metadata.

The Commerce API remains authoritative for identity, authorization, register context, products,
prices, inventory, orders, and policy. SQLite is durable operational state for one installation; it
is not a second business database. Connected checkout remains the existing renderer SDK flow and is
not conditional on offline enrollment or local readiness.

## Local durability

Main opens one fixed `commerce-pos-ledger.sqlite3` below Electron's `app.getPath("userData")`, after
acquiring the application single-instance lock. Node 24's built-in `node:sqlite` is used because it is
part of the actual Electron 43.3.0 runtime; no native addon or rebuild is required. Startup verifies
WAL, foreign keys, a 5-second busy timeout, FULL synchronous durability, and `integrity_check`.
Corruption or migration failure preserves the file and blocks offline acceptance without blocking
the independent connected cashier.

Ordered transactional migrations are recorded in `local_schema_migrations` and `PRAGMA
user_version`. The schema models only installation/device state, immutable grants and complete cache
generations, advisory inventory observations, immutable accepted cash sales/tenders, and their exact
signed outbox commands. It does not copy the server's PostgreSQL model.

Catalog refresh is full-generation only. A new server response is validated and written as
`installing`, its complete product/variant/price/inventory set is committed, and the active marker is
switched in the same transaction. A failed installation leaves the previous generation active.
Historical generations remain retained when accepted sales reference them.

## Device trust and offline acceptance

Main generates Ed25519 credentials. The public key uses the server-required DER SPKI base64 encoding.
The PKCS8 private key is encrypted through Electron `safeStorage`; Electron 43's asynchronous OS key
provider is used for creation/reload, and the decrypted key is cached only in main-process memory for
synchronous signing inside the cash-acceptance transaction. The encrypted record is written to the
fixed `offline-device-key.protected.json` file below userData. Missing, altered, corrupt, or
OS-unavailable key material fails closed. No key, signature operation, token, or encryption primitive
crosses preload. Enrollment access tokens are transient and are never written to SQLite or the key
file.

Authenticated bootstrap uses SDK 0.5.0 to enroll once (with a durable enrollment idempotency key),
then request a server-issued offline grant and complete context/catalog/price/advisory-inventory
snapshot. A pending bootstrap idempotency key survives an ambiguous response. Device, tenant,
register, location, grant, time bounds, policy, catalog, price, and inventory relationships are
validated before atomic activation.

Readiness is evaluated in main. New acceptance requires an active enrolled device, matching protected
key, bound unexpired grant, valid complete cache, policy capacity, and no material local-clock rollback
relative to the last observed server time. Per-line acceptance additionally requires an active
granted price, usable advisory inventory, whole quantity within the grant limit, and enough projected
stock. Clock checks are conservative anomaly detection, not cryptographic Windows time attestation.

Projected availability is explicitly advisory:

```text
last server on-hand snapshot - accepted quantities not yet proven included by a newer snapshot
```

PR2 conservatively deducts every accepted sale whose projection has not been explicitly released.
The schema includes a narrow future release marker so PR3 can stop a deduction only after newer
authoritative evidence; there is no ATS, reservation, or multi-terminal coordination.

## Immutable sale and exact outbox

One `BEGIN IMMEDIATE` transaction derives trusted line facts from the active cache, checks grant
ordinal/exposure and projected stock, allocates a monotonic installation-scoped receipt such as
`0948-000001`, writes the sale/lines/tender, canonicalizes the exact SDK command, signs it, and writes
the outbox. Only commit returns `accepted_pending_sync`; injected failures at every write boundary
roll back the receipt counter and all rows.

`localSaleId` identifies the commercial event. A separate UUID `syncCommandId` is both the durable
outbox identity and future `Idempotency-Key`. The canonical command, SHA-256 hash, credential ID,
signature, and exact request JSON are persisted once. Future retries must replay this representation;
they cannot rebuild it from a cart, new time, new grant, or current prices. SQLite triggers reject
normal mutation/deletion of accepted sale, tender, line, and command facts. Only future lifecycle and
server-mapping fields are mutable.

The outbox repository can list due work, atomically claim with a bounded lease, increment attempts,
release for retry, mark delivered/blocked, and recover expired leases after a crash. PR2 starts no
timer and makes no `POST /api/v1/pos/offline-sales` request.

## Security limitations and deferred scope

SQLCipher and application-level database encryption are deferred. The database minimizes sensitive
data and never stores Clerk tokens, server secrets, or plaintext private keys, but a local
administrator or malware running as the same OS user can inspect or modify local business data. The
server must therefore revalidate every future signed ingestion command and remains authoritative.
Backups, destructive repair, synchronization/reconciliation UI, and fleet management are also
deferred.
