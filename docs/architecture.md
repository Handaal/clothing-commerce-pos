# Connected POS Architecture

```text
Sandboxed React renderer -> typed read-only preload bridge -> isolated Electron main/static asset host
Sandboxed React renderer -> versioned SDK over HTTPS -> Commerce API -> authoritative commerce core
```

`contextIsolation`, renderer sandboxing, web security, and disabled Node integration are mandatory.
The preload bridge exposes only immutable foundation metadata. In packaged builds, main serves the
compiled renderer from an exact loopback origin (`http://127.0.0.1:4173`) so both Commerce CORS and
Clerk authorized-party checks can remain explicit HTTP(S) allowlists. The listener serves static
GET/HEAD assets only and is not an API/auth proxy. Development uses `http://127.0.0.1:5173`.
Main-frame navigation is limited to the renderer's exact origin. This permits Clerk's development
session handshake to return to the application while cross-origin navigation remains blocked and
HTTPS links are opened externally through Electron's shell boundary.

The renderer owns Clerk UI/session state and passes only a token callback into SDK 0.4.0. Tenant
headers, client metadata, and sale idempotency headers stay inside the SDK. Tenant and register
selection never establish authorization; the API evaluates current identity, membership,
permissions, scopes, and register/resource lifecycle on every request.

The sale executor holds one immutable request/key pair across an ambiguous network retry. Any cart,
cash, register, success, or price-reconfirmation transition abandons that pair. Its lifecycle counter
prevents late responses from overwriting a newer transaction.

Future device integrations remain in main-process adapters, and future SQLite is local operational
state only. Neither exists in Connected POS Sale V1.

The API enforces identity, authorization, tenant isolation, and business rules. UI permissions are
not authorization. This repository contains no Supabase directory or database migration ownership.
