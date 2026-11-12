# Offline returns and promotions — deliberate deferral (offline-resilience gap 4)

This note records the engineering decision for the last item on the "gaps that still force the POS
online" list: **returns and promotions while offline**. Both are intentionally **not** offered
offline. This is an architectural boundary, not an unfinished feature — the sections below state the
hard reasons and the exact capability that would have to exist before either could change.

## Promotions offline — never (by design)

Connected promotions are server-authoritative: the API evaluates automatic promotions plus one
optional entered code and applies the **greatest eligible saving**; the client never calculates a
discount (see [Phase 2P](phase-2p-promotions.md)). Frozen V1 rule: **no offline promotions.**

An offline device holds only a signed grant of **authorized prices** — it has no promotion catalog,
no eligibility/usage counters, and no authority to invent a discount. Evaluating a promotion locally
would mean the client computing money it is explicitly forbidden from computing, with stale rules and
no usage enforcement. Switching to offline therefore invalidates any connected promotion pricing
(`switchToOffline`), and the offline cart is built from authorized offline prices only. There is no
path to safely enable this offline, and none is planned.

## Returns offline — deferred, blocked on a server capability

The entire returns design is server-authoritative and has **no offline bridge, SQLite, inventory
projection, or outbox dependency**; no refund amount is computed locally and there is deliberately
**no durable return queue** (see [Phase 2M](phase-2m-returns.md)). The offline cashier disables
returns and says so.

Returns cannot simply be queued offline the way sales are, because a return depends on state that
only the server holds at the moment of acceptance:

- **Eligibility** — purchased, previously returned, and remaining-eligible quantities per line, plus
  the maximum refundable amount. These change as other returns are processed and cannot be trusted
  from a stale snapshot.
- **Refund money** — computed on a net per-unit basis by the API (including any promotion applied to
  the original order). The client must never calculate it.
- **Settlement** — a refund is created `pending` and only settled after an explicit cash hand-back
  attestation against the canonical server amount.
- **Original order existence** — an unsynced offline sale is not yet a connected Order, so there is
  nothing to return against until it has synchronized.

A local "offline return" would be an unsynced financial liability with no eligibility check, a
locally invented amount, and no settlement authority — exactly what the returns architecture was
built to prevent. We will not build a local return queue; doing so would contradict the validated
Phase 2M boundary and risk double refunds or over-refunds.

### What would unblock it

Offline returns become feasible only with a **server-issued, signed offline-return authority**,
analogous to the offline-sale grant the POS already consumes. Concretely, the API/SDK would need to
provide:

1. a bounded, signed **return grant** bound to the device/register, carrying per-line eligibility and
   a maximum refundable amount valid for a short window;
2. a **signed offline-return command** format (mirroring the offline-sale command) that main can
   persist, sign, and replay through the existing outbox/worker; and
3. server-side **idempotent acceptance + reconciliation** of that replayed command, including refund
   settlement semantics for the offline case.

Until that authority exists in the contract, offline returns remain out of scope. When it does, the
implementation reuses the proven offline-sale machinery (grant install on bootstrap, signed command,
outbox replay, acknowledgement, projection reconciliation) rather than inventing a parallel path.

## UI affordance (kept honest today)

The offline cashier shows a disabled **Returns and refunds** control with a hint that returns are
server-authoritative and directs the operator to reconnect and use the connected cashier. No return
is ever queued, signed, or applied to local inventory offline.
