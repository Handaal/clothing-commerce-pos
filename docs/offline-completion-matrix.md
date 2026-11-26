# Offline completion matrix

## CURRENT — online-first POS, bounded emergency offline (owner decision 2026-11-14 night; ADR-042 §13)

The POS is **online-first**. During a temporary outage (12 h lease, hard max 24 h) only the rows marked
"offline" continue, from last-synced data. One shared stock pool; no Website/POS split, no per-till stock or
voucher grants, no approval queue. Conflicts after sync are reported in **Sync conflicts** (POS) and
**Sync conflicts** (admin-mobile). Evidence: ADR-042 §13.9 (2026-11-15). Everything below the next heading is
the superseded 2026-11-14 matrix, kept for history. **Updated 2026-11-15 evening (ADR-042 §13.10): rows marked ★.**

| Workflow                                                                                 | Target                                                                      | Current (2026-11-15, uncommitted)                                                                                                                                                                                                                                   | Grade                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cashier sale (cash / card / InstaPay / wallet, split)                                    | offline; local estimate; sync idempotent; shortfall → conflict, sale stands | local estimate check + decrement in one SQLite txn; server records sale once; shortfall writes `stock_shortfall` conflict in the same txn                                                                                                                           | **E2E over real HTTP** (`test:pos:offline:shortfall-client` 10/10, incl. Website reservation fix `20261115180000`)                               |
| Tender wording                                                                           | cashier-recorded locally → server ledger after sync; no provider state      | receipt: "recorded by the cashier on this till (not yet synced)" / "… in the server ledger"; API `confirmation: cashier_recorded`                                                                                                                                   | **E2E** (HTTP case 4/6, POS unit)                                                                                                                |
| New customer (name + phone)                                                              | offline; duplicate flagged, never merged; profile purged after acceptance   | unchanged lane + `customer_duplicate` conflict (no PII)                                                                                                                                                                                                             | **E2E** (HTTP C1–C3, K2; SQL C1–C4)                                                                                                              |
| Installment / paydown                                                                    | offline; stale debt preserved as conflict                                   | CA409 → `conflict_recorded`, signed command kept, AR untouched; till marks `needs_reconciliation` + receipt                                                                                                                                                         | **E2E** (HTTP K1; SQL D1–D9; POS unit)                                                                                                           |
| Existing voucher redemption                                                              | offline from cached policy + local counter; reconcile to shared quota       | cached policy per lease (`voucherPolicies`, local v22, server `20261115160000`); till ceiling vs shared remaining at fetch; server records one redemption or a `voucher` conflict, sale stands; server flag `POS_OFFLINE_CACHED_VOUCHERS` **default off**           | ★ **E2E (flag off)** — HTTP V1–V9 9/9 PASS; local row bound to snapshot + lease (copied row / other tenant refused); Electron crash/restart PASS |
| Credential-required voucher                                                              | only with secure transaction-bound proof                                    | never issued for offline use; till refuses; server treats unissued policy as `VX_SNAPSHOT_INVALID`                                                                                                                                                                  | **BLOCKED (security) — online-only**                                                                                                             |
| Attendance clock in/out                                                                  | offline, append-only; duplicates reported                                   | AT409/AT404 → `conflict_recorded`, event kept, timeline untouched                                                                                                                                                                                                   | **E2E** (SQL T1–T5; HTTP A1–A8; POS unit)                                                                                                        |
| Returns                                                                                  | online-only; fail closed                                                    | UI disabled; main process + API `OFFLINE_RETURNS_DISABLED` (no side effect); online returns unchanged                                                                                                                                                               | **ONLINE** (HTTP X1–X2; online returns 19/19)                                                                                                    |
| Customer edit, voucher create/edit, suppliers, inventory, order changes, settings, staff | online-only                                                                 | desks online-only; orders cached read-only; Suppliers disabled offline; intent kinds rejected                                                                                                                                                                       | **ONLINE**                                                                                                                                       |
| Stock split / stock grants                                                               | none                                                                        | API `CHANNEL_STOCK_SUPERSEDED`; DB pins `legacy`, execute revoked; admin-mobile route redirects                                                                                                                                                                     | **RETIRED** (SQL R1–R8, L1–L3)                                                                                                                   |
| Sync Conflicts — POS                                                                     | report section                                                              | server list for this register + connection / pending / blocked counts                                                                                                                                                                                               | **UNIT** (render, offline, error)                                                                                                                |
| Sync Conflicts — admin-mobile                                                            | report screen                                                               | tenant-wide list, kind filter, empty/no-access states                                                                                                                                                                                                               | **UNIT**                                                                                                                                         |
| ★ Offline PIN sign-in (per person, per till)                                             | shifted-cafe login as is: same roster + PIN pad, SAME PIN offline           | after each successful online sign-in the main process enrols the sign-in PIN (server step-up re-verifies it); DPAPI-sealed verifier; lockout in SQLite + sealed copy; lease-bound; no renderer enrollment channel; server flag `POS_OFFLINE_PIN_V2` **default off** | **E2E, accepted residual risk (same-user malware), NOT activated** (HTTP K1–K9 9/9; Electron `acceptance:offline-pin` PASS)                      |
| ★ Electron crash/restart with the new lanes                                              | required                                                                    | Electron 43.3.0 runtime + compiled main modules + real SQLite + OS safeStorage: `acceptance:voucher-crash`, `acceptance:offline-pin`; production package `pnpm build` (electron-builder --dir) builds                                                               | **PASS (runtime)**; inside the packaged asar: **NOT RUN**                                                                                        |

# Offline completion matrix (row per desk action) — 2026-11-14 (rev. blocker program, §24) — SUPERSEDED IN PART

Built from live code (desk components' actual SDK calls, `preload.ts` bridge, local SQLite schema **v17**,
API migrations through `20261114130000_offline_intent_auto_adjudication.sql`, SDK **0.31.0**) and the tests
that ran on 2026-11-14. Companion to `docs/offline-first-roadmap.md` §22 (phase ledger + evidence).

**Owner rule (2026-11-14): there is no human/admin/manager approval step anywhere.** The server decides
every synced offline command automatically. A server row "waiting for review" no longer exists.

## Legend

The five stages: (1) operate locally while disconnected · (2) durable command survives restart · (3) server
accepts the command · (4) server automatically applies it or deterministically rejects / flags a conflict ·
(5) the user sees the canonical outcome and can reconcile.

| Code               | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **E2E**            | All five stages proven: real SQLite → real HTTP API → disposable PostgreSQL → canonical DB effect asserted. |
| **AUTO-E2E**       | Intent lane: stages 1–5 proven, server applies automatically **when an owner handler policy is configured** |
| **BLOCKED-POLICY** | Captured and durable (1–3); server disposes `blocked_policy` (fails closed) — no handler policy approved.   |
| **NO-HANDLER**     | Captured (1–3); server disposes `blocked_policy` / `OIP_HANDLER_NOT_IMPLEMENTED` — no typed handler exists. |
| **PROVISIONAL**    | Server stores provisionally under its policy (not a person); canonical effect awaits a policy decision.     |
| **CACHED**         | Cached read-only snapshot.                                                                                  |
| **LOCAL**          | Device-local; never needs the server.                                                                       |
| **ONLINE**         | Online-only (no offline path).                                                                              |
| **EXT**            | Needs a live external provider; online by nature.                                                           |
| **ABSENT**         | The action does not exist in the POS today.                                                                 |
| **NOT TESTED**     | Not exercised this run.                                                                                     |

Server dispositions (intent lane): `applied` (OIA\_\*) · `rejected` (OIX\_\*) · `needs_reconciliation`
(OIX\_\*, conflict, nothing applied) · `blocked_policy` (OIP\_\*, nothing applied). No pending state.

## Cashier (pos)

| Action                              | Status                          | Local behaviour                                              | Server / global effect                                              | Evidence (2026-11-14)                                                                           |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cash sale                           | **E2E**                         | signed `sale` command + outbox in one txn                    | `record_offline_sale` → order/payment/fulfilment, or reconciliation | API HTTP 47/47 (sale cases); POS `sale-atomicity`, packaged `sale-recovery`, `offline-ack` PASS |
| Split / non-cash tender             | **E2E** (recorded, not settled) | card/InstaPay/wallet stored cashier-attested; offline notice | stored, method preserved; **no provider capture**                   | API HTTP; POS `PayModal.test.tsx`                                                               |
| Installment sale / customer paydown | **E2E**                         | grant credit cap enforced locally                            | debt + paydown idempotent                                           | API HTTP                                                                                        |
| Customer capture with sale          | **E2E** (snapshot customers)    | only signed-snapshot customers; no free-form PII offline     | links existing customer                                             | API HTTP                                                                                        |
| Catalog / price / stock read        | **CACHED**                      | grant price snapshot; projected stock labelled advisory      | server re-checks at ingestion                                       | POS vitest                                                                                      |
| Promotions / vouchers at the till   | **ABSENT offline** (decision 4) | no code field offline; no discount computed                  | none                                                                | `offline/cashier.tsx` (no promo input)                                                          |
| Receipt / acknowledgement           | **LOCAL**                       | durable receipt + ack                                        | —                                                                   | packaged `offline-ack` PASS                                                                     |

## Returns

| Action                                  | Status                   | Notes                                                                                                 |
| --------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Grant preparation                       | ONLINE (by design)       | order-bound grant fetched while connected                                                             |
| Offline return capture                  | **E2E**                  | lines ≤ frozen eligibility; signed; one txn (API HTTP returns cases; packaged `offline-returns` PASS) |
| Server acceptance (canonical Return)    | **E2E**                  | net refund recomputed by server; `returns-client` 4/4 cross-repo                                      |
| Restock / inventory posting             | **PROVISIONAL** (policy) | accepted `non_restock`; intended disposition preserved; no stock moves at ingestion                   |
| Refund settlement                       | ONLINE / **EXT**         | refund created `pending`; settled only via connected `settleRefund`. Never marked paid offline        |
| Eligibility drift / revoked device      | **E2E** → reconciliation | `needs_reconciliation`, refund withheld; visible in Sync review                                       |
| Refund cap / grant lifetime / exchanges | policy (decision 8)      | safe defaults: server eligibility ceiling, operator lease, refund-only. **Exchanges absent**          |

Returns are a complete, safe _provisional_ workflow: capture and acceptance are proven; restock and money
settlement are deliberately not automatic. Not "done" until decision 8 and a restock rule exist.

## Customers

| Action                     | Status                                                                  | Notes                                                                   |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Directory / history (desk) | ONLINE                                                                  | offline the till uses the signed customer snapshot                      |
| Customer payment (desk)    | **E2E** via cashier paydown lane                                        |                                                                         |
| Add / edit customer        | **ABSENT** in POS; lane kind `customers.create/update` → **NO-HANDLER** | no form in the desk; server would dispose `blocked_policy` (decision 1) |

## Orders

| Action                   | Status     | Notes                                                                                           |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------- |
| List / search / view     | **CACHED** | stale-while-revalidate cache                                                                    |
| Update / fulfil / cancel | **ABSENT** | the POS Orders desk issues no mutations; no roadmap row promises POS order actions (decision 2) |

## Inventory

| Action                              | Status                      | Notes                                                                                                                                                         | Evidence                                                         |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Receive                             | **AUTO-E2E** (policy-gated) | desk form offline → signed intent → server posts a `receipt` through the ledger once, or rejects over `maxQuantity`. With no handler policy: `blocked_policy` | API I1, I2, A1, A8; cross-repo C1–C4; packaged `offline-intents` |
| Adjust                              | **AUTO-E2E** (policy-gated) | applied within `maxAbsDelta`; never drives on-hand below zero (`OIX_INSUFFICIENT_STOCK`); concurrent tills serialize                                          | API I8, A1, A2, A8                                               |
| Count                               | **AUTO-E2E** (policy-gated) | applied as a `correction` only if `baseVersion` = current canonical balance version; stale → `needs_reconciliation`; variance over limit → reconciliation     | API A3, A4, A5                                                   |
| Transfer                            | **ONLINE** (gap)            | needs destination scope + allocation; no handler; decision 3                                                                                                  | —                                                                |
| Issue (non-sale exit)               | **ONLINE**                  | no offline kind                                                                                                                                               | —                                                                |
| Product/price/cost/collection edits | ONLINE                      | catalog authority                                                                                                                                             | —                                                                |

## Vouchers / promotions

| Action                         | Status                  | Notes                                     |
| ------------------------------ | ----------------------- | ----------------------------------------- |
| Create / edit / status         | ONLINE                  | server-authoritative                      |
| Offline redemption at the till | **ABSENT** (decision 4) | no local discount; no budget grant exists |

## Suppliers / purchasing

| Action                         | Status                                   | Notes                                                                                                        |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Browse suppliers / dues        | ONLINE                                   | no supplier directory cached                                                                                 |
| Purchase draft / goods receipt | **NO-HANDLER**; no desk form             | lane kinds exist; server disposes `blocked_policy` (API A7); no form because no directory cache (decision 5) |
| Supplier payment               | **EXT/ONLINE**; lane kind **NO-HANDLER** | offline payment intent creates **no** supplier payment (API I9)                                              |
| Supplier/reminder CRUD         | ONLINE                                   | back-office                                                                                                  |

## Staff / attendance / payroll

| Action                              | Status                    | Notes                                                                                            |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| Clock in / out                      | **E2E** → **PROVISIONAL** | received `pending_policy` (a payroll rule, not a person); payroll table untouched; packaged PASS |
| Attendance correction request       | **NO-HANDLER**; no form   | decision 7                                                                                       |
| Role change request                 | **NO-HANDLER**; no form   | never grants local privilege                                                                     |
| Staff CRUD / compensation / payroll | ONLINE                    | payroll-final never written offline                                                              |
| Local POS-user PIN admin            | **LOCAL**                 | `posAuth` bridge                                                                                 |

## Settings / device governance

| Action                                   | Status                                | Notes                                                                                                         |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local preferences                        | **LOCAL**                             | apply immediately                                                                                             |
| Branch/business/register/return settings | ONLINE; offline form → **NO-HANDLER** | `settings.change_request` disposes `blocked_policy` (no typed per-setting handler; decision 9)                |
| Revoke this device                       | **AUTO-E2E** (policy-gated)           | self only; applied on sync (`OIA_DEVICE_REVOKED`); other device → `OIX_SCOPE_DENIED`; later commands 401 (A9) |
| Lease / grant renewal                    | ONLINE (by design)                    | expiry fails closed (API I5; POS expired-grant test). Lease length unchanged (decision 6)                     |

## Reports / activity / sync

| Action                       | Status    | Notes                                                                                                                                                                    |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server reports               | ONLINE    | canonical                                                                                                                                                                |
| On-device report             | **LOCAL** | labelled "this till only"; not re-audited for date range / missing-device coverage this run (NOT TESTED)                                                                 |
| Activity log                 | **LOCAL** | device ledger                                                                                                                                                            |
| Sync review (reconciliation) | **LOCAL** | shows server outcomes (applied / rejected / needs reconciliation / blocked policy); only exact retry of a transport-blocked command; **no manager request, no override** |

## ADR-042 follow-up revision (2026-11-14, roadmap §23) — supersedes conflicting rows above

| Action                                                      | Status                                                     | Evidence                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| New customer offline (name + phone)                         | **E2E**                                                    | HTTP C1–C3, N1–N3; POS tests; profile purged at the next sync, outbox redacted                |
| Installment / paydown for a customer created offline        | **E2E** (dependency v19)                                   | HTTP N1–N2; POS `customer-installment-dependency`; Electron `acceptance:customer-installment` |
| Customer rejected by the server                             | **HELD on till** (`CUSTOMER_DEPENDENCY_REJECTED`)          | HTTP N3; **Finding A**: blocks stock-grant close at enforced locations (N4)                   |
| Sale within an enforced POS stock grant                     | **E2E** (gate unlocked on disposable DB only)              | HTTP S1–S3; phase_3c                                                                          |
| Offline voucher redemption                                  | **E2E** (test-only caps; production caps unset ⇒ no grant) | HTTP S4–S5; phase_3d                                                                          |
| Admin credentials at the till (voucher/return)              | **E2E**, verifier v2                                       | HTTP O1–O4; phase_3d P1–P11; POS roster tests                                                 |
| Generic intents (inventory/suppliers/staff/settings/review) | **RETIRED** (`OIX_KIND_OUT_OF_SCOPE`)                      | HTTP R0–R4 (intents-client)                                                                   |
| Lease / catalog freshness                                   | **Clamped at issuance** (≤ 24 h, catalog ≤ lease)          | phase_3d L3–L11; POS `lease-expiry`                                                           |
| Non-cash tender                                             | E2E recorded; stored `captured` — **Finding B**            | HTTP case 4/6                                                                                 |

## Blocker program revision (2026-11-14 evening, roadmap §24) — supersedes conflicting rows above

| Action                                             | Status                                                                        | Evidence                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Customer rejected → dependent installment sale     | **E2E terminal hold** (`held_for_reconciliation`, local v20)                  | HTTP N4; phase_3g; POS `sale-hold.test.ts`; Electron `acceptance:sale-hold` |
| Stock-grant close / re-bootstrap after a held sale | **E2E** (close offered only after server ack)                                 | HTTP N4 (old grant closed, held units retained); phase_3g R1–R10            |
| Hold resolution (convert / return to stock)        | **OWNER DECISION O-A1** (held units stay reserved, listed)                    | —                                                                           |
| Non-cash tender (card / InstaPay / wallet) offline | **E2E recorded, `pending` — awaiting provider confirmation** (never captured) | HTTP N1, case 4/6 (DB `pending`, `captured_at` NULL; cash leg `captured`)   |
| Concurrent Website/POS split                       | **E2E optimistic concurrency** (one winner, others 409 + current values)      | inventory write integration 20/20 (race tests)                              |
| Grant expiry                                       | **Retained until the till's final ordinal** (no early release)                | phase_3c X2–X9                                                              |
| Admin-mobile split screen vs authenticated backend | **NOT RUN** (interactive auth)                                                | 223 screen/unit tests only                                                  |
