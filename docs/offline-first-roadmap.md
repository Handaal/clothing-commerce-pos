# Offline-first POS — living roadmap & status

Canonical status document for taking the clothing-commerce POS to a secure, reliable,
end-to-end offline-first cashier. Resumable across sessions. Update the **Phase ledger** and
**Resume point** at every phase boundary.

- Canonical offline **contract**: `clothing-commerce-api/docs/pos/offline-pos-v1.md` (Phase 2I authority & ingestion).
- Offline **deferral rationale** (returns/promotions): `docs/offline-returns-promotions.md`.
- Owning ADRs: `clothing-commerce-api/docs/decisions/ADR-007` (register/device), `ADR-008`
  (identity/role/scope), `ADR-017..023` (inventory ledger/concurrency/idempotency),
  `ADR-024..028` (order/pricing-snapshot/idempotency), `ADR-036` (SDK distribution).

> Scope note (unchanged invariants): API is the only global authority; clients consume the
> packed/versioned SDK over HTTPS; no POS-private stock ledger (the local DB is operational
> state, never global truth); offline tender is **not** proof money moved; no offline mutation
> is shown as globally complete before server acknowledgment.

---

## 1. Live baseline (verified 2026-11-07)

All four repos are checked out under `C:\Users\ydelk\Desktop\`. Branches/HEADs **as inspected**,
not from stale notes:

| Repo                           | Branch                            | HEAD                   | Notes                                                                                                             |
| ------------------------------ | --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| clothing-commerce-api          | `feat/pos-pin-provider`           | `87aedad` (2026-11-07) | +23 ahead of main. POS PIN provider, offline catalog classification, 6 hardened offline business fns, SDK 0.26.0. |
| clothing-commerce-pos          | `feat/pos-pin-login`              | `3bbb6fe` (2026-11-06) | +12 ahead of main. Offline-first PIN auth, commissioning, runway, UX pass. Consumes SDK 0.26.0.                   |
| clothing-commerce-storefront   | `main`                            | `f4955ca` (2026-11-06) | SDK 0.12.0 (no offline need).                                                                                     |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `c955019` (2026-11-07) | SDK 0.26.0 (canonical artifact).                                                                                  |

**SDK provenance.** API source SDK = **0.26.0**. Freshly built API artifact and admin-mobile
vendored copy share sha256 `98968377…`. **POS vendored copy differs**: sha256 `353c28d8…`.
Extraction diff shows the `dist/` bundle (ESM/CJS/d.ts) is **byte-identical**; the only
difference is `package.json` key-ordering + a trailing newline → POS vendors a _re-packed but
functionally identical_ 0.26.0. POS `tests/boundaries.test.ts` **locks** the non-canonical
`353c28d8…`. **Decision (Phase 2):** leave as-is. The runtime `dist/` is byte-identical, so a
byte-swap of a committed, test-locked security artifact would be pure symmetry-chasing (against
operating rule 8 "do not upgrade every client just for symmetry" / "small reviewable changes").
Recorded as a low-priority provenance-hygiene item; if the SDK vendor pipeline is ever
normalized, align POS to the canonical `98968377…`. Storefront 0.12.0 is intentionally behind
(no offline surface).

### Test baseline (DB-free, run locally 2026-11-07)

| Suite                                                   | Result                                |
| ------------------------------------------------------- | ------------------------------------- |
| POS `pnpm test` (after `.claude/**` vitest exclude fix) | **200 passed / 4 skipped / 0 failed** |
| POS `typecheck` (3 tsconfigs)                           | clean                                 |
| POS `lint` (eslint)                                     | clean                                 |
| API `pnpm test` (all integration dirs excluded)         | **384 passed**                        |
| API `test:api:contracts`                                | 22 passed                             |
| API `test:openapi` (drift + structure)                  | 16 passed                             |
| API `test:sdk` (pack/install/ESM+CJS/strict typecheck)  | OK, 0.26.0                            |

> Fixed 2026-11-07: `pnpm test` previously reported 2 failures from **stale leftover git
> worktrees** under `.claude/worktrees/{hardcore-gates,fervent-murdock}` (detached at `4c3204a`,
> pinning SDK 0.19.0) that the vitest glob scanned. `vite.config.mts` now excludes `**/.claude/**`
> (merged with vitest defaults), so the canonical command is green. The worktrees themselves are
> left untouched (prior-session worktrees — remove with `git worktree remove` only if confirmed
> disposable).

> Not yet run: API DB integration/persistence/RLS suites (`test:pos:offline:integration`,
> `test:pos:offline:rls`, etc.). They require an **isolated disposable** Postgres/Supabase with
> proven ownership (operating rule 9). Deferred to Phase 6 fault-injection; a local dev
> instance exists (see memory `local-dev-pos-pin-standup`) but it is the shared dev project and
> several suites drop/recreate `*_private` schemas between cycles → must not run against it.

---

## 2. Offline capability matrix

Classification: **OFFLINE** = works after bootstrap while grant valid · **QUEUED** = durably
queued, signed, replayed, server-authoritative acceptance · **CACHED** = read-only snapshot ·
**ONLINE** = requires live authority · **BLOCKED** = intentionally unavailable offline ·
**N/A** = not a POS workflow.

| #   | Workflow                                 | Class                | Evidence                                                                                                                    |
| --- | ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device commissioning / enrollment        | ONLINE (one-time)    | API `pos/devices`, `offline-bootstrap`; POS `commissioning.ts`, `runOfflineBootstrap`                                       |
| 2   | Grant / lease top-up & runway            | OFFLINE+auto         | POS `offline/runway.ts`, `OfflineRunwayNote.tsx`; auto-refresh when runway low/recoverable                                  |
| 3   | Staff sign-in (PIN gate offline)         | OFFLINE (gate only)  | `offline:verify-staff-pin`; migration `20261024120000_create_offline_pin_credentials`; sale attributed to grant operator    |
| 4   | Catalog / variant / price lookup         | CACHED               | `offline:get-cached-catalog`; grant carries authoritative `priceId`+`authorizedUnitPriceMinor`                              |
| 5   | Catalog classification (brand/category)  | CACHED               | migration `20261101130000_offline_catalog_classification`; captured at bootstrap                                            |
| 6   | Barcode / SKU search                     | CACHED               | offline catalog snapshot (SKU/options summary)                                                                              |
| 7   | Projected inventory (advisory)           | CACHED               | `offline:get-projected-inventory`; advisory only, server re-checks at ingestion                                             |
| 8   | Cash sale                                | QUEUED               | `offline:accept-cash-sale` → signed command → `POST offline-sales`; `offline-pos-v1.md`                                     |
| 9   | Split tender (cash + others)             | QUEUED (cash proven) | migration `20261005180200_offline_split_tender`; non-cash tender recorded, **not settled**                                  |
| 10  | Customer capture / search / history      | CACHED + QUEUED      | `offline:get-offline-customers`; capture travels with the sale command                                                      |
| 11  | Customer installment sale                | QUEUED (verify)      | migrations `20261030130100_pos_installment_sale`, `20261030140000_offline_installments` — path to confirm Phase 3           |
| 12  | Customer payment (installment paydown)   | QUEUED               | `offline:record-customer-payment` → `POST offline-customer-payments`; migration `20261030150000`                            |
| 13  | Returns / refunds / exchange             | BLOCKED              | `docs/offline-returns-promotions.md`; needs server-issued signed return grant (absent)                                      |
| 14  | Promotions / vouchers                    | BLOCKED (never)      | server-authoritative discount money; frozen V1 rule                                                                         |
| 15  | Inventory receive / adjust / transfer    | ONLINE               | server ledger authority; no POS-private ledger (ADR-017/023)                                                                |
| 16  | Suppliers / purchases / dues             | ONLINE               | management channel; not an offline cashier workflow                                                                         |
| 17  | Attendance clock-in/out                  | ONLINE (confirm)     | POS attendance button; offline path to assess Phase 3                                                                       |
| 18  | Payroll                                  | N/A (back-office)    | admin/back-office, not offline cashier                                                                                      |
| 19  | Reports / activity                       | ONLINE / local-only  | server reporting; local pending-sync summary is operational                                                                 |
| 20  | Operational settings / device governance | ONLINE               | rotation/revoke require online authority                                                                                    |
| 21  | Local crash recovery                     | OFFLINE              | `acceptance:sale-recovery`, `acceptance:persistence`, durable outbox                                                        |
| 22  | Sync / acknowledgment / reconciliation   | QUEUED→server        | `offline:request-sync`, `get-sync-status`, `acknowledge-sale`, `get-pending-sync-summary`; server opens reconciliation rows |

---

## 3. Phase ledger

| Phase                                       | State                                 | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline & matrix                       | **DONE 2026-11-07**                   | Repos/branches/SDK mapped; DB-free tests green; capability matrix above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 1 — Offline contract & decisions            | **DONE 2026-11-07**                   | Contract verified _in code_ (see §6): grant authority, acceptedAt window, credential-at-acceptance, idempotency+fingerprint, installment credit-cap, revoked/insufficient-stock reconciliation. All edge cases covered or documented-blocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2 — Secure offline foundation               | **DONE 2026-11-07**                   | Foundation verified; SDK provenance decision recorded (no swap); fixed `.claude/**` vitest exclude so `pnpm test` is green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3 — Per-workflow vertical slices            | **DONE 2026-11-07**                   | Each matrix row confirmed in code + tests (see §7). Installment (11), split-tender (9), customer payment (12) covered by `tests/offline/installments.test.ts` + `sale-atomicity.test.ts`. Attendance (17) is a connected-shell feature, honestly absent from the dedicated offline cashier (not a false affordance).                                                                                                                                                                                                                                                                                                                                                                                          |
| 4 — Sync / conflict / reconciliation        | **DONE 2026-11-07**                   | `tests/offline/outbox-restart` + sync-worker tests verify stable idempotency replay, retry/block, no-claim-offline, **crash-after-commit replay without duplication**, crash-lease recovery. Reconciliation rows surfaced to operator; _resolution_ workflow is a documented V1 server-side limitation.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5 — Offline-first UX                        | **DONE 2026-11-07**                   | `cashier.tsx` sync badge distinguishes needs-attention/blocked/synchronizing/pending/all-synced/connected/offline-ready; returns disabled w/ honest hint; reconciliation banner; receipt lifecycle shown; runway/commissioning strips; EN/AR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6 — Cross-repo acceptance & fault injection | **DONE (partial, candid) 2026-11-08** | Real-API offline ingestion + RLS run against a **genuinely isolated disposable** Postgres (§9). The stock `test:pos:offline:*` runners are **unsafe** (hardcoded shared dev project + `stop --no-backup`); a new isolated harness (`scripts/test-offline-pos-isolated.mjs`, reuses the Phase 2M ownership boundary) proved ingestion/idempotency/reconciliation/RLS on a disposable `rt-<hex>` DB. POS crash/recovery/ack proven by packaged Electron acceptance. Residual NOT-RUN items (true multi-device oversell, wire-level lost-response, schema-version reject, app-upgrade/corruption-vs-real-API) listed in §9. Original unsafe runbook retained in §8 for reference — **do not run those scripts**. |
| 7 — Final readiness & closeout              | **DONE (candid)**                     | Matrix §2 reconciled to code/tests §7; launch blockers in §4. No approved critical workflow is falsely claimed end-to-end: offline sale/installment/payment are proven locally (UI→main→signed outbox→SDK) but **server acceptance is proven only by mocked SDK + DB-free contract tests here** — real-API acceptance remains Phase 6.                                                                                                                                                                                                                                                                                                                                                                        |

## 4. NEEDS OWNER DECISION (carried)

- **Payment provider / card capture** — undecided. Non-cash offline tender is recorded and, at
  ingestion, routed through the **existing connected** `payments_private.capture_payments` /
  `capture_partial_payments` path — i.e. offline reuses the same payment semantics as a connected
  split-tender sale; it does **not** add any new gateway capture. There is no integrated payment
  provider: "captured" means a cashier-attested out-of-band tender (cash in drawer, or card/
  instapay/wallet approved on a standalone terminal), online or offline. _Risk:_ if an integrated
  gateway is ever added, offline (and connected) non-cash capture must become **provisional** and
  the POS UX must stop implying provider settlement. _Safe default in place; not introduced by
  offline work; not refactored here (operating rule 8)._
- **Offline returns authority** — no server-issued signed return grant exists. Offline returns
  remain BLOCKED (fail-closed) until the API ships the capability (see
  `docs/offline-returns-promotions.md` for the exact contract that would unblock it). _Safe
  default in place._
- **Offline promotions** — never (frozen V1 rule); server owns all discount money. _Permanent._
- **Server grant window tuning for the target tenant** — operational (API/ops), not POS code;
  longer leases reduce reconnection pressure. _No code blocker._

## 5. Resume point

**Phase 6 real-API acceptance executed 2026-11-08** against an isolated disposable DB (§9): the core
ingestion/idempotency/reconciliation/RLS matrix and POS crash/recovery/ack are **PASS**; a bounded
set of fault scenarios remains **NOT RUN** (see §9 matrix: true multi-device oversell, wire-level
lost-response as one real-API path, schema-version rejection assertion, app-upgrade local migration,
packaged corruption-vs-real-API). **Next safe action:** extend `scripts/test-offline-pos-isolated.mjs`
(API, branch `feat/pos-pin-provider`) with those scenarios — it is already proven isolated, so new
assertions inherit the ownership boundary. Do **not** run the stock `test:pos:offline:*` /
`test:pos:sale:integration` / `test:rls` scripts: they target the shared dev project and
`stop --no-backup` it (Phase 2M data-loss path).

No pending migrations or partial schema changes exist. Working-tree changes carried this session:
POS `vite.config.mts` (vitest `.claude/**` exclude) + `docs/offline-first-roadmap.md` (this file),
both uncommitted; API adds new untracked `scripts/test-offline-pos-isolated.mjs` (test harness only,
no domain/migration/SDK change). Nothing committed, pushed, or deployed. Full per-repo state in §9.

## 6. Phase 1 — contract verification evidence (code, not docs)

Verified by reading the live migrations + POS main process on 2026-11-07:

- **Grant issuance** `offline_pos_private.issue_grant` (`20261030140000`): per-location advisory
  xact-lock → **only one active device per inventory location** (multi-register oversight); embeds
  immutable catalog snapshot (authoritative `priceId`/`authorizedUnitPriceMinor`), customer
  snapshot with outstanding, and the credit cap; lease = `least(operator, catalog)`.
- **Ingestion** `offline_pos_private.record_offline_sale` (`20261030140000`): idempotency by
  `(tenant, syncCommandId)` with `command_fingerprint` → exact replay returns the original;
  different intent → `ID409`. Re-validates binding, schema version, **acceptedAt window ±5min**,
  **credential validity _at acceptance time_**, ordinal, per-line quantity, **grant-price
  authority** (line rejected if price/priceId/active drift from snapshot), total, per-sale +
  cumulative exposure. Installment branch: mandatory known customer, positive deposit, outstanding
  match, **per-sale + cumulative credit-cap**; deposit via `capture_partial_payments`, customer
  attach, `record_sale_debt` — mirrors connected `record_sale`.
- **Stock / revocation reconciliation:** server re-locks balance at ingestion
  (`lock_balance_for_offline_sale`); insufficient → no fulfillment, no negative inventory,
  `insufficient_stock_at_ingestion` reconciliation + event. Revoked device → Order+Payment created
  but **no inventory issue**, `device_revoked_at_ingestion` reconciliation. Never silently dropped.
- **POS-side durable enforcement** `src/main/offline/offline-service.ts`: readiness gate blocks on
  device status, binding mismatch, **clock rollback** (`CLOCK_ROLLBACK_TOLERANCE_MS`), grant/
  catalog window, policy limits, credit cap. `acceptInTransaction` persists the signed canonical
  command + outbox row **inside one SQLite transaction before any network** (durable intent);
  ordinal/exposure/credit counters are durable SQLite sums, not renderer state. Signing is
  main-process only; preload exposes no key/sql/signature (locked by `boundaries.test.ts`).
- **Edge-case checklist status:** multi-register same-stock ✓ (location lock + ingestion
  reconciliation) · other-channel consumption during disconnect ✓ (advisory stock, server
  authoritative) · stale price ✓ (frozen grant) · stale promo ✓ (blocked) · expired/revoked
  staff/device ✓ · clock rollback ✓ · offline returns ✓ (blocked) · ambiguous tender → see owner
  decision · duplicate/out-of-order replay ✓ (idempotency+fingerprint+ordinal) · corrupted/
  restored device → replay retention indefinite; local fail-closed readiness (confirm corruption
  behavior in Phase 6) · customer matching/installments/payments ✓.

## 7. Phase 3–5 — slice & sync verification evidence (code + passing tests)

All in `tests/offline/` (run under the green `pnpm test`, real SQLite, real main-process service):

- **Cash sale (8), atomicity, advisory stock** — `sale-atomicity.test.ts`: persists trusted
  line/tender/receipt + exact signed command; deducts unreleased accepted quantities from advisory
  stock; rejects mutation of accepted facts; rolls back every write + receipt allocation on a
  failure at each stage.
- **Installment (11) + customer payment (12)** — `installments.test.ts`: deposit-now +
  remainder-as-debt; projected running balance; reject unknown snapshot customer; reject credit-cap
  breach; unavailable when grant has no cap; paydown reduces balance + queues signed command;
  reject paydown above balance / unknown customer; fully-settled sale carries no installment fields.
- **Split tender (9)** — command carries `tenders[]`; non-cash is recorded, never shown settled;
  server ingestion reuses connected capture semantics (see §4 owner decision).
- **Sync / replay / crash (Phase 4)** — sync-worker + `outbox-restart.test.ts`: stable
  idempotency key passed unchanged through the SDK; exact persisted request delivered + atomically
  recorded; retry transient / block permanent authority failures; no claim while offline; **replays
  the same command after a crash _following_ server commit without duplicating**; recovers an
  expired crash lease on fast restart; write-lock prevents double-claim.
- **Ack recovery** — `offline-ack` acceptance (packaged Electron crash proof) + ack tests:
  freshly accepted sale is durably committed-but-unacknowledged; removed from recovery only on
  acknowledgement; ack is write-once, independent of sync; multiple unacknowledged sales presented
  oldest-first.
- **Fail-closed** — corrupt ledger is preserved and blocks offline acceptance without crashing
  connected mode; corrupt device key preserved + fails closed; secure-storage-unavailable fails
  closed.
- **Boundary (Phase 5/Electron)** — `boundaries.test.ts`: renderer has no `node:`/`electron`
  imports, no secret keys; preload exposes only the fixed `foundation`/`offline` allowlist, no
  sql/key/signature/ipcRenderer.send.
- **UX honesty** — `cashier.tsx` `syncLabel` → needs-attention / blocked / synchronizing /
  pending / all-synced / connected / offline-ready; returns disabled with honest hint;
  reconciliation banner; receipt lifecycle (`accepted_pending_sync` / `synced` /
  `needs_reconciliation`) shown; runway + commissioning strips; full EN/AR.

## 8. Phase 6 runbook (not run here — needs isolated disposable DB)

Do **not** run these against the shared dev Supabase (several suites drop/recreate `*_private`
schemas between cycles — operating rule 9). On an isolated instance with proven ownership:

```
# clothing-commerce-api
pnpm test:pos:offline:integration   # real signed-command ingestion, reconciliation, idempotency
pnpm test:pos:offline:rls           # offline_pos_writer tenant isolation
pnpm test:pos:sale:integration      # connected sale parity
pnpm test:all                       # full persistence/RLS/concurrency matrix

# clothing-commerce-pos (packaged, local only — safe)
pnpm acceptance:offline-ack         # crash-before-ack recovery (packaged Electron)
pnpm acceptance:sale-recovery       # sale crash recovery
pnpm acceptance:persistence         # durable local persistence
```

Still to exercise end-to-end against a real API for full launch readiness: multi-device overlap
oversell → reconciliation; storefront stock consumption during disconnect → reconciliation; lease
expiry/revocation at ingestion; time-rollback rejection server-side; duplicate/out-of-order replay
on the wire; app-upgrade local-schema migration; disk/storage corruption vs restart; rejected
command surfaced to operator. Each has a local unit/contract proxy that passes today (§7); the gap
is a live-API run, not missing logic.

> **2026-11-08 correction:** the three scripts above (`test:pos:offline:integration`,
> `test:pos:offline:rls`, `test:pos:sale:integration`) are **NOT isolated** — see §9.1. They are
> hardcoded to the shared dev project and finish with `stop --no-backup`. **Do not run them.** The
> isolated replacement is `scripts/test-offline-pos-isolated.mjs` (§9.2). The POS packaged-Electron
> acceptance scripts (`acceptance:offline-ack` / `sale-recovery` / `persistence`) remain safe & local.

---

## 9. Phase 6 execution — real-API acceptance on an isolated disposable DB (2026-11-08)

Executed against **verified-current** code (facts re-derived from source, not prior summaries).

### 9.0 Per-repo state at execution

| Repo                           | Branch                            | HEAD      | Worktree (uncommitted)                                                                                                                                                           |
| ------------------------------ | --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clothing-commerce-api          | `feat/pos-pin-provider`           | `87aedad` | `M next-env.d.ts`; `?? scripts/seed-rich-product-media.mjs`, `?? supabase/dev/seed-rich-{catalog,orders}.sql`; **+ new `?? scripts/test-offline-pos-isolated.mjs` (this phase)** |
| clothing-commerce-pos          | `feat/pos-pin-login`              | `3bbb6fe` | `M vite.config.mts`; `?? docs/offline-first-roadmap.md` (this doc), `?? pos-login.png`, `?? scripts/capture-window.ps1`, `?? scripts/preview-storefront.mjs`                     |
| clothing-commerce-storefront   | `main`                            | `f4955ca` | `M next-env.d.ts`, `M next.config.ts`                                                                                                                                            |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `c955019` | `?? sf-test.txt`, `?? work/`                                                                                                                                                     |

All on their upstream tip, no divergence. No branch switch / reset / stash / commit / push / deploy
performed. All pre-existing user changes preserved; the only file added is the isolated test harness.

### 9.1 Isolation finding (why the stock runners must not run)

`scripts/test-offline-pos-integration.mjs`, `test-offline-pos-rls.mjs`, `test-pos-sale-integration.mjs`
all: (a) hardcode `container = "supabase_db_clothing-commerce-api"`; (b) call `supabase start` /
`db reset --local` / `stop --no-backup` **without `--workdir` or `--project-id`**, so the CLI reads the
repo `supabase/config.toml` → selects the **shared dev project** `clothing-commerce-api`; (c) run
`stop --no-backup` in `finally`. That is the exact destructive path recorded in
`clothing-commerce-api/docs/development/phase-2m-test-isolation.md` (local data-loss incident). At
execution the shared dev stack was **running and healthy** (holds the `local-dev-pos-pin-standup`
seed). Running any of these would reset then delete that volume. **Verdict: not isolated; not run.**

### 9.2 Isolated harness & ownership proof (non-secret identifiers only)

New runner `clothing-commerce-api/scripts/test-offline-pos-isolated.mjs` reuses the **proven** Phase 2M
ownership boundary (`scripts/returns-test-resources.mjs`): unique `rt-<32 hex>` project in a disposable
temp workdir carrying an ownership marker, started with `--workdir` (every CLI call pinned to the
isolated project), **fresh-project migrations (no reset of any existing DB)**, `bindConfig` fail-closed
guard (aborts if the `project_id` swap did not take), and cleanup that deletes only resources whose
labels positively match this run's marker. The vitest child's DB target is forced to the isolated URL,
overriding any inherited `.env`/`POS_TEST_*`.

| Isolation property                     | Evidence (this run)                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Disposable project id                  | `rt-bcfae01da41540668249d7cd866f04ba` (unique per run; initial `plan()` asserts empty namespace)                                             |
| Disposable workdir + ports             | `%TEMP%\rt-bcfae…-rfqsQm\`; API/DB on freshly-allocated free ports (127.0.0.1)                                                               |
| Target is disposable, not shared/prod  | `project_id` swapped away from `clothing-commerce-api`; `bindConfig` verified single isolated id; API routing asserted `127.0.0.1:<apiPort>` |
| Shared dev project untouched           | after run, `supabase_*_clothing-commerce-api` still **Up** with the same uptime (not restarted)                                              |
| Cleanup scoped to this run only        | after run, `label=com.supabase.cli.project=rt-bcfae…` → **0 containers**; temp workdir removed                                               |
| Prior unrelated `rt-*` leftovers       | two older `supabase_db_rt-*` from prior returns-safety runs **left untouched** (not this run's marker)                                       |
| No broad prune / no `stop --no-backup` | harness contains neither; cleanup is label-matched `rm` only                                                                                 |
| Secrets                                | service-role/anon keys captured only into child env, never printed; status calls `redacted`                                                  |

### 9.3 Test matrix (real API + disposable DB unless noted)

Commands actually run (all exit 0): POS `pnpm test` (200 pass/4 skip, real SQLite, DB-free);
API `node scripts/test-offline-pos-isolated.mjs` (RLS pgTAP **10/10 PASS**, integration **10/10 PASS**);
POS `pnpm acceptance:offline-ack` / `sale-recovery` / `persistence` (packaged Electron, local, self-contained).

| #   | Scenario                                                                 | Setup                                           | Expected API/DB result                                                                                                                             | Observed                                                                                                                         | Evidence                               | Verdict     |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------- |
| 1   | Device commissioning / enroll                                            | real route handler + disposable DB              | enroll 200; replay 200; key-rotation 409; wrong-scope 403; foreign-tenant 403                                                                      | as expected                                                                                                                      | `offline-pos.integration.test.ts` it#1 | **PASS**    |
| 2   | Bootstrap grant binding                                                  | enroll→bootstrap                                | grant bound to tenant/device/register/location, bounded policy, authorized price, customers; 2nd device on location 409; no-policy register 403    | as expected                                                                                                                      | it#2                                   | **PASS**    |
| 3   | Device-bound staff roster (offline PIN)                                  | provision 3 PINs via real `set_offline_pin` RPC | roster = only authorized seller; KDF verifies correct PIN for this device, rejects wrong PIN/other device                                          | as expected                                                                                                                      | it#3                                   | **PASS**    |
| 4   | Tamper / wrong credential / expired window / policy caps                 | signed commands                                 | tamper→401, wrong device cred→401, past acceptedUntil→409, over-sale/line/pending/exposure→422                                                     | as expected                                                                                                                      | it#4                                   | **PASS**    |
| 5   | Grant-price authority + exact-once replay                                | change catalog price, ingest                    | accepts frozen grant price; synced; order/payment/fulfillment created; replay returns identical, row counts unchanged; changed-intent same key→409 | as expected                                                                                                                      | it#5                                   | **PASS**    |
| 6   | Mid-composition failure rollback                                         | induced failure                                 | 500; zero partial writes across orders/payments/fulfillments/inventory ops+movements/ingestions; stock unchanged                                   | as expected                                                                                                                      | it#6                                   | **PASS**    |
| 7   | Insufficient stock at ingestion (≈ cross-channel consumption)            | deplete stock via RPC, ingest                   | `needs_reconciliation` (`insufficient_stock_at_ingestion`), no fulfillment, no negative inventory, idempotent; 1 reconciliation row                | as expected                                                                                                                      | it#7                                   | **PASS**    |
| 8   | Offline customer paydown verification                                    | signed paydown, seeded customer w/ no debt      | end-to-end verify (sig→grant→cred→customer→A/R) then overpay→422; tampered amount→401                                                              | as expected                                                                                                                      | it#8                                   | **PASS**    |
| 9   | Device revocation at ingestion                                           | revoke device, ingest queued cmd                | bootstrap after revoke→409; queued command→`needs_reconciliation` (`device_revoked_at_ingestion`), no fulfillment                                  | as expected                                                                                                                      | it#9                                   | **PASS**    |
| 10  | Tenant RLS / anon isolation                                              | anon client                                     | all 8 offline authority tables invisible to anon                                                                                                   | as expected                                                                                                                      | it#10                                  | **PASS**    |
| 11  | DB-level RLS privilege graph                                             | pgTAP plan(10)                                  | writer NOLOGIN/NOBYPASSRLS; 6 hardened SECDEF fns; non-forced RLS; no client policies; service-role read-only + execute-only; tenant-safe FKs      | 10/10                                                                                                                            | `phase_2i_offline_pos_rls.test.sql`    | **PASS**    |
| 12  | POS crash before ack                                                     | packaged Electron                               | exact sale recovered, requires ack, 2nd sale distinct id                                                                                           | `recoveredExactSale:true, secondSaleDistinct:true`                                                                               | `acceptance:offline-ack`               | **PASS**    |
| 13  | POS crash after server commit, response lost                             | packaged Electron (stubbed API)                 | retained command replays with ORIGINAL idempotency key → exactly one order                                                                         | `dispatchedKeyCount:2, distinctKeyCount:1, pendingAfter:false`                                                                   | `acceptance:sale-recovery`             | **PASS**    |
| 14  | Durable local persistence + lease recovery                               | packaged Electron                               | accepted_pending_sync persisted; crash lease reclaimed on restart; no premature ingestion                                                          | `recoveredLeases:1, reclaimedAttempt:2`                                                                                          | `acceptance:persistence`               | **PASS**    |
| 15  | Wire-level "commit then response lost" as one **real-API** path          | —                                               | —                                                                                                                                                  | proven by composition only (handler idempotency on real DB #5 + POS stubbed-crash replay #13); not run as a single real-API path | —                                      | **NOT RUN** |
| 16  | True multi-device concurrent oversell → reconciliation                   | needs 2 live devices on same stock              | —                                                                                                                                                  | location-lock blocks 2nd active device (#2); concurrent overlapping-stock oversell not exercised                                 | —                                      | **NOT RUN** |
| 17  | Installment **sale** happy-path server acceptance (deposit+debt)         | needs customer-with-cap fixture                 | —                                                                                                                                                  | POS side proven (`installments.test.ts`); server happy-path not asserted this run                                                | —                                      | **NOT RUN** |
| 18  | Successful paydown reducing balance                                      | needs customer-with-debt fixture                | —                                                                                                                                                  | verification+rejection proven (#8); balance-reducing accept not asserted this run                                                | —                                      | **NOT RUN** |
| 19  | Multi-tender (non-cash) offline command server acceptance                | —                                               | —                                                                                                                                                  | cash proven (#5); non-cash settlement reuses connected capture, not asserted offline this run                                    | —                                      | **NOT RUN** |
| 20  | Unsupported contract/schema-version rejection                            | —                                               | —                                                                                                                                                  | validated in `record_offline_sale` (§6) + unit/contract tests; not asserted in this run's integration suite                      | —                                      | **NOT RUN** |
| 21  | App-upgrade local-schema migration; packaged disk corruption vs real-API | —                                               | —                                                                                                                                                  | POS fail-closed unit proofs pass (§7 `runtime-fail-closed`); packaged corruption-vs-real-API not run                             | —                                      | **NOT RUN** |

No duplicate order/payment, no silent data loss, and correct reject/reconciliation states were
observed in every PASS row. No overclaim: rows 15–21 are **NOT RUN** here.

### 9.4 Offline-promotions decision — substantiated (evidence, not assertion)

**Conclusion: offline promotions are both (a) not implemented and (b) prohibited by the current
approved pricing architecture.** The "never" is accurate for V1 but rests on invariant-level ADRs +
a frozen V1 rule, not a single dedicated "no offline promotions" ADR.

- **Architecturally forbidden by accepted ADRs.** `ADR-026` (immutable pricing snapshots) + `ADR-037`
  (promotion accounting) make discount money server-computed and allocated immutably to lines
  (`order_adjustments` / `order_line_adjustments` / `promotion_redemptions`, append-only via
  `forbid_history_mutation`). The order-line identity CHECK (`line_total = qty * unit_price`) and the
  offline grant's authorization of list `unit_price_minor` mean a discount **cannot** be folded into
  an offline line without breaking both invariants (ADR-037 "Alternatives rejected").
- **Not in the offline contract/grant.** The offline bootstrap/grant contracts carry **no** promotion
  fields (`clothing-commerce-api/src/contracts`); `src/pos/offline-service.ts` has **no** promotion/
  discount handling; the device holds only authorized prices.
- **No offline UI path.** `src/renderer/offline/cashier.tsx` has no discount/promo/quote affordance;
  the only discount path, `src/renderer/promotions/quote.ts` (`QuoteController`), requires a **live**
  `client.posQuote` and `reset()`s when offline; `App.tsx switchToOffline` clears applied code + quote.
  There is therefore **no offline discount path to test** — fail-closed is structural, not a toggle.
- **Documented V1 rule.** `clothing-commerce-pos/docs/offline-returns-promotions.md` — "Promotions
  offline — never (by design)… Frozen V1 rule: no offline promotions."
- **Risks of a frozen offline promo snapshot** (why naive caching is unsafe): expiry, per-code
  redemption limits, stacking, eligibility drift, list-price changes, **shared redemption across
  devices/channels**, discount-budget exhaustion, replay/concurrency — none enforceable offline because
  the device holds no counters and the server owns the immutable one-per-order redemption fact.
- **Could a bounded pre-authorized promo grant exist?** Plausibly, mirroring the offline-sale grant: a
  short-lived signed promo budget with per-code caps, with the **server** doing final allocation +
  reconciliation at ingestion (never the client). This is a design question, **not decided here**.
- **Owner decision needed:** if offline discounts are ever wanted, record an explicit ADR for a bounded
  pre-authorized promotion grant. Until then, the verified fail-closed behavior is correct.

### 9.5 Remaining-workflow inventory (every POS action; status from current code)

Legend: **E2E proven** = offline op + real-API acceptance passed · **Impl, accept unproven** = offline
code present, server acceptance not proven this run · **Queued/provisional** = durable local record,
server may reject/reconcile · **Cached RO** = read-only snapshot · **Online-only (policy)** ·
**Blocked/NI** = blocked or not implemented · **N/A**. "Run?" = exercised in this 2026-11-08 run.

| Workflow / action                                         | Status                                         | Run?                 | Evidence                                         | Server/global side effects         | Remaining work                                   |
| --------------------------------------------------------- | ---------------------------------------------- | -------------------- | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------ |
| Device commissioning / enroll                             | Online-only (one-time) **+ accept E2E proven** | ✅                   | §9.3 #1; `commissioning.ts`                      | creates device+credential          | —                                                |
| Offline bootstrap / grant issuance                        | **E2E proven**                                 | ✅                   | #2; `runOfflineBootstrap`                        | per-location grant lock            | —                                                |
| Grant / lease runway auto-refresh                         | Offline+auto                                   | ❌                   | `offline/runway.ts` (unit §7)                    | top-up online                      | real-API runway refresh under load               |
| Staff sign-in (offline PIN gate)                          | **E2E proven** (roster+KDF)                    | ✅                   | #3                                               | roster bound to device             | —                                                |
| Register/session/context                                  | Offline (bound by grant)                       | ⚠ unit               | `pos-session.test.ts`; grant binding #2          | —                                  | —                                                |
| Catalog / variant / price lookup                          | **Cached RO**                                  | ✅ (price authority) | #5; `get-cached-catalog`                         | server re-checks price             | —                                                |
| Catalog classification (brand/category)                   | **Cached RO**                                  | ❌                   | migration 12; bootstrap capture                  | —                                  | —                                                |
| Barcode / SKU search                                      | **Cached RO**                                  | ❌                   | offline catalog snapshot                         | —                                  | —                                                |
| Projected inventory (advisory)                            | **Cached RO**                                  | ✅ (reconcile)       | #7; advisory only                                | server authoritative at ingest     | —                                                |
| Cash sale                                                 | **E2E proven**                                 | ✅                   | #5 ingest + #12–14 durable                       | order/payment/fulfillment          | —                                                |
| Split tender — cash leg                                   | **E2E proven**                                 | ✅                   | #5                                               | capture                            | —                                                |
| Split tender — non-cash leg                               | **Queued/provisional**                         | ❌                   | migration `20261005180200`; recorded not settled | reuses connected capture at ingest | assert non-cash offline ingest on real API (#19) |
| Customer capture / match / history                        | **Cached RO + Queued**                         | ⚠ (lookup #8)        | `get-offline-customers`; capture travels w/ sale | customer attach at ingest          | happy-path capture ingest                        |
| Installment sale                                          | **Impl, accept unproven**                      | ❌                   | `installments.test.ts` (POS); §6 server path     | deposit+debt at ingest             | server happy-path assert (#17)                   |
| Customer payment (paydown)                                | **Impl, accept partially proven**              | ⚠ (verify+reject #8) | #8; `record-customer-payment`                    | A/R paydown at ingest              | balance-reducing accept (#18)                    |
| Returns / refunds / exchange                              | **Blocked (policy)**                           | n/a                  | `offline-returns-promotions.md`; disabled UI     | —                                  | server-issued signed return grant (absent)       |
| Promotions / vouchers                                     | **Blocked (policy+architecture)**              | n/a                  | §9.4; ADR-026/037; no contract/UI path           | server owns discount money         | owner ADR if ever wanted                         |
| Idempotency / exact-once replay                           | **E2E proven**                                 | ✅                   | #5, #13                                          | no duplicate order                 | —                                                |
| Insufficient-stock reconciliation                         | **E2E proven**                                 | ✅                   | #7                                               | reconciliation row + event         | —                                                |
| Device-revoked reconciliation                             | **E2E proven**                                 | ✅                   | #9                                               | order/payment, no issue            | —                                                |
| Expired/clock-skew grant rejection                        | **E2E (window) + unit (rollback)**             | ✅ (window #4)       | #4; POS `CLOCK_ROLLBACK_TOLERANCE_MS`            | 409 reject                         | server-side rollback assert                      |
| Invalid/revoked device credential                         | **E2E proven**                                 | ✅                   | #4, #9                                           | 401 / reconciliation               | —                                                |
| Tamper rejection                                          | **E2E proven**                                 | ✅                   | #4, #8                                           | 401                                | —                                                |
| Policy limits (sale/line/pending/exposure)                | **E2E proven**                                 | ✅                   | #4                                               | 422                                | —                                                |
| Mid-composition rollback                                  | **E2E proven**                                 | ✅                   | #6                                               | zero partial writes                | —                                                |
| Tenant/RLS isolation                                      | **E2E proven**                                 | ✅                   | #1 (foreign 403), #10, #11                       | deny-by-default                    | cross-tenant read/mutate of fixtures (broader)   |
| Multi-device / concurrent oversell                        | **Impl (lock), accept unproven**               | ❌                   | location-lock #2                                 | reconciliation path exists         | true concurrent oversell (#16)                   |
| Cross-channel (online/storefront) stock during disconnect | **E2E proven (equiv)**                         | ✅                   | #7 depletes then ingests→reconcile               | reconciliation                     | distinct real storefront consumer                |
| Inventory receive / adjust / transfer / issue             | **Online-only**                                | n/a                  | ADR-017/023; no POS-private ledger               | server ledger authority            | —                                                |
| Suppliers / purchases / dues / payments                   | **Online-only**                                | n/a                  | management channel                               | —                                  | —                                                |
| Attendance clock-in/out                                   | **Online-only** (connected shell)              | n/a                  | §3 ledger; absent from offline cashier           | —                                  | offline attendance not in scope                  |
| Payroll                                                   | **N/A** (back-office)                          | n/a                  | admin                                            | —                                  | —                                                |
| Reports / activity                                        | **Online-only / local pending-sync summary**   | ⚠                    | local summary operational                        | server reporting                   | —                                                |
| Operational settings / device governance                  | **Online-only**                                | n/a                  | rotation/revoke need online authority            | —                                  | —                                                |
| Local crash recovery                                      | **E2E proven**                                 | ✅                   | #12–14                                           | —                                  | app-upgrade migration (#21)                      |
| Sync / ack / reconciliation surfacing                     | **E2E proven (ingest) + unit (worker)**        | ✅                   | #5,#7,#9; §7 sync-worker                         | server opens reconciliation        | resolution workflow = server V1 limitation       |
| Unsupported contract/schema version                       | **Impl, accept unproven (this run)**           | ❌                   | §6 `record_offline_sale` validates; unit         | reject                             | integration assert (#20)                         |
| Packaged disk/storage corruption vs real API              | **Impl (fail-closed unit)**                    | ❌                   | §7 `runtime-fail-closed`                         | —                                  | packaged corruption-vs-real-API (#21)            |

### 9.6 Defects found & code changes

No product defects found. The only governance defect is the **unsafe stock offline-POS runners**
(§9.1) — a pre-existing test-infra hazard, not a regression. Change made this phase is narrowly scoped
and test-only: added `clothing-commerce-api/scripts/test-offline-pos-isolated.mjs`. No domain,
migration, SDK, OpenAPI, or commercial-policy code changed. Recommended (not done, out of scope):
retrofit the three stock runners onto the isolated boundary, or mark them unsafe in `package.json`.

**Not launch-ready on the strength of this phase.** Core offline ingestion/recovery is proven on a real
isolated API; rows 15–21 remain NOT RUN and must be closed before any launch claim.

---

## 10. Phase 6B — full HTTP-server-path acceptance, runner hardening, offline-need review (2026-11-08)

Continuation of Phase 6. Three objectives: (B) run remaining cases through a **real running API server over
HTTP** (not in-process handlers); (C) make the unsafe runners **fail closed**; (D) review §9.5 for which
online-only workflows must become offline for the cashier goal. Repo state unchanged from §9.0 except new
untracked API files added this phase (all test/guard/docs only): `scripts/test-offline-pos-http-isolated.mjs`,
`scripts/supabase-isolation-guard.mjs`, `tests/offline-pos-http-integration/*`, `tests/runner-safety/*`,
`docs/decisions/ADR-041-PROPOSED-offline-cashier-expansion.md`; retired/guarded runner edits; `package.json`
script repoint. No domain/migration/SDK/OpenAPI/commercial-policy code changed.

### 10.1 Full-HTTP-server-path harness (objective B)

`scripts/test-offline-pos-http-isolated.mjs` reuses the **same proven ownership boundary** (§9.2), then boots
the **real Next.js API** as a separate loopback process (127.0.0.1:`<free port>`) against the isolated
disposable Supabase, and drives it over HTTP through the **packed SDK** (`createCommerceClient` — the same
adapter the POS main process uses). No route handler is called in-process. Auth uses the server's standard
`CLERK_JWT_KEY` env path with a per-run test RSA key (identical to the proven returns runner) — a normal
configuration value, **not** a verifier override or production bypass; production sets `CLERK_JWT_KEY` to the
real Clerk key. Isolation/cleanup verified again: run project removed, two prior `rt-*` left untouched,
shared dev project still Up with unchanged uptime (not restarted).

| #   | Case (full HTTP path)                        | Expected                                                                                                            | Observed                                                                               | Verdict                  |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| B1  | Commit then **response lost** over the wire  | real request commits; client sees network error; retry of exact command replays once; changed intent same key → 409 | order count +1 after dropped response; retry `synced`, count unchanged; conflict → 409 | **PASS**                 |
| B2  | Concurrent 2nd device on same stock location | grant lock refuses the 2nd active device                                                                            | 2nd `createOfflineBootstrap` → **409**                                                 | **PASS**                 |
| B5  | Unsupported schema/contract version          | fail-closed, no writes                                                                                              | HTTP 4xx, order count unchanged                                                        | **PASS**                 |
| B3  | Installment sale + balance-reducing paydown  | sale `synced`, deposit captured, paydown reduces balance                                                            | sale ingest → **HTTP 500 INTERNAL_ERROR** (installment branch)                         | **FAIL (defect found)**  |
| B4  | Non-cash (card) offline tender               | recorded as a card capture (attested)                                                                               | persisted as **cash** capture; `tenders[]` did not take effect                         | **FAIL (anomaly found)** |

Evidence: `tests/offline-pos-http-integration/offline-pos-http.integration.test.ts` (3 passed, 2 skipped with
the FAIL reasons recorded inline). Marquee case B1 (real over-the-wire commit-then-lost-response with
exactly-once) is proven on the running server — the headline NOT-RUN item from §9.3 (#15) is now PASS.

**Defects found (not fixed — would change commercial code; owner/domain review required):**

- **D-1 installment happy path 500:** `offline_pos_private.record_offline_sale` installment branch throws over
  the real path (never exercised before 6B). Fix + regression test under the normal bug process.
- **D-2 non-cash tender recorded as cash:** the signed `tenders[]` does not reach/drive offline ingestion, so
  a card tender is stored as cash. See ADR-041 Decision B (partly a bug fix). Until fixed, offline non-cash
  tender attribution is wrong.

Still NOT RUN over the real server (need deeper harness or the above fixes first): installment/paydown happy
path (blocked by D-1); non-cash correctness (blocked by D-2); app-upgrade local migration; packaged
corruption-vs-real-API. In-process + disposable-DB coverage for everything else remains as §9.3.

### 10.2 Unsafe runner hardening — fail closed (objective C)

Audited **all** scripts, `package.json`, and `.github/workflows/ci.yml`. ~19 runners shared the destructive
pattern (hardcoded shared project + `db reset` + `stop --no-backup`, no `--workdir`). Fixes:

- New guard `scripts/supabase-isolation-guard.mjs`: `assertSharedSupabaseNotLive()` aborts any destructive
  runner when a shared dev Supabase stack is **live locally** (the Phase 2M data-loss condition), with an
  explicit `SUPABASE_ALLOW_SHARED_RESET=1` opt-in; CI (clean machine, no pre-existing stack) is unaffected.
  Plus `assertIsolatedSupabaseArgs()` (static arg guard: destructive commands require an isolated `--workdir`,
  reject `--project-id clothing-commerce-api`).
- **Retired** `scripts/test-offline-pos-integration.mjs` + `test-offline-pos-rls.mjs` → fail-closed stubs that
  throw and redirect to the isolated runners.
- **Guarded** `test-pos-sale-integration.mjs`, `test-rls.mjs`, `test-catalog-rls.mjs`, and the other 15
  destructive `*-rls` / `*-integration` / dev-fixture runners (one-line guard at import time).
- **Repointed** `package.json`: `test:pos:offline:integration` → `test-offline-pos-isolated.mjs --skip-rls`;
  `test:pos:offline:rls` → `test-offline-pos-isolated.mjs --rls-only`; added `test:pos:offline:http`. CI uses
  these scripts, so CI now runs the isolated runners (which also work on a clean machine).
- **Guard tests** `tests/runner-safety/supabase-isolation-guard.test.ts` (10 passed, mocked docker/arg
  inspection — never touch the DB): abort when shared live; pass on clean machine; honor opt-in without
  querying docker; reject no-workdir / repo-root workdir / shared `--project-id`; allow disposable workdir.
- **Live proof:** with the shared dev stack running, `node scripts/test-rls.mjs` now **aborts** with the guard
  error before any Supabase/Docker command (and the repointed `pnpm test:pos:offline:rls` ran the isolated
  RLS 10/10). The retired stubs throw on direct invocation.

**Remaining (documented):** the ~15 bulk-guarded runners are fail-closed but not yet _isolated_ (they still
rely on a clean machine in CI). Migration path = retrofit each onto `returns-test-resources.mjs` like the
offline runners; tracked as follow-up, not done here to avoid broad CI churn.

### 10.3 §9.5 offline-need classification for the cashier goal (objective D)

Goal: the **cashier** workflow proceeds _mainly offline_ after commissioning (not every back-office mutation).
Each workflow classified: **CORE** (must be offline for a sale to continue) · **SHIFT** (cashier op, offline if
safe) · **BACK-OFFICE** (online-only acceptable) · **SERVER-COORD** (needs global coordination unless a bounded
contract is approved) · **OWNER** (needs an explicit decision).

| Workflow                                 | Current status                                         | Class                    | Offline recommended?                                  | Prerequisite / owner choice                                   |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- |
| Catalog/price/barcode lookup             | Cached RO (proven)                                     | CORE                     | Already offline                                       | —                                                             |
| Cart build / authorized pricing          | Offline (proven)                                       | CORE                     | Already offline                                       | —                                                             |
| Cash sale + cash tender                  | E2E proven (HTTP B1)                                   | CORE                     | Already offline                                       | —                                                             |
| Non-cash tender (card/instapay/wallet)   | **Anomaly (D-2): stored as cash**                      | CORE                     | **Yes — fix to preserve method**                      | ADR-041 **B**; payment capture/settlement (no gateway)        |
| Customer capture/match                   | Cached RO + queued                                     | CORE                     | Already offline (capture travels w/ sale)             | happy-path ingest assert                                      |
| Installment sale                         | **Defect (D-1): 500 on HTTP**                          | SHIFT                    | Yes — **fix the 500** (already intended offline)      | bug fix + regression (not a contract change)                  |
| Customer payment (paydown)               | Verify+reject proven; happy path blocked by D-1        | SHIFT                    | Yes                                                   | unblock via D-1                                               |
| Returns / refunds / exchange             | Blocked (fail-closed)                                  | SHIFT                    | Owner decision                                        | ADR-041 **A** (signed offline-return grant); refund authority |
| Promotions / vouchers                    | Not implemented **and** architecture-prohibited (§9.4) | OWNER                    | Default **no**                                        | ADR-041 **D**; discount-money decision                        |
| Attendance clock-in/out                  | Online-only                                            | SHIFT                    | If offline shifts needed                              | ADR-041 **C**; attendance attribution                         |
| Reports / activity                       | Local pending-sync summary; server reporting online    | SHIFT/BACK-OFFICE        | Partial (local X/Z summary ok; full reporting online) | —                                                             |
| Inventory receive/adjust/transfer/issue  | Online-only                                            | SERVER-COORD/BACK-OFFICE | **No** (global ledger authority, ADR-017/023)         | —                                                             |
| Suppliers / purchases / dues / payments  | Online-only                                            | BACK-OFFICE              | No                                                    | —                                                             |
| Operational settings / device governance | Online-only                                            | BACK-OFFICE (security)   | No (rotation/revoke need online authority)            | —                                                             |
| Payroll                                  | Online-only                                            | BACK-OFFICE              | No (derived server-side)                              | —                                                             |
| Multi-device same-location               | Lock → 409 (proven B2)                                 | SERVER-COORD             | By-design single active device                        | stock-allocation tolerance (owner)                            |

**Proposed ADR:** [`ADR-041-PROPOSED-offline-cashier-expansion.md`](../../clothing-commerce-api/docs/decisions/ADR-041-PROPOSED-offline-cashier-expansion.md)
— grouped, **PROPOSED — NOT APPROVED**: (A) offline return authority, (B) offline non-cash tender settlement,
(C) offline attendance capture, (D) bounded promotion grant. Nothing in it is implemented or approved.

**Promotions conclusion (unchanged, re-verified §9.4):** offline promotions are **not implemented AND
prohibited by the current V1 pricing architecture** (ADR-026/037 + no contract/UI path). This is a V1
engineering rule, **not** a dedicated "never" ADR — so it is not "permanently prohibited"; changing it
requires ADR-041 Decision D with owner approval.

### 10.4 Phase 6B closeout

PASS (full HTTP server + disposable DB): B1 commit-then-lost-response exactly-once, B2 concurrent-device lock,
B5 schema-version fail-closed. FAIL/defect (full HTTP): B3 installment 500 (D-1), B4 non-cash→cash (D-2).
Runners hardened + guard-tested. §9.5 reviewed; ADR-041 proposed. **Phase 6 is NOT complete and the platform
is NOT launch-ready:** two defects (D-1, D-2) block core cashier tender/credit paths, and several cases remain
NOT RUN. **Next safe action:** fix D-1 and D-2 (bug process, with isolated real-API regression tests via the
new HTTP harness), then run the still-NOT-RUN cases; separately, decide ADR-041 A/C/D.

---

## 11. Phase 6C — true per-run isolation, D-1/D-2 fixes, multi-device acceptance (2026-11-08)

Scope: (A) mandatory per-run isolation for **every** destructive runner (not just a "is the shared stack
running" check); (B) reproduce + fix D-1/D-2 through the **real HTTP server**; (C) real **multi-device**
offline stock-allocation/contention/recovery over HTTP. Scoped acceptance only — **not** a whole-product
launch-readiness claim.

### 11.0 Per-repo state at execution

| Repo                           | Branch                            | HEAD      | Worktree (uncommitted)                                                                                                                                                                                       |
| ------------------------------ | --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clothing-commerce-api          | `feat/pos-pin-provider`           | `87aedad` | `M .github/workflows/ci.yml, package.json, scripts/returns-test-resources.mjs, src/pos/supabase-offline-pos-repository.ts, 18 runner stubs`; `?? supabase-isolation-guard.mjs(+.d.mts), returns-test-resources.d.mts, test-offline-pos-{isolated,http-isolated}.mjs, migration 20261108120000, tests/{runner-safety,offline-pos-http-integration,offline-pos-multidevice}/`. Nothing committed/pushed. |
| clothing-commerce-pos          | `feat/pos-pin-login`              | `3bbb6fe` | `M vite.config.mts`; `?? docs/offline-first-roadmap.md` (this doc), `pos-login.png`, `scripts/{capture-window.ps1,preview-storefront.mjs}`. No code change this phase; only this roadmap edited.             |
| clothing-commerce-storefront   | `main`                            | `f4955ca` | unchanged (not touched this phase).                                                                                                                                                                          |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `c955019` | unchanged (not touched this phase).                                                                                                                                                                          |

No branch switch / reset / stash / commit / push / deploy. All pre-existing user changes preserved. All API
changes are test-infra + the D-1 migration + the D-2 response-mapping fix; **no commercial policy changed**.

### 11.1 Objective A — true per-run isolation (DONE)

**Audit (every script + package.json + CI).** The ONLY shared-database collision hazard is the family of
runners that drive the **Supabase CLI** against the repo `config.toml` with no `--workdir` (resolves the
shared project `clothing-commerce-api`, ends with `stop --no-backup`). Everything else is already per-run
isolated and was left as-is:

- **Already isolated — disposable postgres container per run** (`clothing-commerce-<domain>-<pid>`, internal
  TCP, no published port, finally-scoped `docker rm`): all `test:*:persistence` and `test:*:concurrency`.
- **Already isolated — `rt-<hex>` Supabase via `returns-test-resources.mjs`**: `test:returns:*`,
  `test:suppliers:*`, `test:staff:*`, and the offline isolated runners.
- **Hazardous (shared-CLI) → FAIL-CLOSED + de-advertised** (18 runners): `test:rls`, every `*:rls`, every
  `*:integration`, `authorization:integration`, `pos:sale:integration`, `catalog:management:integration`,
  `api:integration`, `inventory:write:integration`, `dev:provisioning`, `dev:commerce-fixture`. Each file is
  now a stub calling `failClosedLegacyRunner()` (throws before any CLI/Docker call) and is removed from
  `test:all` and CI. (`test-offline-pos-integration.mjs` / `-rls.mjs` were already retired in 6B.)

**New guard** `scripts/supabase-isolation-guard.mjs` (replaces the 6B conditional guard; **the
`SUPABASE_ALLOW_SHARED_RESET` bypass is removed** — no env flag can enable a shared reset):

- `failClosedLegacyRunner()` — unconditional hard stop, no docker probe, no env opt-in, no shared fallback.
- `assertIsolatedSupabaseArgs()` — the isolated runners self-apply this: a destructive subcommand must carry
  a disposable `--workdir` and may never name the shared `--project-id`.
- `assertNotSharedProject()` — the run's id must match `rt-<32hex>`, never the shared/default project.
- `assertLoopbackDbHost()` — DB/API host must be loopback before any migration/fixture/test write.
- `sanitizedChildEnv()` — strips inherited `SUPABASE_*`/`POSTGRES_*`/`PG*`/`POS_TEST_*`/`DATABASE_URL`/
  `DB_URL`/`SUPABASE_DB_URL`/`DIRECT_URL`/`SUPABASE_ALLOW_SHARED_RESET` from every spawned API/vitest child,
  then re-adds only the disposable values — so a stray `.env` or exported var cannot redirect a child to a
  shared DB.

The two active isolated runners now call `assertNotSharedProject` + `assertLoopbackDbHost` + route every CLI
call through `assertIsolatedSupabaseArgs` + spawn children with `sanitizedChildEnv`.

**Guard tests** `tests/runner-safety/supabase-isolation-guard.test.ts` — **21 passed** (DB-free; injected
fake docker / filesystem-only minting). Matrix: fail-closed always throws even with the legacy env var set;
shared/default/non-`rt` project ids rejected; non-loopback DB host rejected; destructive args without
`--workdir`, with repo-root `--workdir`, or naming the shared `--project-id` rejected; env sanitation strips
every redirector and applies overrides last; **positive** disposable run mints a private marker + scoped
labels and cleans only its own workdir; **two concurrent runs** have disjoint project ids, workdirs, labels
and cleanup label-scopes. `bindConfig` fail-closed proven (rejects a config whose `project_id` is the shared
project).

**Runtime isolation proof (live):** three separate live isolated runs this phase (HTTP ×2, in-process ×1,
multi-device ×1) each created and removed **only** their own `rt-<hex>` project; after every run
`docker ps -a` showed the shared `clothing-commerce-api` stack still **Up** (12 containers, never restarted)
and the two unrelated historical `rt-*` projects **untouched**. `pnpm test` (API, DB-free) = **405 passed**;
`lint` / `format:check` / `typecheck` clean.

### 11.2 Objective B — D-1 and D-2 fixed and proven over the real HTTP path (DONE)

Reproduced + verified through `scripts/test-offline-pos-http-isolated.mjs`: a **real Next.js server** on
loopback, driven over HTTP via the **packed SDK**, against an isolated `rt-<hex>` Supabase. Stored values are
re-read directly from the DB via the service-role admin client (not trusted from the HTTP response).

**D-1 — offline installment sale returned HTTP 500.**

- _Root cause (exact SQL):_ `SQLSTATE 23514 "reservation unavailable at requested location"` raised by
  `online_private.consume_reservations` inside `fulfillments_private.record_fulfillment`. That function
  treats any order with a **non-null `customer_id`** as an ONLINE order that must have a matching active
  `stock_reservations` row. The **connected** installment path (`pos_sales_private.record_sale`) attaches the
  customer **after** `record_fulfillment`, so at fulfillment time `customer_id` is still NULL and
  `consume_reservations` early-returns. The **offline** `record_offline_sale` installment branch attached the
  customer (and recorded the debt) **before** fulfillment, so fulfillment saw a `customer_id`, treated the
  POS order as online, and demanded a reservation a POS sale never creates → 500.
- _Fix (smallest, owning layer):_ forward-only migration
  `20261108120000_fix_offline_installment_fulfillment_order.sql` redefines `record_offline_sale` to move the
  installment **customer attach + debt** to **after** the fulfillment block, mirroring the proven connected
  ordering. Deposit capture still happens before fulfillment; the attach/debt still run unconditionally in
  the same transaction (so a `needs_reconciliation` installment still records the debt). `consume_reservations`
  and all online reservation logic are untouched. No pricing/credit-cap/idempotency/snapshot/atomicity change.
- _Regression evidence (DB-verified over HTTP):_ installment synced; deposit captured (`payment.method=cash`,
  `amountMinor=deposit`); `customer_sale_debts` row = {total, initial_paid=deposit}; **exact replay**
  idempotent (same ingestionId, no second debt); **paydown** of 500 reduces outstanding 1500→1000; replay of
  the paydown idempotent; **unknown-customer** installment rejected fail-closed with no write.

**D-2 — offline card tender persisted/reported as cash.**

- _Root cause:_ not the DB — `record_offline_sale`'s `capture_payments` branch already stores the correct
  `card` payment. The defect is in the **response mapping** `src/pos/supabase-offline-pos-repository.ts`,
  which **hard-coded** `method:"cash"` and returned only the single primary payment (never the `payments`
  array the response schema already supports). So a correctly-stored card capture was reported as cash.
- _Fix (narrowest layer):_ read **all** captured tenders for the order (ordered by `tender_sequence`), map
  each with its **real** method/amount/cash fields, set `payment` to the primary (cash-or-first) and populate
  `payments`. The response schema re-validates `method`, so an unexpected value fails closed rather than
  masquerading. Malformed/inconsistent tenders still fail closed upstream (the signed `tenders[]` is covered
  by the Ed25519 signature; tampering → signature rejection; a non-summing list → rejection) — never a silent
  cash fallback.
- _Regression matrix (DB-verified over HTTP):_ **cash-only**; **card-only** (DB: one `card` payment,
  amount=total, cash_received=total, change=0 — an exact cashier-attested capture, **not** a gateway
  settlement); **cash+card split** (DB: two tenders summing to total, each real method); **tender list not
  summing to total** → 4xx, no write (fail-closed); plus the cash-change and duplicate/altered-intent cases
  from §11.3. "recorded" ≠ "settled": no offline gateway capture is implied.

**Full HTTP suite result:** `tests/offline-pos-http-integration` = **8 passed** on a fresh disposable DB
(the migration applies from scratch). The in-process isolated suite (RLS pgTAP + integration) = **10 passed**
— no regression from the migration.

### 11.3 Objective C — multi-device offline acceptance (DONE, server-authoritative)

`tests/offline-pos-multidevice` via `scripts/test-offline-pos-http-isolated.mjs --dir ...` — two DISTINCT
enrolled device identities (separate Ed25519 keys) bound to the SAME inventory location, over real HTTP on a
fresh isolated DB. **4 passed.** The current ADR/contract is **one active offline device per inventory
location** (`issue_grant` per-location advisory xact lock → `OL409`); the test verifies that invariant, it
does not assume simultaneous same-location offline sales.

1. **Concurrent same-location bootstrap race** — both devices' `createOfflineBootstrap` fired concurrently →
   **exactly one 200 grant + one 409** lock denial. (DB advisory-lock contention, deterministic winner.)
2. **Sequential retry by the loser** while the winner holds the lease → **409**.
3. **Denied device cannot craft an acceptable sale (no bypass)** — loser's own-device command referencing the
   winner's grant → grant-binding reject; loser impersonating the winner's `deviceId` but signing with its
   own key/credential → signature reject; fabricated grant id → grant-not-found. **No order created** by any.
4. **Authorized offline sale + cross-channel stock contention → reconciliation + exactly-once recovery** —
   the winner durably holds a stable signed command; an authorized connected RPC depletes the location's
   stock; the queued command is sized to exceed what remains. Ingest → **`needs_reconciliation`
   (`insufficient_stock_at_ingestion`)**, no fulfillment, order+payment recorded, **on-hand unchanged (no
   oversell, no negative inventory)**. Replaying the identical signed command (lost-response / restart) is
   **idempotent** (same ingestionId, no duplicate order); a changed-intent command reusing the idempotency
   key → **409**.

**Honest scope note.** Objective C proves the **server-authoritative** multi-device contract over real
HTTP+DB with two device identities. The two-**physical**-POS-SQLite-store crash/restart recovery is covered
by the existing single-device packaged-Electron acceptance (`acceptance:offline-ack` / `sale-recovery` /
`persistence`, §7/§9.3 #12–14) **composed with** the server idempotency/exactly-once proven here — it was
**not** re-run as a new dual-Electron harness (NOT RUN; documented limitation, not a logic gap).
**Independent-locations** scoping is structurally supported (per-location lock + per-location grant) but was
**not separately exercised** — the test fixture places both registers on one location; adding a second
location fixture is the follow-up to assert cross-location grant independence.

### 11.4 Runner inventory (final)

| Runner group                                                                                                               | Status                                  | Isolation mechanism                                   | Proof                                 |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| `test:pos:offline:integration` / `:rls` (→ `test-offline-pos-isolated.mjs`)                                                | ISOLATED                                | `rt-<hex>` Supabase, `--workdir`-pinned, env-sanitized | live run, 10 passed; guard tests      |
| `test:pos:offline:http`, `test:pos:offline:multidevice` (→ `test-offline-pos-http-isolated.mjs`)                           | ISOLATED                                | same + real Next server on loopback                   | live runs, 8 + 4 passed               |
| `test:returns:*`, `test:suppliers:*`, `test:staff:*`                                                                       | ISOLATED (pre-existing)                 | `returns-test-resources.mjs` `rt-<hex>`               | unchanged; boundary hardened          |
| all `test:*:persistence`, `test:*:concurrency`, `test:catalog:management`, `test:management:persistence`                   | ISOLATED (pre-existing)                 | own disposable `postgres:<pid>` container             | unchanged                             |
| `test:rls`, every `*:rls`, every `*:integration`, `authorization:integration`, `pos:sale:integration`, `dev:*`, `api:integration`, `inventory:write:integration`, `catalog:management:integration` (18) | **DISABLED / FAIL-CLOSED**              | `failClosedLegacyRunner()` throws pre-exec             | live: `node scripts/test-rls.mjs` → aborts, exit 1; guard tests |

Two-run concurrency: exercised at the **unit** level (guard test: disjoint ids/workdirs/labels/scopes) and at
the **runtime** level by multiple live isolated runs that each cleaned only their own resources while the
shared stack and historical `rt-*` were untouched (not a single simultaneous two-stack boot, to bound Docker
load with three pre-existing projects on the host).

### 11.5 PASS / FAIL / NOT RUN matrix (this phase)

| #   | Case                                                                          | Layer                                   | Verdict     |
| --- | ----------------------------------------------------------------------------- | --------------------------------------- | ----------- |
| A1  | Guard matrix (fail-closed, project/host/args/env, positive, two-run disjoint) | unit (DB-free)                          | **PASS** (21) |
| A2  | Live isolated runs clean only their own resources; shared + `rt-*` untouched  | runtime (docker inspect)                | **PASS**    |
| A3  | Disabled runner aborts before any destructive command                         | runtime                                 | **PASS**    |
| B-D1a | Installment sale synced; deposit captured; debt row correct                  | full HTTP + disposable DB               | **PASS**    |
| B-D1b | Installment exact replay idempotent (no second debt)                         | full HTTP + disposable DB               | **PASS**    |
| B-D1c | Paydown reduces balance; paydown replay idempotent                           | full HTTP + disposable DB               | **PASS**    |
| B-D1d | Unknown-customer installment fails closed, no write                          | full HTTP + disposable DB               | **PASS**    |
| B-D2a | Card-only tender stored+reported as card (DB-verified)                       | full HTTP + disposable DB               | **PASS**    |
| B-D2b | Cash+card split preserves both legs (DB-verified)                            | full HTTP + disposable DB               | **PASS**    |
| B-D2c | Tender list not summing to total fails closed, no write                      | full HTTP + disposable DB               | **PASS**    |
| B0  | Cash-only, commit-then-lost-response exactly-once, schema-version reject      | full HTTP + disposable DB               | **PASS**    |
| C1  | Concurrent same-location bootstrap → one grant, one 409                        | full HTTP + disposable DB               | **PASS**    |
| C2  | Loser retry refused (409)                                                      | full HTTP + disposable DB               | **PASS**    |
| C3  | Denied device cannot craft an acceptable sale (3 craft vectors)               | full HTTP + disposable DB               | **PASS**    |
| C4  | Cross-channel depletion → reconciliation, no oversell, exactly-once replay    | full HTTP + disposable DB               | **PASS**    |
| —   | Two-physical-SQLite-store dual-Electron multi-device crash/restart             | packaged POS (not re-run as dual harness) | **NOT RUN** |
| —   | Independent-locations grant/stock scoping (single-location fixture)           | —                                       | **NOT RUN** |
| —   | Non-cash gateway capture/settlement semantics                                 | —                                       | **N/A** (no provider; recorded ≠ settled) |

### 11.6 Remaining risks / owner decisions / next safe action

- **Disabled destructive coverage.** The 18 shared-CLI RLS/integration suites are fail-closed, so their
  domains lose destructive CI coverage until each is rebuilt on `returns-test-resources.mjs` (small per-runner
  edit; the offline runners are the template). Persistence/concurrency suites still exercise the same SQL on
  disposable containers, so this is reduced coverage, not zero. _Owner choice:_ prioritize which suites to
  re-isolate first.
- **Multi-device physical recovery + independent locations** remain NOT RUN (above) — the server contract is
  proven; the dual-Electron harness and a second-location fixture are the follow-ups.
- **ADR-041 A/C/D** (offline returns, attendance, bounded promo grant) remain PROPOSED/undecided; D-2's fix
  does **not** introduce gateway settlement (ADR-041 B remains a separate owner decision).
- **Next safe action:** re-isolate the highest-value disabled suite (e.g. `test:rls` / `orders`/`inventory`
  RLS) onto the proven boundary; add a second-location fixture to assert cross-location grant independence;
  then (separately) decide ADR-041 A/C/D. Do **not** run any disabled runner against the shared project.

**Not launch-ready.** This phase closes the test-isolation hazard and the two core cashier defects (D-1, D-2)
and proves the multi-device authorization + reconciliation contract over the real HTTP path, but NOT-RUN rows
remain and whole-product launch readiness is explicitly **not** claimed.

---

## 12. Phase 6D — restore the disabled RLS/integration suites on the isolated boundary (2026-11-08)

Closes the §11.6 "next safe action": the 18 shared-CLI RLS/integration runners that were left **fail-closed**
in Phase 6B/6C are now **rebuilt on the per-run-isolated boundary** instead of stubs. All API-repo work;
POS repo untouched this phase except this doc. Nothing committed/pushed; all prior uncommitted work preserved.

### 12.1 Reusable harness

New `clothing-commerce-api/scripts/isolated-supabase-suite.mjs` generalizes the proven
`test-offline-pos-isolated.mjs` template over `returns-test-resources.mjs`: mint a unique `rt-<32hex>`
project in a disposable workdir, copy migrations+tests, swap `project_id`+ports, `bindConfig` fail-closed,
`supabase start --workdir` (fresh migrations, **no reset of any DB**), `plan()` ownership check, apply
fixtures via `docker exec psql`, assert loopback+port, run pgTAP (`supabase test db`) and/or vitest with
`sanitizedChildEnv`, and label-scoped cleanup. Each runner is now a ~12-line declarative spec. Type decls
in `isolated-supabase-suite.d.mts`. RLS suites drop the API layer; integration suites keep Kong/PostgREST/
GoTrue. `[db.seed] enabled=false`, so a fresh `start` is equivalent to the old `db reset --no-seed`.

### 12.2 Per-suite result matrix (live, each on its own disposable `rt-<hex>`, then cleaned)

| Suite (script)                              | Backend                 | Assertions | Verdict      |
| ------------------------------------------- | ----------------------- | ---------- | ------------ |
| `test:rls` (tenant)                         | pgTAP / disposable PG   | 87         | **PASS**     |
| `test:catalog:rls`                          | pgTAP / disposable PG   | 43         | **PASS**     |
| `test:inventory:rls`                        | pgTAP / disposable PG   | 30         | **PASS**     |
| `test:inventory:operations:rls`             | pgTAP / disposable PG   | 11         | **PASS**     |
| `test:orders:rls`                           | pgTAP / disposable PG   | 12         | **PASS**     |
| `test:fulfillment:rls`                      | pgTAP / disposable PG   | 14         | **PASS**     |
| `test:online:rls` (online + shared 6-file set) | pgTAP / disposable PG | 206        | **PASS**     |
| `test:api:integration` (2F management)      | vitest + disposable API | 30         | **PASS**     |
| `test:authorization:integration` (1D)       | vitest + disposable API | 20         | **PASS**     |
| `test:fulfillment:integration` (2E)         | vitest + disposable API | 11         | **PASS**     |
| `test:inventory:operations:integration` (2C)| vitest + disposable API | 9          | **PASS**     |
| `test:inventory:write:integration` (2G)     | vitest + disposable API | 10         | **PASS**     |
| `test:orders:integration` (2D)              | vitest + disposable API | 14         | **PASS**     |
| `test:catalog:management:integration` (2J)  | vitest + disposable API | 10         | **PASS**     |
| `test:pos:sale:integration` (2H)            | vitest + disposable API | 21         | **PASS**     |
| `test:online:integration` (online-commerce) | real Next + disposable API | —       | **RESTORED-TO-RUN, FAILING** |
| `test:dev:provisioning`                     | —                       | —          | **DISABLED (fail-closed)** |
| `test:dev:commerce-fixture`                 | —                       | —          | **DISABLED (fail-closed)** |

**16 of 18 restored green (528 assertions).** DB-free: `tests/runner-safety` = **29 passed** (21 existing
guard + 8 new harness: plan-integrity, abort-before-Docker, exclude-set, empty-spec reject). `tsc`, `eslint`,
`prettier --check` clean.

### 12.3 The 3 not counted as green — exact residual coverage lost

- **`test:online:integration` (online-commerce)** — now boots the real Next.js server against an isolated
  `rt-<hex>` stack (env guard satisfied: `SUPABASE_URL`/`SERVICE_ROLE_KEY`/`ONLINE_TEST_*` all point at the
  disposable stack), but the suite **fails on a canonical fresh-migration DB**: catalog entity counts
  `[7,0,12,5,0,0]` vs expected `[1,1,1,1,1,1]`, and FK errors (`catalog_write_operations_tenant_fk`,
  reservation/inventory writes). Both `phase_2h_pos_sale` + `phase_2l_online` fixtures are required
  (`phase_2l` FK-depends on `phase_2h` — verified). The mismatch is a **pre-existing fixture/expectation
  drift**: the suite only ever ran against the drifted shared dev project, never a canonical migration set.
  _Lost coverage:_ online guest checkout / quote / reservation-consumption / snapshot-replay over real HTTP.
  _Fix (follow-up, not done here to avoid guessing at assertions):_ reconcile `tests/online-commerce-
  integration` fixtures/expectations to the canonical schema, then re-add to `test:all` + CI.
- **`test:dev:provisioning` / `test:dev:commerce-fixture`** — these spawn `scripts/provision-dev-identity.mjs`
  (and `provision-dev-commerce-fixture.mjs`), both **hardcoded** to the shared container
  `supabase_db_clothing-commerce-api`. Pointing vitest at an isolated DB does not redirect the spawned
  script, so it would (and in the diagnostic run did) apply the dev SQL to the **shared** project while the
  test asserted against the isolated DB. Left **fail-closed** rather than pretend-isolated. _Lost coverage:_
  dev-identity authorization-graph provisioning + deterministic commerce-fixture seeding/idempotency/rollback.
  _Fix (follow-up):_ parameterize those dev scripts (`COMMERCE_DEV_DB_CONTAINER` / `COMMERCE_DEV_API_URL`,
  keep the fail-closed locality guard) and forward them from the isolated runner.
  > Candid safety note: the diagnostic runs of these two suites executed the idempotent, non-destructive dev
  > provisioning/seed SQL against the **shared** container (the hardcoded path). Shared stack verified
  > **healthy** afterward (Up, not restarted); this is the intended dev-identity state. Now fail-closed, so
  > it cannot recur.

### 12.4 Isolation proof (runtime)

Every live run created and removed **only** its own `rt-<hex>` project. Across all runs this phase, after
each: `docker ps` showed the shared `clothing-commerce-api` stack still **Up** (4h uptime, never restarted)
and the two unrelated historical `rt-*` projects **untouched**; afterward only those two historical projects
remained. No `supabase stop`, no `db reset` of any existing DB, no broad prune. The `SUPABASE_ALLOW_SHARED_
RESET` bypass remains removed.

### 12.5 CI / package.json

`package.json`: 16 restored runners re-added to `test:all`; `__comment` updated; the 3 residual suites
documented + excluded. CI (`.github/workflows/ci.yml`): new dedicated `restored-isolated-suites` job
(timeout 120m) runs the 16 isolated RLS/integration suites in parallel with the fast-feedback jobs; the 3
residual suites are commented with their blockers. Each runner script name was unchanged, so the scripts now
resolve to the isolated implementations.

### 12.6 Exact file changes (API repo, `feat/pos-pin-provider`, uncommitted)

- New: `scripts/isolated-supabase-suite.mjs` (+ `.d.mts`), `tests/runner-safety/isolated-supabase-suite.test.ts`.
- Rewrote 16 stubs → isolated specs: `test-rls`, `test-catalog-rls`, `test-inventory-rls`,
  `test-inventory-operations-rls`, `test-orders-rls`, `test-fulfillment-rls`, `test-online-rls`,
  `test-api-integration`, `test-authorization-integration`, `test-fulfillment-integration`,
  `test-inventory-operations-integration`, `test-inventory-write-integration`, `test-orders-integration`,
  `test-catalog-management-integration`, `test-pos-sale-integration`, `test-online-commerce` (`.mjs`).
- Re-stubbed (fail-closed, documented): `test-dev-provisioning.mjs`, `test-dev-commerce-fixture.mjs`.
- `package.json`, `.github/workflows/ci.yml` updated. No domain/migration/SDK/OpenAPI/commercial-policy code
  changed. Prior-phase uncommitted work (D-1 migration, D-2 repository fix, guard, offline runners) preserved.

### 12.7 Resume point

**16/18 shared-CLI suites restored green on true per-run isolation; 2 dev-script suites disabled (hardcoded
shared container); online-commerce restored-to-run but failing on canonical schema (pre-existing drift).**
Next safe actions, in priority: (1) reconcile `online-commerce-integration` fixtures/expectations to the
canonical migration set; (2) parameterize the dev provisioning/fixture scripts for a disposable container and
re-isolate `test:dev:*`. Do **not** run any fail-closed runner against the shared project.

---

## 13. Phase 7 — fresh source re-audit & full-product scope correction (2026-11-11)

Re-verified every claim below against live source (not the 2026-11-08 summary), per the continuation
brief. Scope correction is the headline: prior phases silently narrowed "offline POS" to "offline
**cashier**". The product has **ten** workspace sections (`src/renderer/shell/sections.ts`); only the
cashier slice is offline. Whether the other nine must be offline is an **owner decision**, not an
engineering default — recorded in §13.4.

### 13.1 Verified repo state (live, 2026-11-11)

| Repo | Branch | HEAD | Real (non-whitespace) uncommitted changes |
| ---- | ------ | ---- | ----------------------------------------- |
| clothing-commerce-pos | `feat/pos-pin-login` | `3bbb6fe` | `M vite.config.mts`; `?? docs/offline-first-roadmap.md` (this file), `.npmrc`, `pos-login.png`, `scripts/{capture-window.ps1,preview-storefront.mjs}`. No offline code change since 6D. |
| clothing-commerce-api | `feat/pos-pin-provider` | `87aedad` | Real: `.github/workflows/ci.yml`, `package.json`, the 30+ isolation-rewritten `scripts/test-*.mjs`, `scripts/returns-test-resources.mjs`, `src/pos/supabase-offline-pos-repository.ts` (D-2). Untracked: ADR-041, `scripts/isolated-supabase-suite.mjs`+`.d.mts`, `scripts/supabase-isolation-guard.mjs`+`.d.mts`, `scripts/test-offline-pos-{isolated,http-isolated}.mjs`, migration `20261108120000` (D-1), `tests/{runner-safety,offline-pos-http-integration,offline-pos-multidevice}/`, `.npmrc`, seed-rich-*. |
| clothing-commerce-storefront | `main` | `f4955ca` | UI-only edits (home hero/sections); no shared-contract change. |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `c955019` | `?? .npmrc, sf-test.txt, work/`. |

All four on upstream tip (0/0 divergence). No branch/reset/stash/commit/push/deploy performed.

**Correction to prior phases:** every `supabase/migrations/*.sql` and `supabase/tests/*.sql` that shows
as `M` in `git status` is a **line-ending-only** flip (0 lines changed under `git diff --ignore-all-space`;
the Windows/exFAT working tree flipped CRLF). The foundational migrations are **not** content-modified.

**New discrepancy the prior roadmap never recorded:** the entire in-repo SDK workspace
`packages/sdk/*` (source, tests, tsconfig, two historical `.tgz`) is **deleted** in the API working tree
(≈4,033 real deletions). This is pre-existing uncommitted user state, **preserved untouched**. It does not
affect the offline-POS runtime (the POS consumes the vendored packed tarball), but it should be explained
or restored by the owner before any API commit. Flagged, not acted on.

### 13.2 D-1 / D-2 confirmed in source (not just prior claims)

- **D-1** (installment HTTP 500): migration `supabase/migrations/20261108120000_fix_offline_installment_fulfillment_order.sql`
  is present; its header documents the exact root cause (`consume_reservations` 23514 on a non-null
  `customer_id`) and the fix (relocate installment customer-attach + debt to **after** the fulfillment
  block, mirroring the connected path). Bug fix, not a policy change (ADR-041 agrees) → legitimately
  implementable without owner sign-off. **Real-API regression re-run this phase: see §13.5.**
- **D-2** (card tender stored/reported as cash): `src/pos/supabase-offline-pos-repository.ts` now reads
  **all** tenders for the order ordered by `tender_sequence`, maps each with its true `method`, and
  populates `payments[]` + a primary. The `method:"cash"` hard-code is gone. Confirmed in the diff.

### 13.3 Full ten-section offline matrix (verified from `preload.ts` + each desk's source)

Capability boundary fact: the durable `window.offline` bridge is consumed **only** by the cashier /
checkout path (`App.tsx`, `checkout/PayModal.tsx`, `auth/LocalLogin.tsx`, `settings/PosUsersManager.tsx`).
Every management desk imports the connected SDK / `posSession` and has **no** offline durability.

| Section (sidebar) | Action surface | Offline today | Evidence |
| ----------------- | -------------- | ------------- | -------- |
| **pos** (cashier) | cash sale, split/non-cash tender, installment, customer paydown, catalog/price/inventory/customer read, receipt, sync/ack, PIN gate | **OFFLINE (durable, queued, server-authoritative accept)** | `offline` bridge; `offline-service.ts`; `shared/offline.ts`; §7/§9/§11 |
| **orders** | view/search orders, re-open order | **CACHED READ-ONLY** (cached order re-opens offline; silent refresh fails; no offline mutation) | `orders/OrdersDesk.tsx:28,172` |
| **inventory** | receive / adjust / transfer / add product | **ONLINE-ONLY** (connected SDK; global ledger authority ADR-017/023) | `inventory/*`; 0 offline refs |
| **customers** (desk) | management list / history | **ONLINE-ONLY** (cashier customer *capture* travels with the offline sale; the management desk does not) | `customers/CustomersDesk.tsx`; 0 offline refs |
| **reports** | sales/activity reporting | **ONLINE-ONLY** (local pending-sync summary covers the cashier's operational need) | `reports/ReportsDesk.tsx`; 0 offline refs |
| **vouchers** | voucher/promotion management | **ONLINE-ONLY + architecturally blocked for offline *application*** (ADR-026/037) | `vouchers/VouchersDesk.tsx`; `promotions/quote.ts` resets offline |
| **suppliers** | purchases / dues / supplier payments | **ONLINE-ONLY** (back-office money) | `suppliers/SuppliersDesk.tsx`; 0 offline refs |
| **staff** | staff mgmt, attendance clock-in/out | **ONLINE-ONLY** (local POS-user PIN admin via `posAuth` works offline; server staff mgmt + attendance do not) | `staff/*`, `pos/AttendanceClock.tsx`; 0 offline refs |
| **activity** | operational activity log | **LOCAL (device-local ledger, works offline; not the server activity feed)** | `activity/*`; `main/activity/store.ts` |
| **settings** | device/operational settings, POS users | **MIXED:** POS-user PIN admin OFFLINE (`posAuth`); device governance / server settings ONLINE-ONLY | `settings/*`; `PosUsersManager.tsx` |
| (cross-cutting) **returns** | refund / exchange | **BLOCKED OFFLINE (fail-closed)** — `ReturnService` throws `CONNECTION_REQUIRED` at every stage; the local store is only connected-return crash recovery | `main/returns/service.ts:32-34` |

**So:** 1 of 10 sections is genuinely offline (the cashier). 2 are partial (activity local; settings' POS-user
admin). The remaining 7 are online-only or read-cached. "The POS works fully offline" is **not** true for the
full product; it **is** true for the core cashier *shift* if the owner confirms that is the goal.

### 13.4 OWNER DECISIONS REQUIRED (consolidated; nothing below is implemented or approved)

The decisive one is scope. ADR-041's "What is explicitly NOT proposed for offline" list was a prior-session
judgement, **not** an owner ruling. Each decision is reversible via feature flag; the safe default is
status-quo (online-only / fail-closed).

| # | Decision | Status | Safe recommendation | Blocks |
| - | -------- | ------ | ------------------- | ------ |
| **S** | **Scope**: is the goal "offline **cashier shift**" or "offline **whole POS** (incl. management desks)"? | OPEN (pivotal) | Offline cashier shift; keep global-authority desks online-only | Sizes the entire remaining program |
| **A** | Offline **returns/refunds** — ADR-041 A (signed server return grant; settlement withheld to attestation) | PROPOSED, not approved | Implement **only if** refunds-while-disconnected are required; reuse offline-sale grant machinery; never client-compute refund money | Returns desk offline |
| **B** | Offline **non-cash tender** semantics — ADR-041 B (preserve method, attested-not-settled) | Mapping bug (D-2) FIXED; the *product semantic* still owner-pending | Confirm "attested, not settled"; forbid any UI implying provider settlement until a gateway ADR | Correct tender mix; future gateway |
| **C** | Offline **attendance** clock-in/out — ADR-041 C (append-only signed clock events) | PROPOSED, not approved | Implement if offline shifts needed (low risk; no money/stock) | Attendance offline |
| **D** | Offline **promotions/vouchers** — ADR-041 D (bounded pre-authorized promo grant) | PROPOSED; default **no** | Keep fail-closed unless business explicitly wants offline discounts; then dedicated ADR | Offline discounts |
| **E** | Offline **inventory ops** (receive/adjust/transfer) | Not proposed | Keep online-only (global append-only ledger authority, ADR-017/023); only a preallocated-authority envelope + reconciliation could change this | Inventory desk offline |
| **F** | Offline **orders / customers / reports / suppliers management** | Not proposed | Keep online-only (read-cache is sufficient for a shift) | Those desks offline |
| **G** | Offline **grant lease length / revocation window** for the target tenant | Operational (ops, not code) | Tune server lease to the acceptable revocation-latency risk | Residual revocation-window exposure |

### 13.5 Tests actually run this phase

- **POS `pnpm test` (DB-free, real SQLite, real main-process service):** **200 passed / 4 skipped / 0 failed**
  (re-run 2026-11-11). Genuine evidence for the local durable offline-persistence path.
- **Environment hazard observed:** `docker ps` shows the **shared dev stack `supabase_*_clothing-commerce-api`
  LIVE** (11 containers) plus **two leftover historical `rt-*` isolated stacks** still running. No stock runner
  may be run (data-loss path). The host already carries three Supabase stacks.
- **Real-API isolated acceptance (D-1/D-2/multi-device over HTTP) — see §13.6 decision gate.**

### 13.6 Resume point / next safe action

No code was changed this phase (audit + scope correction + roadmap only). The two **implementable-without-
approval** items (D-1 migration, D-2 mapping) are already written by prior phases and confirmed in source;
their only open item is a fresh isolated real-API regression re-run. Everything else is **blocked on owner
decisions S + A/B/C/D** (§13.4). Next safe actions, in order: (1) get decision **S** (scope) — it determines
the whole program; (2) with go-ahead, run the isolated real-API HTTP harness (`test-offline-pos-http-isolated.mjs`)
to re-confirm D-1/D-2/multi-device on a disposable `rt-<hex>` stack (heavy: host already runs 3 stacks); (3)
implement only owner-approved decisions, each behind a feature flag with isolated real-API acceptance. Do
**not** run any fail-closed/stock runner against the shared project; do **not** touch the two historical
`rt-*` stacks.

---

## 14. Phase 8 — approved-scope design & plan (owner scope decided 2026-11-11)

Owner chose target scope **"cashier shift + attendance + returns"** (roadmap §13.4-S). That approves
ADR-041 **A (offline returns, Option 2)** and **C (offline attendance, Option 2)** in direction; confirms
**B** (non-cash = attested, not settled); keeps **D** (promotions) and the management-desk items
**E/F/G** out (online-only). Real-API test run was **deferred by the owner this session** → no server
code was written this session (writing untestable cross-repo contracts would violate the no-mocks-on-core-
path acceptance rule). This section is the design + dependency-ordered plan to implement next session.

### 14.1 Shared target offline contract (applies to both new workflows)

Reuse, do not fork: `main/offline/device-key.ts` (Ed25519 signing), `outbox-store.ts` + `sync-worker.ts`
(durable queue, idempotent replay, lease/retry), `offline_grants` machinery, `CLOCK_ROLLBACK_TOLERANCE_MS`,
`offline_sale_ingestions` idempotency pattern (`(tenant, syncCommandId)` + `command_fingerprint`), and the
`accepted_pending_sync / synced / needs_reconciliation` receipt lifecycle. No parallel local ledger; server
stays the global authority; renderer never gets keys/sql/signatures (locked by `boundaries.test.ts`).

### 14.2 Offline attendance (Decision C) — implement FIRST (smaller, append-only, no money/stock)

- **API:** new migration `offline_pos_private.record_offline_attendance(tenant, credential, command,
  canonical, fingerprint, signature)`; idempotent by `syncCommandId`; validate device credential +
  grant binding + schema version + `acceptedAt` skew window; **append-only** insert into the same
  attendance table the connected clock writes; return ingestion id. No reconciliation branch needed
  (append-only cannot oversell). RLS: same `offline_pos_writer` tenant-isolation pattern; add to the RLS
  pgTAP suite.
- **SDK/OpenAPI:** add `recordOfflineAttendance` through the documented provenance workflow (bump SDK,
  repack, re-vendor to POS, update `boundaries.test.ts` SHA).
- **POS main:** new `offline` bridge channel `offline:record-attendance-event`; shared type
  `OfflineAttendanceEventInput { kind: "clock_in" | "clock_out" }` (timestamp = device clock, bounded;
  operator = authenticated offline-PIN roster operator — **sub-decision C-i, recommended**). Sign canonical
  command, write outbox row in one SQLite txn before any network.
- **POS UI:** `pos/AttendanceClock.tsx` gains an offline path (today online-only); shows "queued — will
  sync" state; never claims server confirmation offline.
- **Acceptance (isolated real-API, next session):** signed clock event replay exactly once; skew rejection;
  RLS; crash-before-send recovery via packaged Electron.

### 14.3 Offline returns (Decision A) — implement SECOND (grant + ingestion + withheld settlement)

- **API — grant:** new migration `offline_return_grants` table + `issue_return_grant` RPC (mirror
  `issue_grant`): device/register/location-bound; carries, per original order line, **server-computed**
  remaining-eligible quantity and a **max refundable amount** (net basis incl. promotions); short validity;
  immutable linkage to the original order. Client may only choose quantities within the grant.
- **API — ingestion:** `record_offline_return` RPC: idempotent by `syncCommandId`+`fingerprint`; revalidate
  binding/schema/skew/credential-at-acceptance; **recompute eligibility server-side**; create Return +
  refund with **`refund.status = pending` (never settled offline)**; eligibility drift from concurrent
  returns elsewhere → `needs_reconciliation` + withhold settlement (exactly like `insufficient_stock`).
  **Never client-computed refund money.**
- **Settlement:** unchanged connected `settleRefund` attestation path, only after sync, against the
  canonical server amount (the existing `ReturnService.settle` already withholds and never double-hands-back
  cash — reuse it for the attestation step).
- **SDK/OpenAPI:** add `issueReturnGrant` + `recordOfflineReturn`; repack/re-vendor as above.
- **POS main:** durable offline-return flow reusing the outbox (new signed command type); provisional/queued
  states; keep the existing online `ReturnService` for connected returns.
- **POS UI:** `returns/ReturnDesk.tsx` offline path offers only grant-pre-authorized lines/amounts; receipt
  shows "refund pending — settle on reconnect"; no settled claim offline.
- **Acceptance (isolated real-API, next session):** grant issuance binding; signed return replay exactly
  once; eligibility drift → reconciliation; settlement only after attestation; RLS; crash recovery.
- **Open owner sub-decisions before merge:** A-i refund budget / max amount; A-ii grant window; A-iii
  refund-only vs exchange in first cut (recommend refund-only first).

### 14.4 Non-cash tender (Decision B, confirmed) — verification only

D-2 mapping fix is in source. Remaining: confirm `checkout/PayModal.tsx` copy never implies provider
settlement for card/instapay/wallet (label "recorded — attested, not settled") and add an isolated real-API
assertion that a card offline tender persists `method=card`, status captured, no gateway claim. Small.

### 14.5 Dependency order & feature flags

1. (gate) Re-run isolated real-API regression for D-1/D-2/multi-device to confirm baseline (needs test
   go-ahead; deferred this session).
2. Attendance offline (§14.2) behind flag `offline_attendance` — full vertical slice + isolated acceptance.
3. Returns offline (§14.3) behind flag `offline_returns` — full vertical slice + isolated acceptance.
4. Non-cash labeling verification (§14.4).

Each lands only with isolated real-API acceptance (no mocks on the core path). With a flag off, behaviour is
exactly today's fail-closed/online-only.

### 14.6 Test status this session (honest)

- **RUN:** POS `pnpm test` DB-free = **200 passed / 4 skipped** (real SQLite, 2026-11-11).
- **NOT RUN (owner-deferred):** real-API isolated HTTP acceptance (D-1/D-2/multi-device re-confirm;
  attendance/returns acceptance do not exist yet). Reason: owner chose not to launch a 4th Supabase stack
  this session (shared dev stack + 2 historical `rt-*` already live). No substitute mock was used or implied.

---

## 15. Phase 9 — owner widens scope to ALL desks + authorizes disposable test DBs (2026-11-11 continuation)

**Owner directive (this session), superseding §14-scope and §13.4 decisions D/E/F + device governance:**
target scope is now **every in-scope POS desk and feature**, not just cashier shift + attendance + returns.
Inventory, suppliers, promotions/vouchers, reports, settings, payroll/staff management, device governance,
orders operations and every other desk are **reopened as in-scope for an offline path** (durable local
record + defined sync/reconciliation), unless the owner later rules a specific action out. The owner **also
authorizes fresh, uniquely isolated disposable API/database resources** for acceptance testing (removes the
§14/§13.6 test-deferral blocker). "Offline" keeps its meaning from the top of this doc: durable local record
+ exact accept/reject/reconcile on reconnect, server remains sole global authority; no fabricated business
rules; nothing material enabled before its policy is explicit.

### 15.1 Live state re-verified this session (not from prior summaries)

| Repo | Branch | HEAD | Status (verified `git status`) |
| ---- | ------ | ---- | ------------------------------ |
| clothing-commerce-api | `feat/pos-pin-provider` | `87aedad` | `M` ci.yml, next-env.d.ts, package.json, 30+ `scripts/test-*.mjs`, `src/pos/supabase-offline-pos-repository.ts`, 4 foundational migrations (**line-ending-only**, §13.1); **`D packages/sdk/*` — entire SDK source package still deleted on disk (`packages/sdk/` is empty)**; untracked isolation harnesses + migration `20261108120000`. |
| clothing-commerce-pos | `feat/pos-pin-login` | `3bbb6fe` | `M vite.config.mts`; `?? docs/offline-first-roadmap.md` (this file), `.npmrc`, `pos-login.png`, `scripts/{capture-window.ps1,preview-storefront.mjs}`. |
| clothing-commerce-storefront | `main` | `f4955ca` | UI-only edits; no shared-contract change. |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `c955019` | `?? .npmrc, sf-test.txt, work/`. |

No branch/reset/stash/commit/push/deploy performed. Toolchain verified usable: Node v24.16.0, pnpm 10.33.1,
Supabase CLI present, Docker 27.3.1; both API and POS `node_modules` present.

### 15.2 HARD BLOCKER — SDK source was deleted → **RESOLVED 2026-11-11** (owner-approved restore)

> **Update (this session):** owner approved restoring the SDK source. Done:
> `git restore -- packages/sdk` in the API repo (unstaged deletions reverted; working tree now matches the
> committed `packages/sdk/*`). `pnpm sdk:build` then failed only in the cosmetic post-build
> `packages/sdk/scripts/strip-bundle-banners.mjs`, which used `new URL(...).pathname` and left `%20` in the
> spaced workspace path (`G:\Business Business\…`). **Fixed** that script to use `fileURLToPath`. `pnpm
> sdk:build` is now **green** (ESM+CJS+DTS). The SDK contract spine + pack pipeline are functional again, so
> every new offline desk is unblocked. (Not committed/pushed. The two restored historical `.tgz` under
> `packages/sdk/` are the committed ones.) The rest of 15.2 below is the original blocker analysis, retained.

#### Original blocker analysis (SDK source was deleted)

The SDK is the contract spine. By design, each offline command's **canonicalization + signing payload shape
lives in `@shifted/clothing-commerce-sdk`** (POS `offline-service.ts` / `sync-worker.ts` call
`canonicalizeOffline*Command` and the `ingestOffline*` client methods via `createRequire`; the API verifies
the *same* canonical bytes). Adding any new offline desk (attendance, returns, inventory, etc.) therefore
requires: new command type + `canonicalizeOffline<X>Command` + `ingestOffline<X>` client method in the SDK →
`pnpm openapi:generate && pnpm sdk:pack` → re-vendor the new `.tgz` into POS → bump `boundaries.test.ts` SHA.

**`packages/sdk/` is empty on disk** (the owner's preserved uncommitted deletion, §13.1). `pnpm sdk:build` /
`sdk:pack` / `openapi:generate` **cannot run**. Consequence: **no new offline contract can be built or
tested end-to-end this session without restoring the SDK source**, which operating rules forbid me to do
unilaterally ("preserve the SDK deletions … unless the owner explicitly asks to restore them"). The existing
offline cashier runtime is unaffected (POS consumes the already-packed `vendor/…-0.26.0.tgz`).

→ **This is the #1 owner decision below.** Until it is resolved, only SDK-free work can proceed (renderer
offline-honesty UX; local-only report/activity views sourced from existing `window.offline` IPC; decision
records; test-harness scaffolding). All server-contract desks are blocked on it.

### 15.3 All-desks requirement matrix (target vs. current; gating decision per action)

Status legend as §2. "Gate" = what must be true before it can be built/enabled. Every server-contract row is
additionally gated by **15.2 (SDK)**.

| Desk / action | Current | Target offline behavior | Authority / data needed offline | Gate (owner policy / ADR) |
| ------------- | ------- | ----------------------- | ------------------------------- | ------------------------- |
| Cashier: cash/split/installment/paydown, catalog/stock/customer read, receipt, ack/sync, PIN gate | **OFFLINE/QUEUED (proven)** | keep | existing grant | none (done) |
| Attendance clock-in/out/leave | ONLINE-only | append-only signed clock events, durable, queued, server-authoritative accept | offline-PIN operator + grant binding; device clock (bounded) | ADR-041-C direction approved; **C-i** operator attribution (recommend: offline-PIN roster operator) |
| Returns / refunds / exchange | BLOCKED (fail-closed) | server-issued signed **return grant** (per-line eligible qty + max refundable, server-computed); queue immutable return intent; refund `status=pending`, **settle only after reconnect attestation**; drift → reconciliation | return grant bound to original order/device/register; eligible lines + amounts | ADR-041-A; **A-i** refund budget/max, **A-ii** grant window, **A-iii** refund-only vs exchange first (recommend refund-only) |
| Non-cash tender (card/instapay/wallet) | recorded, **attested-not-settled** | keep + UI never implies provider settlement | — | ADR-041-B confirmed; forbids gateway-capture claim until a gateway ADR |
| Inventory receive / adjust / transfer / issue / count | ONLINE-only | scoped **preauthorized/bounded** or **provisional append** commands; unmistakably-local projected ledger; reconcile; never hide oversell/shortfall | server-issued bounded allocation/authority envelope; location binding | **E** (reopened): oversell tolerance + allocation/preauth policy — **owner, not fabricable** |
| Orders: view / update / fulfill / cancel / return | cached read-only | persist offline **intent**, never overwrite canonical status/history; explicit reconciliation result | cached order snapshot; signed intent command | which order ops are offline-permitted + conflict policy (owner) |
| Customers: capture / profile change | capture travels w/ sale | safe local capture + **scoped** profile edits; duplicate-identity conflict handling on sync; PII-at-rest + retention | scoped customer-edit authority; local PII controls | retention/access policy; edit-scope (owner) |
| Promotions / vouchers | BLOCKED (arch) | bounded server-issued **promotion/redemption grant** (eligibility, budget, expiry, stacking, shared-redemption contention) OR keep cache/queued-request; **never client-invent discounts** | pre-authorized promo budget grant | ADR-041-D (reopened): bounded promo-grant policy — **owner** |
| Suppliers / purchases / dues / payments | ONLINE-only | scoped purchase/receiving grants or provisional append docs; separate goods-receipt from inventory posting, supplier-payment from recorded intent | purchasing/receiving authority; AP policy | supplier financial authority + AP settlement policy — **owner, not fabricable** |
| Reports / activity | ONLINE (reports) / local (activity) | **useful offline reports stating coverage + freshness**; never label a partial local projection as company-wide | existing local IPC (pending sync, local sales, activity ledger) | **none** — SDK-free, implementable now |
| Settings / device governance | mixed (POS-user PIN offline) | local prefs apply immediately; shared settings queued/provisional + versioned; honest **bounded-lease** revocation delay disclosure; no "globally revoked" claim before ack | versioned settings; lease/revocation semantics | device revocation lease semantics (**G**, owner/ops) |
| Payroll | online (back-office) | derived from accepted attendance; acceptance under approved policy | — | payroll attribution/corrections policy — **owner** |

### 15.4 Dependency-ordered plan (all-desks), to execute once 15.2 is resolved

0. **(gate) Resolve SDK source (15.2)** + run the authorized isolated real-API regression for the existing
   cashier path (D-1/D-2/multi-device) on a disposable `rt-<hex>` stack to re-confirm the baseline.
1. **SDK-free, startable now, no owner gate:** (a) offline-honesty UX on every management desk (honest
   "needs connection / available offline" states instead of raw errors); (b) local-only **reports/activity**
   view from existing `window.offline` IPC that states coverage + freshness. Testable with POS vitest.
2. **Attendance** (append-only; lowest server risk; no money/stock) — §14.2 slice end-to-end + isolated
   acceptance. Only owner sub-decision: **C-i** attribution.
3. **Returns** (grant + ingestion + withheld settlement) — §14.3 slice. Owner: A-i/A-ii/A-iii.
4. **Customers** scoped capture/edit + duplicate-conflict reconciliation.
5. **Orders** offline intent + reconciliation (no canonical overwrite).
6. **Inventory** bounded-allocation/provisional ops + local projected ledger (owner: E oversell/allocation).
7. **Promotions/vouchers** bounded promo-grant (owner: D) — else keep queued-request only.
8. **Suppliers/purchasing** scoped grants/provisional docs (owner: AP authority).
9. **Settings/device governance** queued/provisional + versioned; bounded-lease revocation honesty (owner: G).
10. **Payroll** acceptance from accepted attendance (owner policy).

Each server-contract slice lands only with isolated real-API acceptance (no mocks on the core path); behind a
feature flag defaulting to today's fail-closed/online-only.

### 15.5 Owner decisions required (consolidated; #1 is pivotal and blocks all server work)

| # | Decision | Recommendation | Blocks |
| - | -------- | -------------- | ------ |
| **1 (SDK)** | Restore `packages/sdk/*` source (or point me at the new SDK build location) so the contract can be rebuilt/packed. | Restore the deleted SDK source on `feat/pos-pin-provider` (or confirm its new home). Nothing new is buildable until then. | **Every** new offline desk |
| **C-i** | Offline attendance operator attribution | the authenticated offline-PIN roster operator | Attendance |
| **A-i/ii/iii** | Return refund budget/max · grant window · refund-only vs exchange first | bounded refund grant; short window; **refund-only first** | Returns |
| **E** | Inventory offline oversell tolerance + allocation/preauth model | server-issued bounded allocation; no POS-private global truth; reconcile, never hide shortfall | Inventory |
| **D** | Offline promotion/redemption authority | bounded server-issued promo grant **or** keep queued-request only; never client-invent discounts | Promotions/vouchers |
| **AP** | Supplier purchasing/receiving/payment authority | scoped grants; separate goods-receipt from posting and payment from intent; no fabricated AP settlement | Suppliers |
| **G** | Device revocation lease length / window | tune server lease to acceptable revocation-latency; disclose delay honestly in UI | Device governance |

### 15.6 Resume point / next safe action

**Done this session:** Phase 0 live re-verification; all-desks scope correction + requirement matrix +
dependency plan (this section); POS `pnpm test` re-confirmed **200 passed / 4 skipped** (real SQLite,
2026-11-11); **owner decision #1 resolved** — SDK source restored (`git restore -- packages/sdk`), spaced-path
build-script bug fixed (`strip-bundle-banners.mjs` → `fileURLToPath`), and the full SDK pipeline re-proven:
`pnpm sdk:build` + `pnpm sdk:pack` → `artifacts/shifted-clothing-commerce-sdk-0.26.0.tgz`. Nothing
committed/pushed/deployed.

**Still open (owner):** C-i, A-i/ii/iii, E, D, AP, G (§15.5) — each gates only its own desk, not the program.

**Next safe actions, in order:**
1. **15.4 step 1 (SDK-free, no owner gate):** plumb the connectivity signal (`syncStatus.networkOnline`,
   already in `App.tsx`) into the connected-shell render branch (App.tsx ~line 1572) and give each management
   desk (orders/inventory/customers/vouchers/staff/suppliers/reports/settings) an honest offline state via a
   shared `OfflineDeskNotice` ("needs a connection — use the offline cashier for sales") instead of raw SDK
   errors; add a local-only reports/activity view from existing `window.offline` IPC that states coverage +
   freshness. Cover with POS vitest. (Not started this session — stopped at a clean boundary rather than leave
   the large App.tsx render half-edited.)
2. **15.4 step 2 — attendance** end-to-end (§14.2): now buildable (SDK restored). Add
   `canonicalizeOfflineAttendanceCommand` + `ingestOfflineAttendance` to `packages/sdk/src`, API
   `record_offline_attendance` migration + RLS, `openapi:generate && sdk:pack`, re-vendor the tgz to POS, bump
   POS `boundaries.test.ts` SHA, POS outbox lane + offline `AttendanceClock` path; isolated real-API acceptance
   on a disposable `rt-<hex>` stack (now authorized). Owner sub-decision: C-i attribution.
3. Then returns → customers → orders → inventory → promotions → suppliers → settings/governance → payroll
   (§15.4), each behind a flag with isolated real-API acceptance.

**Guardrails (unchanged):** do **not** run stock `test:pos:offline:*` / `test:rls` /
`test:pos:sale:integration` (shared-project `stop --no-backup` data-loss path, §9.1); do not touch the shared
dev stack or the historical `rt-*` stacks; isolated acceptance only on fresh `rt-<hex>` stacks via the proven
ownership-boundary harnesses; do not commit/push/deploy.

---

## 16. Phase 10 — all-desks offline shell + first new offline desk (attendance) BUILT & TESTED (2026-11-12)

First phase to **land working code + tests** for the all-desks program (§15), not another audit. Two
deliverables implemented and verified; one owner-authorized acceptance run blocked only by a host resource
limit (documented honestly as NOT RUN, with the test written and ready).

### 16.1 Live state re-verified (not from prior summaries)

| Repo | Branch | HEAD | Verified |
| ---- | ------ | ---- | -------- |
| clothing-commerce-pos | `feat/pos-pin-login` | `3bbb6fe` | SDK source restored intact (§15.2); `strip-bundle-banners.mjs` uses `fileURLToPath`; new desk-status + attendance code present (see 16.4/16.5). |
| clothing-commerce-api | `feat/pos-pin-provider` | `87aedad` | `packages/sdk/src` present; attendance migration + route + SDK method present. |

Report claims from the prior session **re-verified true**: SDK source restored; `pnpm sdk:build`/`sdk:pack`
green → `artifacts/shifted-clothing-commerce-sdk-0.27.0.tgz`; all-desks scope in §15. No branch/reset/stash/
commit/push/deploy performed. SDK deletions were **not** re-restored/reverted; user changes preserved.

### 16.2 Deliverable A — consistent offline state across every desk (DONE)

- **Shared contract** `src/renderer/offline/desk-status.ts`: a single pure `deskStatus(input)` decision
  function mapping a desk's static `DeskOfflineCapability` (`offline-writes` / `cached-read` / `local-only` /
  `online-only` / `blocked`) + the **authoritative** signal (`syncStatus.networkOnline` + `offlineReadiness` +
  the durable `PendingSyncSummary`) → one of seven honest `DeskStatusKind`s (online / offline-ready /
  cached-readonly / local-only / queued / blocked-authority / online-only). Invariants enforced: an
  online-only/blocked desk is **never** shown offline-ready; a would-be offline-writes desk with
  missing/expired authority degrades to `blocked-authority` with the precise readiness reason; pending +
  unresolved counts surface in **every** state.
- **Single declaration table** `desk-capabilities.ts` (`DESK_OFFLINE_PROFILES`) — each management desk's
  offline capability + reason key in one place, derived from the §13.3/§15.3 matrix.
- **Component** `OfflineDeskBanner.tsx` renders the localized (EN/AR) status with snapshot age, pending &
  unresolved counts and last-sync time. Wired in `App.tsx` above **every** management desk route
  (`orders/inventory/customers/reports/vouchers/suppliers/staff/activity/settings`); the cashier keeps its
  richer sync UI (not double-bannered).
- **Local Reports/Activity** `reports/OfflineLocalReport.tsx` on the Reports desk — sourced only from durable
  local state via `window.offline.getLocalReport()` (accepted local sales, outbox lifecycle, local customer
  payments). Labelled **device-only**, with coverage range, as-of time, and pending/synced/needs-reconciliation
  counts; never presented as a company-wide report or financial close; honest unavailable state on failure.
- **Tests:** `desk-status.test.ts`, `OfflineDeskBanner.test.tsx`, `OfflineLocalReport.test.tsx` cover online,
  offline-ready, stale/expired-grant (blocked-authority), pending/queued, needs-attention, cached-read and
  local-only — including a cached-read desk that has no offline write capability.

### 16.3 Deliverable B — offline attendance capture (BUILT; POS + server-contract proven locally)

Append-only, **provisional** vertical slice end-to-end: POS UI → offline-PIN operator/device/grant context →
typed preload channel → transactional SQLite (`local_attendance_event` + `attendance_outbox` in ONE txn before
any network) → canonical signed SDK command → real API route/RPC → durable **received** receipt.

- **SDK (0.27.0):** `OfflineAttendanceCommand` + `canonicalizeOfflineAttendanceCommand` (contracts) and the
  `ingestOfflineAttendance` client method; OpenAPI regenerated (drift test green); packed and **re-vendored**
  to POS — vendored `.tgz` is **byte-identical** to the built artifact (sha256 `3cef2f42…`); `boundaries.test.ts`
  SHA bumped.
- **API:** migration `20261111120000_offline_attendance.sql` — dedicated append-only
  `public.offline_attendance_ingestions`, idempotent by `(tenant, syncCommandId)` + `command_fingerprint`
  (exact replay returns original; changed intent → `ID409`), grant binding / schema-version / `acceptedAt`
  **and** `eventAt` ±5-min skew (anti clock-rollback) / credential-validity-at-acceptance / membership checks,
  same `offline_pos_writer` RLS + least-privilege as offline sales. Route `app/api/v1/pos/offline-attendance`;
  service verifies the Ed25519 device signature over the canonical bytes. It **never** writes payroll
  (`attendance_entries`), computes shifts, grace/rounding, or pairs clock_in/out — stored `received` /
  `pending_policy` only.
- **POS:** preload channels `offline:record-attendance-event` + `offline:get-local-attendance`;
  `offline-service.recordAttendanceEvent` / `getLocalAttendance`; durable `AttendanceOutboxStore` (lease/retry/
  immutability triggers) drained by the sync worker; `AttendanceClock.tsx` gains an offline path showing
  **saved-locally / queued** and never claiming server confirmation offline.
- **Semantics (honest):** a provisional, auditable, exactly-once signed `received` event, attributed to the
  authenticated offline-PIN roster operator (C-i recommendation). **Payroll attribution is NOT APPROVED / NOT
  PROVEN** — it remains an open owner policy decision; nothing in this slice claims payroll finality.

### 16.4 Bug found & fixed (narrowly-scoped prerequisite)

`sync-worker.ts runOnce()` returned from the whole pass on an empty **sale** outbox (`if (!item) return`),
so `drainPayments()` / `drainAttendance()` never ran when no sale was queued — a standalone queued attendance
(or customer-payment) event would **never sync**. Latent since `e033c0b` (no prior test wired a payment/
attendance outbox through the worker). Fixed to `break` so the payment and attendance lanes always drain.
Also fixes the customer-payment lane. Covered by the new `attendance-sync.test.ts`.

### 16.5 Tests actually run this phase

| Suite | Result |
| ----- | ------ |
| POS `pnpm typecheck` (3 tsconfigs) | **clean** |
| POS `pnpm lint` | **clean** |
| POS `pnpm test` (vitest, real SQLite, DB-free) | **228 passed / 4 skipped / 0 failed** |
| — incl. `attendance.test.ts` (capture atomicity, signature/canonical, local-state toggle, fail-closed) | 4 pass |
| — incl. `attendance-sync.test.ts` (deliver→received, transient-retry no-dup, crash-lease restart exact replay) | 3 pass |
| — incl. desk-status / OfflineDeskBanner / OfflineLocalReport | pass |
| API `pnpm typecheck` + SDK typecheck | **clean** |
| API `pnpm sdk:pack` (ESM+CJS+DTS) | **green**, 0.27.0, vendor byte-identical (sha `3cef2f42…`) |
| API `pnpm test` (vitest DB-free) | **413 passed** |
| API `pnpm test:openapi` (drift + structure) | **16 passed** |
| API `pnpm test:api:contracts` | **22 passed** |

**Real-API attendance HTTP acceptance — WRITTEN, NOT RUN (environment-limited).** Added 8 cases (A1–A8:
received+pending_policy happy path with `attendance_entries` untouched, DB-verified; clock-out; exact-replay
idempotency + changed-intent 409; grant-binding mismatch; schema-version reject; future-`eventAt` skew reject;
tampered-signature 401; anon RLS invisibility) to `tests/offline-pos-http-integration/offline-pos-http.integration.test.ts`,
runnable via `pnpm test:pos:offline:http`. **Two authorized runs attempted** (fresh disposable projects
`rt-ba5a2684…`, `rt-066016a8…`): both failed at `supabase start` for the 4th stack. Root cause: host has 8 GB
Docker RAM with **3 Supabase stacks already live** (shared `clothing-commerce-api` + two protected historical
`rt-*`), and the shared `supabase_vector` container is in a restart loop; a 4th minimal stack cannot boot. The
guardrails forbid stopping the shared or historical stacks, so the slot cannot be freed here.

### 16.6 Isolation proof (this phase)

- Both attempts minted unique disposable `rt-<32hex>` projects in temp workdirs, asserted not-shared +
  loopback before any Docker call (the proven ownership boundary); failure occurred at `supabase start`.
- **Zero leak:** after both attempts, `docker ps -a` shows **no** `rt-ba5a2684…` / `rt-066016a8…` containers and
  **no** leftover temp workdirs (cleanup / no-partial held).
- **Protected resources untouched:** shared `supabase_*_clothing-commerce-api` and the two historical
  `rt-4468a861…` / `rt-ef31d4a4…` stacks all still Up with unchanged identity (19 containers, same as pre-run).
- No stock `test:pos:offline:*` / `test:rls` runner was invoked; no prune; no `stop`.

### 16.7 Owner decisions still open (unchanged by this phase)

- **C-i** attendance operator attribution (implemented to the recommended offline-PIN roster operator; a
  broader payroll-subject mapping is still owner policy).
- **Payroll attribution/correction policy** for received offline clock events (ADR to be written; the slice
  deliberately stores `pending_policy` and claims no payroll effect).
- **A-i/ii/iii (returns), D (promotions), E (inventory), AP (suppliers), G (device governance)** — each still
  gates only its own desk (§15.5); this phase did not implement them. No desk relabelled permanently
  online-only.

### 16.8 Resume point / next slice (dependency-ordered)

1. **Run the written real-API attendance acceptance** (`pnpm test:pos:offline:http`, cases A1–A8) on a fresh
   `rt-<hex>` stack once a Supabase slot is free (more Docker RAM, or the two historical `rt-*` leftovers are
   confirmed disposable by the owner and removed by them). Also run the POS **packaged-Electron** attendance
   crash-before-sync acceptance (mirror `acceptance:offline-ack`).
2. **Returns** offline slice (§14.3 / §15.4 step 3) — grant + ingestion + withheld settlement; owner A-i/ii/iii.
3. Then customers → orders → inventory → promotions → suppliers → settings/governance → payroll (§15.4), each
   behind a flag with isolated real-API acceptance.

**Guardrails unchanged** (§15.6).

---

## 16A. Phase 10 continuation — attendance PROVEN end-to-end (real HTTP + packaged crash), 2026-11-12

This session **executed** the two acceptance paths that §16 left NOT RUN, and corrected a wrong root-cause
conclusion. Headline: offline attendance is now proven end-to-end — **both** the real HTTP + disposable
PostgreSQL path **and** the packaged-Electron local crash/restart path PASS.

### 16A.1 Root-cause correction (the "4th Supabase stack / 8 GB memory" blocker was a MISDIAGNOSIS)

The prior report said two attempts to boot a 4th Supabase stack failed on an 8 GB host, implying a resource
limit. Re-investigated with a safe, isolation-guarded diagnostic that surfaced the **real** (previously
redacted) CLI error:

```
LegacyMigrationApplyError: permission denied for schema public (SQLSTATE 42501)
At statement: alter table public.offline_attendance_ingestions owner to offline_pos_writer
```

`supabase start` applies **all** migrations; it was failing on `20261111120000_offline_attendance.sql`, not
running out of memory. Container memory at the time was ~32 % of 8 GB (~5 GB free). **The attendance
migration had never actually applied to a real Postgres** — the DB-free vitest / contracts / openapi suites
exercise types and the OpenAPI doc, not migration application, so they stayed green while the migration was
broken. This is exactly the "source inspection / DB-free mocks ≠ server acceptance" gap.

### 16A.2 Migration defect & fix (`20261111120000_offline_attendance.sql`)

The ownership block diverged from the proven offline-sale / offline-customer-payment pattern:
- **Transferring a `public` table to `offline_pos_writer` requires that role to temporarily hold CREATE on
  schema `public`.** The sale/payment migrations `grant create on schema public … → alter … owner → revoke
  create …`. Mine did the `alter … owner` with no surrounding grant/revoke → `42501`. **Fixed** to the
  grant→transfer→revoke pattern and added the `offline_writer_attendance_ingestions` all-access RLS policy
  (mirrors `offline_writer_payment_ingestions`).
- The RPC did a redundant `select 1 from public.memberships` existence check that would require the writer to
  read an RLS-protected table it has no policy on. **Removed** it; membership existence is enforced by the
  `offline_attendance_ingestions_member_fk` FK (the same approach `issue_grant` uses), so no RLS-sensitive
  read is needed. No behavioural loss — a bad membership still fails closed via the FK.

### 16A.3 Lowest-resource faithful backend (chosen from source, not by trial)

The attendance HTTP path needs: Postgres (migration/RLS/RPC), PostgREST (the API uses `@supabase/supabase-js`
`.rpc()`; the test verifies rows + anon RLS via PostgREST), and kong (the `SUPABASE_URL` gateway). GoTrue is
**not** on the path (the API verifies Clerk JWTs via `CLERK_JWT_KEY`; PostgREST verifies the static anon/
service JWTs). The harness already excludes analytics/logflare, vector, realtime, storage, studio, imgproxy,
mailpit, postgres-meta, edge-runtime, supavisor. Attempted also excluding gotrue → `supabase status` then
omits `SERVICE_ROLE_KEY`/`ANON_KEY` (the CLI only emits them when auth is in the stack), so **gotrue is kept**:
the faithful minimal stack is **db + gotrue + kong + postgrest**, which boots in ~45 s using 3–4 small
containers. Harness `scripts/test-offline-pos-http-isolated.mjs` updated: documented minimal exclude; `run()`
now secret-filters (not blindly `[redacted]`s) a failed CLI command so a failing migration can never again be
misread as a resource failure.

### 16A.4 Full HTTP + disposable PostgreSQL — A1–A8 PASS (real server, real DB)

`pnpm test:pos:offline:http` on a fresh disposable `rt-<hex>` stack (unique workdir/project/ports/owner
marker; `--workdir`-pinned; `assertNotShared`/`assertLoopback`; sanitized child env; migrations on the fresh
project, **no reset of any existing DB**). The real Next.js server runs loopback-only against the disposable
DB; requests go over HTTP through the packed SDK. **16/16 tests passed** (8 pre-existing offline-sale/tender/
installment cases + the 8 new attendance cases):

| Case | Scenario | Evidence | Verdict |
| ---- | -------- | -------- | ------- |
| A1 | clock-in accepted as provisional `received` | HTTP `syncStatus:received`, `event.adjudication:pending_policy`; DB row in `offline_attendance_ingestions` (received/pending_policy, correct operator/device/register, 64-hex fingerprint); **`public.attendance_entries` count unchanged (no payroll write)** | **PASS** |
| A2 | clock-out accepted, same operator | HTTP received; membership attributed | **PASS** |
| A3 | exact replay idempotent; changed-intent same key → 409 | replay returns original `ingestionId`, row count unchanged; changed `eventType` same syncCommandId → HTTP 409; no new row | **PASS** |
| A4 | grant-binding mismatch (wrong register) | HTTP ≥400; no row written | **PASS** |
| A5 | unsupported schema version | HTTP 4xx; no row | **PASS** |
| A6 | future `eventAt` outside grant/skew window | HTTP ≥400; no row (clock-rollback/skew defence) | **PASS** |
| A7 | tampered command (signature mismatch) | HTTP 401; no row | **PASS** |
| A8 | anon tenant RLS invisibility | anon PostgREST sees 0 rows of `offline_attendance_ingestions` | **PASS** |

No payroll-final write, no partial write, correct reject/conflict states in every case.

### 16A.5 Packaged-Electron + real SQLite — crash/restart PASS

`pnpm acceptance:attendance` (new `tests/runtime/attendance` app + `scripts/run-attendance-acceptance.mjs`),
real packaged main/offline modules, a **disposable** user-data dir (`commerce-pos-attendance-acceptance`, never
the dev profile), deterministic test-only crash barriers (`process.reallyExit(86)`):

- **capture-crash → restart-send:** an offline `clock_in` is durably persisted + queued, the process is killed
  **before any send**; on restart the **exact** event recovers as provisional (`accepted_pending_sync`), is
  dispatched **once** with its **original** idempotency key, reaches `received`, outbox `delivered`, 0 pending —
  and it **drains with the sale outbox empty** (regression guard for the §16.4 `return`→`break` fix).
- **commit-crash → replay:** the server commits (key logged) then the process is crashed mid-delivery before
  local acknowledgement; on restart the retained command replays with the **same single identity** (2 dispatches,
  1 distinct key, all original) and reaches `received`, 0 pending — one logical ingestion (real-server
  idempotency already proven by A3).
- Transient-retry-without-duplication and fail-closed-when-no-authority are proven at the real-SQLite service
  level by `tests/offline/attendance-sync.test.ts` and `tests/offline/attendance.test.ts` (clearly a unit, not
  packaged, category).

### 16A.6 Regression (this session)

POS `typecheck` clean · POS `lint` clean · POS focused vitest (attendance + attendance-sync + ipc-security +
sync-worker) **18 passed** · API `typecheck` clean · `sdk:pack` green, POS vendored `0.27.0` **byte-identical**
(sha256 `3cef2f42…`) · `test:api:contracts` **22 passed** · `test:openapi` **16 passed**.

### 16A.7 Isolation & cleanup proof

- Shared dev stack **never contacted or restarted** (`supabase_db_clothing-commerce-api` uptime unchanged across
  the session) and the two historical `rt-4468a861…` / `rt-ef31d4a4…` stacks **untouched** (still 4 containers
  each). No stock runner, no prune, no `stop`.
- Every disposable run minted a unique `rt-<hex>`, migrated the fresh project only, and cleaned up by label.
  After the session: **no leaked `rt-<hex>` containers/volumes/networks**, and the one lingering temp workdir
  (`rt-6178d09c…`, a Windows junction-lock cleanup miss — Docker resources already gone) was removed
  junction-safely, repo `node_modules` intact. Only the shared + 2 protected stacks remain.
- The attendance acceptance used a disposable user-data dir, not the developer's Electron profile.

### 16A.8 Status & remaining

**Offline attendance is proven end-to-end** (real HTTP + disposable PostgreSQL **and** packaged local crash/
restart). It remains **provisional `received` / `pending_policy`** — **payroll attribution is still NOT
APPROVED / NOT PROVEN** (open owner decision; the slice claims no payroll effect). Files changed this session:
`supabase/migrations/20261111120000_offline_attendance.sql` (defect fix),
`scripts/test-offline-pos-http-isolated.mjs` (minimal exclude + diagnosable errors),
`tests/offline-pos-http-integration/offline-pos-http.integration.test.ts` (A1–A8, from the prior session),
`tests/runtime/attendance/*` + `scripts/run-attendance-acceptance.mjs` + `package.json` (packaged acceptance).
The POS as a whole is **not** fully offline — the other management desks remain online-only/cached per §15; the
next slice is **returns** (§16.8).
