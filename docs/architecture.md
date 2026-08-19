# POS Architecture

```text
Sandboxed React renderer -> typed read-only preload bridge -> isolated Electron main/hardware adapters
Sandboxed React renderer -> versioned SDK over HTTPS -> Commerce API -> authoritative commerce core
```

`contextIsolation`, renderer sandboxing, web security, and disabled Node integration are mandatory.
The preload bridge exposes only immutable foundation metadata. Future device integrations remain in
main-process adapters and future SQLite is local operational state only.

The API enforces identity, authorization, tenant isolation, and business rules. UI permissions are
not authorization. This repository contains no Supabase directory or database migration ownership.
