# Mobile Architecture · Part 12 — Sync Implementation Audit

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.
> **What this is:** an audit of the **actual** mobile sync code in
> `apps/ayphen-retail-mobile/src/infrastructure/sync/` against the designed engine
> ([mobile-11 Client Sync Engine](./mobile-11-sync-engine-client.md)). Every finding is cited with
> file:line. Reviewed across four axes: engine/pull/scheduler, push/queue, apply/write/POS-model,
> multi-store/registry/freshness.
> **Verdict:** ✅ **architecture correct & production-grade** — five of the six load-bearing invariants
> are implemented (**INV-11, the pending-mutation shadow, is missing** — added post-audit, §10 A-1); a
> small set of real gaps remain (recovery, early-unlock, monotonic guard, INV-11).
> **Legend:** ✅ correct · 🟡 minor/acceptable · 🟠 should-fix · 🔴 must-fix.

> **⚠️ Repo-status warning (2026-07-02):** every path cited below (`apps/ayphen-retail-mobile/…`,
> `apps/api/…`) refers to the **reference implementation — not this repository**. This repo
> (`apps/mobile`, `apps/backend`) contains **no sync code yet**: no `infrastructure/sync/` on mobile and
> no sync module on the backend. Treat every ✅ as "correct in the reference implementation / design
> intent" and **re-verify against this repo before relying on any finding**. In particular §6's "the
> order handler exists and wires the ledger" does **not** hold here — see the header note in
> [sync-engine.md](./sync-engine.md). New design decisions adopted after this audit are in
> [§10](#10-design-review-addenda-2026-07-02).

---

## Table of contents
1. [Verdict](#1-verdict)
2. [Invariant conformance](#2-invariant-conformance)
3. [What's correct (confirmed in code)](#3-whats-correct-confirmed-in-code)
4. [Scenario matrix](#4-scenario-matrix)
5. [Gaps & fix list](#5-gaps--fix-list)
6. [Ahead-of-docs notes](#6-ahead-of-docs-notes)
7. [Local DB layer — the correct flow](#7-local-db-layer--the-correct-flow)
8. [Local DB layer — findings & fixes](#8-local-db-layer--findings--fixes)
9. [File reference](#9-file-reference)
10. [Design-review addenda (2026-07-02)](#10-design-review-addenda-2026-07-02)

---

## 1. Verdict

The mobile sync engine **faithfully implements the designed architecture**, including the parts most
teams get wrong: transactional cursor/queue commits, an **additive event-sourced stock ledger**,
push-before-pull, per-store isolation, eviction safety, and idempotent replay. It is **production-grade**
and needs **no rearchitecture**.

It is **not 100% complete**. The must-fix is **410 recovery** (a long-offline store is silently stranded
and its sales dead-lettered). Two should-fix items follow (early POS unlock; an explicit monotonic
snapshot guard). Everything else is polish.

---

## 2. Invariant conformance

The six load-bearing rules from [mobile-11 §9](./mobile-11-sync-engine-client.md):

| Invariant | Status | Evidence |
|---|---|---|
| **INV-9** cursor advances only after rows commit | ✅ | cold-start `sync-pull.ts:372-395` & delta `sync-pull.ts:453-467` apply rows **+ cursor in one `withTransactionSync`** |
| **INV-10** mark mutation applied only after effect commits | ✅ | per-result tx, mark-after-apply `sync-push.ts:234-298` |
| **Push-before-pull** | ✅ | push → cold-start → delta `sync-engine.ts:243-262`; background-sync same order |
| **INV-5** migrate-before-sync | 🟡 partial | only a null-lookup data fix runs pre-sync (`sync-engine.ts:231-239`); no general schema-migration gate |
| **INV-11** never apply a pulled row over a pending local mutation | 🔴 missing | appliers upsert unconditionally (`base-applier.ts:94`) with **no pending-queue check** — a steady-state pull clobbers optimistic edits (compounds L-1 into silent data loss). Added post-audit — see [§10 A-1](#10-design-review-addenda-2026-07-02) |
| **POS additive, not optimistic-lock** | ✅ | sale **appends signed-delta `stock_event`**; `product.stock_quantity` = `SUM(delta)` projection (`stock-ledger.ts:13-33`); no `expected_row_version` on stock writes. 🆕 post-audit: a sale must also be **one composite mutation** ([§10 A-2](#10-design-review-addenda-2026-07-02)) |

---

## 3. What's correct (confirmed in code)

- **Optimistic apply + enqueue are atomic** — `applyLocal()` + `enqueueMutation()` in one
  `withTransactionSync` (`optimistic.ts:64-87`) → crash between them is impossible.
- **Idempotency** — stable client `mutation_id` (`mutation-queue.ts:29-31`, generated once); server
  dedupes; **`resetSendingMutations()` on startup** (`mutation-queue.ts:366-373`) recovers a crash
  mid-push → replay → server returns `duplicate`.
- **Per-result handling** (`sync-push.ts:234-298`): `applied`/`duplicate` → delete row + apply server row;
  `rejected` → mark failed (no retry); `conflict` → server-wins / keep-mine / manual.
- **Conflict storage on the queue row** — `server_row` JSON + `status='conflict'` (`mutation-queue.ts:248-258`);
  no separate table (matches mobile-10).
- **Priority + dependency drain** — entity priority (order/payment > stock > reference) + action priority
  (create→update→delete) + **per-entity serial lane** (`PARTITION BY entity_type, entity_guuid`,
  `mutation-queue.ts:150-173`); batch cap 50.
- **Backoff + DLQ** — exponential 30s→15min jittered (`mutation-queue.ts:33-41`), dead-letter at 12
  attempts, 30-day TTL purge.
- **Idempotent apply** — all appliers `ON CONFLICT(guuid) DO UPDATE` (no version guard on pull —
  correct: server is authoritative), `base-applier.ts:94`; deletes+tombstones in a tx.
- **Applier registry** (not a switch) — `registry.ts:30-62`, ~23 appliers.
- **Pull-side DLQ** — `failed_applies` with FK-aware retry budgets (validation 3 / FK 10 / unknown 5),
  `failed-applies.ts`.
- **Per-store partitioning** — cursor in `global_sync_cursor` (PK `store_id`), progress in `sync_state`
  (PK `store_id,entity_type`); cold-start cursor has an **entity-affinity prefix** guard.
- **LRU eviction with safety gates** — never evicts the active store, a syncing store, or one with
  pending/conflict/failed/dead mutations; 7-min grace; one-per-cycle; atomic purge in FK order
  (`store-eviction.ts`, `store-cache.ts:95-182`).
- **Freshness piggyback** — `x-permission-snapshot` extracted on every response, **Ed25519 signature
  verified before swap** (`interceptors.ts:155-189`, `authThunks.ts:327-350`); subscription hint synced
  to `local_store_state` (`syncSubscriptions.ts`).
- **Coalescing** — one in-flight promise per store engine (`sync-engine.ts:107-144`); concurrent
  foreground/reconnect/interval triggers collapse.
- **Redux sync-slice** — status + 5-counter snapshot + cold-start progress + health selectors
  (`sync-slice.ts`), drives the sync indicator + issues screen.

---

## 4. Scenario matrix

| Real-time scenario | Result |
|---|---|
| Crash mid delta-pull | ✅ cursor unchanged → re-fetch → idempotent upsert |
| Crash mid push (`sending`) | ✅ reset to pending → replay → server `duplicate` |
| Crash between optimistic apply & enqueue | ✅ one tx → both or neither |
| **Two devices sell the last unit offline** | ✅ both append `-1`, stock goes negative, reconciles — **no false conflict** |
| Reconnect with queued sales | ✅ push-before-pull → sales land first |
| Concurrent foreground+reconnect+interval | ✅ coalesced via in-flight promise |
| Multi-store background sync | ✅ per-store engine/cursor; eviction won't drop a store with unsynced work |
| Subscription expired offline | ✅ mutation-queue subscription guard blocks new writes |
| **Store offline > 180 days → `410`** | 🔴 **not recovered** (gap #1) |
| **Large catalog cold start** | 🟠 POS blocks to 100% (gap #2) |
| **Out-of-order piggyback snapshot** | 🟠 possible permission regression (gap #3) |
| `429` under load | 🟡 retried on local curve, ignores `Retry-After` (gap #4) |
| Poison mutation | 🟡 blocks its own entity lane until dead-letter (~hours); other entities flow |

---

## 5. Gaps & fix list

### 🔴 #1 — `410 SYNC_HORIZON_EXCEEDED` / `UPGRADE_REQUIRED` not handled (must-fix)
`410` is treated as a fatal 4xx — it's **not** in `TRANSIENT_HTTP_CODES` (`sync-push.ts:115-130`), so on
push the mutations eventually **dead-letter**, and on delta pull it just errors. The client never clears
`global_sync_cursor` or forces a cold-start. A store offline past the **180-day horizon** (seasonal /
festival closure) **cannot auto-recover**, and its queued sales are lost to the DLQ.
**Fix:** detect `410` in both pull and push; branch on the error code →
- `SYNC_HORIZON_EXCEEDED` → clear `global_sync_cursor` for the store + set `needsColdStart` → re-run
  cold-start (preserve the mutation queue);
- `UPGRADE_REQUIRED` → route to the upgrade wall, don't dead-letter.
([mobile-11 §13](./mobile-11-sync-engine-client.md))

### 🟠 #2 — Early POS unlock not realized (should-fix)
Cold start marks all entities complete together and the UI waits for **100%** — there is no unlock at
reference+catalog (G1–G3) with G4–G5 backgrounded, even though per-entity `cold_start_complete` flags
exist in `sync_state`. On a 100k-product first sync the cashier faces a multi-minute blocking screen.
**Fix:** gate POS on "config + catalog complete," background inventory/history (INV-7 /
[mobile-08](./mobile-08-loading-ux-states.md) / [mobile-11 §4](./mobile-11-sync-engine-client.md)).

### 🟠 #3 — Monotonic snapshot guard appears implicit-only (should-fix; verify first)
`applyPiggybackSnapshot` verifies the signature then dispatches `setSnapshot` (`authThunks.ts:327-350`);
no explicit `if incoming.version <= current.version → ignore` was found. Atomic dispatch ≠ monotonic — a
late response carrying an **older** snapshot can regress permissions (violates
[mobile-09 INV-1](./mobile-09-client-services-and-invariants.md)).
**Fix:** add the explicit version compare in the thunk/reducer (drop this item if it's already enforced).

### 🟡 #4 — `Retry-After` ignored
`429` is retried on the local exponential curve only (`mutation-queue.ts:33-41`); the server's
`Retry-After` header is not parsed. Can re-hit a loaded server sooner than asked.
**Fix:** parse `Retry-After` and use it for `next_attempt_at` when present.

### 🟡 #5 — `parent_guuid` stored but not client-enforced
The drain relies on per-entity lanes + priority + creation order; it doesn't hard-block a child until its
parent's ack. **Within a batch** the server cascades `PARENT_FAILED`, so it's safe there; the gap is
**cross-batch** (parent dead-lettered earlier, child runs later → server-rejected). Low frequency.
**Fix (optional):** skip a child whose `parent_guuid` is still pending/dead in the queue.

### 🟢 Minor
- `mutation_id` is a hex UUID, not a ULID — fine for idempotency, loses time-sortability.
- `DELTA_MAX_PAGES=10` + 5 catch-up runs then 60s — a very large backlog drains slowly (acceptable).
- General **schema-migration gate** (INV-5) is only a null-lookup fix today — add a real
  `schema_meta`/migration check before sync after an app update.

---

## 6. Ahead-of-docs notes

- ~~**The backend `order` mutation handler exists** (`apps/api/.../order/sync/order-create.handler.ts`) and
  **wires `stock_event.recordDelta`** (signed negative delta per line item).~~ ⚠️ **This claim holds only
  in the reference codebase — it contradicts [sync-engine §14](./sync-engine.md) ("ledger dormant, zero
  callers"), and in *this* repo neither the handler nor the ledger wiring exists** (see the repo-status
  warning at the top). Resolution: sync-engine.md is the authoritative design; its §24 build list stands,
  now with the **composite `order` mutation** shape ([§10 A-2](#10-design-review-addenda-2026-07-02)).
- The client carries `product_stock`, `product_price_history`, `retired_pos_code`, `customer_contact`,
  `supplier_contact` appliers — consistent with [mobile-10 §9](./mobile-10-local-database-schema.md)'s
  reference-schema mapping (multi-location/B2B variants present).

---

## 7. Local DB layer — the correct flow

The repository / mapper / applier stack over SQLite, as implemented. Four layers, each with one
responsibility.

### 7.1 Foundation (`src/database/`)
- **Single shared connection** `getDb()` over **expo-sqlite** (`client.ts:14-40`), opened once with
  **WAL + `synchronous=NORMAL` + `foreign_keys=ON` + `wal_autocheckpoint`** (`client.ts:165-168`).
- **SQLCipher in production** — 256-bit key in Keychain (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), `PRAGMA key`
  applied before any query (`db-key.ts`, `client.ts:142`).
- **Migrate-before-sync (INV-5):** `DatabaseProvider` blocks render until `migrate()` completes → then
  maintenance → then background-sync registers (`provider.tsx:149-153`). Drizzle `__drizzle_migrations`.
- **Stale-migration recovery:** on a partial/failed migration it **backs up the outbox**
  (`pending_mutations`, `tombstones`, `failed_applies`), wipes, re-migrates, **restores the outbox**
  (`provider.tsx:152-180`) — un-pushed sales survive a schema repair.
- Schema = one `drizzle-schema.ts` (~30 tables), partial indexes (`WHERE deleted_at IS NULL`), money
  **CHECK constraints** (`ROUND(text*100)=paise`), `$inferSelect/$inferInsert` exported.

### 7.2 Write flow — optimistic enqueue (the offline-first spine)
```
UI hook → mapper.toInsert / toPayload
  → applyOptimistic()                                    (optimistic.ts:64-87)
     └─ db.withTransactionSync:
          repo.insertInTx / updateInTx (writes SQLite)
          + enqueueMutation()                            ← local row + queue row in ONE tx
  → fireEnqueueListeners(storeId)
     └─ Redux pendingCount++  +  trigger sync
```
- Every create/update/delete goes through `applyOptimistic` (local write + queue insert atomic).
- `expected_row_version` is sent **for master-data updates** (optimistic lock) and **omitted for POS
  appends** (additive ledger) — see the §8 inconsistency.
- **Image uploads bypass the queue** by design (online-only — `patchProductImageLocal`/
  `patchCustomerImageLocal`); correct.

### 7.3 Read flow — partitioned, soft-deleted
```
UI → useLocalList() → repo.list(storeId)
   → Drizzle .select().from(t).where(eq(store_id) AND isNull(deleted_at)).all()
```
- Synchronous Drizzle queries (no React Query for local data); **every read partitioned by `store_id`**
  and filtered `deleted_at IS NULL`.
- Re-reads when the hook's dependency (`lastSyncedAt` / `tick`) changes.
- Multi-entity writes stay atomic (a stock adjustment updates `product_stock` in the same tx —
  `stock-adjustment.repo.ts:176-188`).

### 7.4 Apply flow (pull → SQLite)
```
sync-pull → db.withTransactionSync:
   appliers[entity].upsert  ON CONFLICT(guuid) DO UPDATE   (idempotent, no version guard on pull)
   + advance cursor                                         (INV-9, same tx)
→ Redux lastSyncedAt tick → useLocalList re-reads
```

### 7.5 Reactivity
| Surface | Mechanism |
|---|---|
| Lists | re-read on Redux `lastSyncedAt`/`tick` change (event-driven, no polling) |
| Pending badge / entity status | immediate via `fireEnqueueListeners` + Redux `snapshot` |
| Sync issue counts | recomputed from SQLite at end of each cycle, dispatched atomically |

---

## 8. Local DB layer — findings & fixes

| # | Finding | Severity | Fix |
|---|---|---|---|
| L-1 | **`expected_row_version` omitted on product & customer updates** (`useProductForm`, `useCustomerForm.ts:143-149`) while payment-account/stock-adjustment pass it. Master-data updates → **conflict detection never fires** → two editors silently last-write-wins. | 🔴 | pass `existing.row_version` on every master-data update; audit all `applyOptimistic` update calls |
| L-2 | **Lists may not refresh on an optimistic write** — `useLocalList` re-reads on `lastSyncedAt`/`tick`; the enqueue listener updates the badge/entity-status but (verify) may not bump the list `tick`. **Offline**, `lastSyncedAt` never changes, so a newly rung sale / added row may not appear until manual refresh. | 🟠 | verify `fireEnqueueListeners` invalidates/bumps the affected list; if not, wire enqueue → list refresh |
| L-3 | **Background sync doesn't dispatch Redux** (`background-sync.ts`) — UI reconciles only on the next foreground cycle. | 🟡 | dispatch a `lastSyncedAt` tick after a background pull, or invalidate on resume |
| L-4 | **Dead abstraction** — `core/data/repository.ts` (`createOfflineRepository`) + `useEntityMutation.ts` are defined but unused; repos call `applyOptimistic` directly, and order writes bypass the read-only `order.repo`. Two competing patterns + dead code. | 🟡 | adopt one pattern or delete the unused descriptor/hook |
| L-5 | **`usePendingMutationsCount` polls every 2s** instead of using the enqueue listener (the main badge already uses Redux). | 🟡 | migrate to event-driven (enqueue listener) |
| L-6 | **No nested-`withTransactionSync` guard** — appliers run inside the pull tx; ensure none opens a nested transaction. | 🟢 | add a guard / assert |

> **Verdict:** the local-DB layer is **correct and production-grade** (atomic optimistic writes,
> partitioned soft-deleted reads, migrate-before-sync with outbox-preserving recovery, money CHECKs). The
> two to fix before "done": **L-1** (master-data conflict detection) and **L-2** (list refresh on offline
> write). The rest is cleanup.

---

## 9. File reference

| Area | File | Key lines |
|---|---|---|
| Engine / cycle / coalescing | `src/infrastructure/sync/sync-engine.ts` | 107-144, 215-399 |
| Scheduler / triggers / debounce | `src/infrastructure/sync/useSyncOrchestrator.ts` | 35-40, 163-218 |
| Cold start + delta + cursor | `src/infrastructure/sync/sync-pull.ts` | 227-258, 372-395, 437-474 |
| Push / per-result / priority | `src/infrastructure/sync/sync-push.ts` | 115-130, 154-189, 234-298 |
| Queue / backoff / DLQ / conflict | `src/infrastructure/sync/mutation-queue.ts` | 29-41, 133-174, 221-274, 366-373 |
| Optimistic enqueue (atomic) | `src/infrastructure/sync/optimistic.ts` | 64-87 |
| Appliers / registry / base | `src/infrastructure/sync/entity-appliers/{registry,base-applier}.ts` | registry 30-62; base 94, 110-117 |
| Stock ledger (projection) | `src/infrastructure/stock/stock-ledger.ts` | 13-33, 88-97 |
| Failed applies (pull DLQ) | `src/infrastructure/sync/failed-applies.ts` | 63-168 |
| Eviction (LRU + gates) | `src/infrastructure/sync/store-eviction.ts`; `src/database/queries/store-cache.ts` | 11-193; 95-182 |
| Freshness piggyback | `src/infrastructure/http/interceptors.ts`; `src/store/authThunks.ts` | 155-189; 327-350 |
| Sync state (Redux) | `src/store/sync-slice.ts` | 64-451 |
| Schema (queue, cursor, state) | `src/database/schema/drizzle-schema.ts` | 15-117 |
| DB connection + PRAGMAs + encryption | `src/database/client.ts`; `src/database/db-key.ts` | client 14-40, 142, 165-168 |
| Migrations + stale-recovery + reset | `src/database/provider.tsx` | 76-131, 149-217 |
| Repository read (Drizzle, partitioned) | `src/features/*/repository/*.repo.ts` | e.g. product 69-104; customer 65-103 |
| Mappers (DB ↔ payload, money) | `src/features/*/repository/*.mapper.ts` · `product.sync.ts` | — |
| Master-data update (L-1) | `src/features/{products,customers}/hooks/use*Form.ts` | customer 143-149 |
| List read + reactivity (L-2) | `src/core/data/useLocalList.ts` | 43, 67-87 |
| Unused descriptor/hook (L-4) | `src/core/data/repository.ts` · `useEntityMutation.ts` | 23-61 |
| Backend order handler (ledger) | `apps/api/src/modules/order/sync/order-create.handler.ts` | 104-121 |

---

## 10. Design-review addenda (2026-07-02)

Design changes adopted into [sync-engine.md](./sync-engine.md) / [mobile-11](./mobile-11-sync-engine-client.md)
**after** this audit was written — the audited (reference) code predates them and must be re-checked
against each item when the engine is built in this repo:

| # | Change | Where specced |
|---|---|---|
| A-1 | 🔴 **Pending-mutation shadow (INV-11)** — never apply a pulled row over an entity with a pending/conflict mutation. The audited appliers upsert unconditionally, so a steady-state pull clobbers optimistic local edits (and with L-1 unfixed, edits are silently lost end-to-end) | [mobile-11 §5/§9](./mobile-11-sync-engine-client.md) · [sync-engine S-21](./sync-engine.md) |
| A-2 | 🔴 **Composite sale mutation** — one sale = one mutation = one server tx (items + payments + stock deltas embedded). Kills partial sales (child failing after the parent committed), most of the parent-cascade gaps (#5 above / S-3), and ~6× rate-limit pressure | [sync-engine §9.1](./sync-engine.md) |
| A-3 | 🔴 **Tombstone retention → 195d** (must *exceed* the 180d horizon). The 179d spec was inverted: a 179–180d cursor passed the horizon check but its tombstones were purged → silently resurrected rows | [sync-engine §8/§19, S-22](./sync-engine.md) |
| A-4 | 🟠 **Client stock = local ledger projection only** — the `stock_quantity` column on a pulled `product` row is the server's stale cache; ignore it or displayed stock jumps backwards between reconciliations | [sync-engine §14](./sync-engine.md) · [mobile-11 §7](./mobile-11-sync-engine-client.md) |
| A-5 | 🟠 **Skew clamp** — a future `client_modified_at` is **clamped** at preflight, never rejects a sale; strict rejection stays only inside the §12 grace path (backdating = privilege) | [sync-engine §12, S-24](./sync-engine.md) |
| A-6 | 🟠 **Per-`(user, store, device)` rate-limit keys** — one owner login on N counter devices must not share (and exhaust) one sync budget at rush hour | [sync-engine §16, S-25](./sync-engine.md) |
| A-7 | 🟠 **`order_payment` joins the pull registry** in the same change as the order handler — otherwise a second device sees the sale but not how it was paid (cash reconciliation broken) | [sync-engine §3, S-26](./sync-engine.md) |
| A-8 | 🟡 **Cold-start speed comes from page size, not parallelism** — `INITIAL_PAGE_SIZE` 1000–2000 (+ `/initial` throttle raise); manifest checksums maintained incrementally or replaced by `(latest_watermark, count)` | [sync-engine §2/§6, S-27/S-28](./sync-engine.md) |
| A-9 | 🟡 **Upserts before deletes** within one delta page (created+deleted in-window ends deleted) · **claw-back purge** rejects-locally-with-notice any pending mutations against purged entities | [sync-engine §7/§18, S-29](./sync-engine.md) · [mobile-11 §5](./mobile-11-sync-engine-client.md) |
