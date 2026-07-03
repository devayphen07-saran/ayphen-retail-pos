# Mobile Architecture · Part 11 — Client Sync Engine

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.
> **Scope:** how the **mobile** sync engine is built to consume the backend contract — components, the
> store-open state machine, cold start, delta pull, mutation push, the POS write model, idempotency,
> conflicts, durability invariants, reconnect, backoff/DLQ, freshness piggyback, cursors, and multi-store.
> **The inverse of the server doc** — [sync-engine.md](./sync-engine.md) is the backend; this is the client.
> **Companions:** local tables [mobile-10](./mobile-10-local-database-schema.md); service catalog &
> invariants [mobile-09](./mobile-09-client-services-and-invariants.md); verified endpoints
> [api-reference.md](./api-reference.md). **Audit of the real code vs this design:**
> [mobile-12 Sync Implementation Audit](./mobile-12-sync-implementation-audit.md).

---

## Table of contents
1. [Mental model](#1-mental-model)
2. [Component architecture](#2-component-architecture)
3. [Store-open state machine](#3-store-open-state-machine)
4. [F-1 Cold start — consuming `/sync/initial`](#4-f-1-cold-start--consuming-syncinitial)
5. [F-2 Delta pull — consuming `/sync/changes`](#5-f-2-delta-pull--consuming-syncchanges)
6. [F-3 Mutation push — consuming `/sync/delta`](#6-f-3-mutation-push--consuming-syncdelta)
7. [The POS write model — additive, not optimistic-lock](#7-the-pos-write-model--additive-not-optimistic-lock)
8. [Idempotency & conflicts](#8-idempotency--conflicts)
9. [The six durability invariants](#9-the-six-durability-invariants)
10. [Reconnect & scheduling](#10-reconnect--scheduling)
11. [Backoff & dead-letter](#11-backoff--dead-letter)
12. [Freshness piggyback](#12-freshness-piggyback)
13. [Cursors & the horizon](#13-cursors--the-horizon)
14. [Multi-store partitioning](#14-multi-store-partitioning)
15. [Failure-handling matrix](#15-failure-handling-matrix)
16. [End-to-end sequence](#16-end-to-end-sequence)

---

## 1. Mental model

The backend exposes **three endpoints and one cursor protocol** ([sync-engine §2](./sync-engine.md)):

| Endpoint | Direction | Purpose |
|---|---|---|
| `GET /stores/:id/sync/initial` | pull | cold dump, one entity-type/page, `INITIAL_PAGE_SIZE` 1000–2000 rows ([sync-engine §2](./sync-engine.md)), resumable, guard-exempt |
| `GET /stores/:id/sync/changes?cursor` | pull | delta (upserts + deletes) since the opaque HMAC cursor |
| `POST /stores/:id/sync/delta` | push **+** pull | submit mutations, get per-mutation results **and** the next delta page |
| `GET /stores/:id/sync/manifest` | pull | per-entity counts/cursors for parallel cold start |
| `GET /stores/:id/sync/conflicts` · `PATCH /:mutationId` | — | list / resolve conflicts |

The mobile engine is the **inverse**: *pull → apply to SQLite*, and *local write → queue → push →
reconcile*. The server is the **reconciler, not the gate**. Two truths shape the whole design:

- **At-least-once, both ways** → every apply is **idempotent** (upsert by `guuid`); every push carries a
  **`mutation_id` ULID** the server dedupes. Nothing is exactly-once.
- **Two write models** ([sync-engine §13](./sync-engine.md)) → **master data** (product/customer/supplier/
  paymentaccount/lookup) uses **optimistic lock** (`expected_row_version`); **transactional POS data**
  (order/stock/shift/cash) is **additive / event-sourced** — *never conflict-reject a sale.*

> **Backend gap:** mutation handlers exist **only** for `product, product_case, customer, supplier,
> paymentaccount, lookup`. POS writes (`order/shift/cash/stock`) return `rejected: UNKNOWN_MUTATION`
> until WS-A ships. Build the local tables + queue now — the queue holds the writes (with backoff) so the
> client is ready ahead of the backend.

---

## 2. Component architecture

`SyncScheduler` decides **when**; `SyncEngine` decides **how**. Separating policy from mechanism keeps
battery/network rules out of the durable write path.

```
SyncScheduler ─ WHEN: app-foreground · network-restored · wifi/cellular · battery · idle timer · manual pull
   │ runPush() / runPull()
   ▼
SyncEngine (bound to one store_fk) ─ orchestrates the state machine
   │
   ├─ Transport ........ the HttpClient pipeline (auth · nonce · clock · retry · 401→single-flight refresh)
   │                     [mobile-09 §2.9]
   ├─ CursorStore ...... sync_cursor (delta) + sync_init_progress (cold start)        [mobile-10 §3]
   ├─ MutationQueue .... pending_mutations — priority · backoff · DLQ · conflict-on-row [mobile-10 §3]
   ├─ Appliers ......... one per entity_type → upsert/delete into SQLite via Repositories
   ├─ ConflictResolver  reads conflicts off the queue row (status='conflict' + server_row)
   └─ FreshnessHook .... routes piggybacked snapshot / x-*-version to Snapshot/SubscriptionManager
```

- **Appliers** are a registry (`entity_type → applier`) mirroring the server's `MutationHandlerRegistry`
  — adding an entity is a registration, not a `switch`.
- **Repositories** own all SQLite ([mobile-09 §2.11](./mobile-09-client-services-and-invariants.md)) — the
  engine never runs raw SQL.

---

## 3. Store-open state machine

```
NONE → RESOLVE → CLAIM_SLOT → OPEN_CONTEXT → MIGRATE → COLD_START? → DELTA → READY
        (pick     (online      (latest-only   (INV-5)   (first time)  (steady)
         store)    /access)     context, INV-2)
```

| State | Action | Notes |
|---|---|---|
| RESOLVE | `last_opened ?? default ?? picker` | zero-network; permissions already in the snapshot |
| CLAIM_SLOT | `POST /stores/:id/access` (online) | offline reopen **skips** this, reuses the prior claim |
| OPEN_CONTEXT | `GET /stores/:id/context` (or `/open`) | commit only if it's still the latest switch (INV-2) |
| MIGRATE | run SQLite migrations | **before any sync touches the DB** (INV-5) |
| COLD_START | loop `/sync/initial` | first time only; resumable |
| DELTA | `/sync/changes` | steady state thereafter |
| READY | writes + scheduled sync | events drive transitions |

Every state persists enough to **resume** (`sync_init_progress`, cursor) — a crash mid-open resumes, never
restarts. The engine is bound to one `store_fk`; switching rebinds it (§14).

---

## 4. F-1 Cold start — consuming `/sync/initial`

**When:** first open of a store (online), after a local wipe (`reset=true`), or after a `410` horizon.

```
loop:
  GET /sync/initial?entity_type=&cursor=
    → { entity_type, upserts[], has_more, page_cursor,
        all_entities_complete, remaining_entity_types[], next_delta_cursor, estimated_total? }
  BEGIN tx
    appliers[entity_type].upsertAll(upserts)              // idempotent by guuid
    syncInitProgress.set(entity_type, page_cursor, phase) // rows + progress commit together
  COMMIT
  if all_entities_complete:
    cursorStore.set(next_delta_cursor); break
```

**Client rules**
- The **server** picks the next incomplete entity in dependency order; the client just loops until
  `all_entities_complete`. `INITIAL_PAGE_SIZE` (1000–2000) rows/page; `page_cursor` is the keyset anchor.
- **Apply in dependency order** so FKs resolve:
  `G1 reference → G2 parties → G3 catalog → G4 inventory → G5 txn`. With `/sync/manifest`, fetch in
  parallel (3–4 workers within a group) but **insert in dependency order** (parallel fetch, ordered apply).
- **Unlock POS at G1–G3** (config + catalog) → finish G4–G5 in the background (INV-7). Never block to 100%.
  Progress bar from `estimated_total` / manifest counts.
- `next_delta_cursor` is **anchored at the cold-start's start** server-side → a row written *during* the
  long cold start is caught by the first delta poll (harmless idempotent re-delivery).
- `/sync/initial` is **rate-limit-guard-exempt** (`@Throttle` 30/min only) → cold start won't self-throttle.

---

## 5. F-2 Delta pull — consuming `/sync/changes`

**When:** steady state (foreground poll / reconnect) and folded into every `/sync/delta` response.

```
do:
  GET /sync/changes?cursor=<delta cursor>
    → { changes: { entity: { upserts[], deletes[] } }, sync_cursor, has_more }
  BEGIN tx
    for each entity:
      appliers[e].upsertAll(upserts)        // idempotent by guuid
      appliers[e].applyDeletes(deletes)     // hard_delete → purge; soft → remove/mark
    cursorStore.set(sync_cursor)            // ← cursor commits in the SAME tx as the rows (INV-9)
  COMMIT
while has_more                              // drain until false
```

**Client rules**
- **The cursor advances only after the rows commit, in one tx** (INV-9) — the single most important pull
  rule. The backend's no-gap watermark guarantees a row committed during the read window is re-delivered;
  you must not advance the cursor past data you haven't committed.
- `changes` is keyed by entity; each carries `upserts[]` + `deletes[]` (the shared tombstone stream).
- `60/min` budget on `/changes`, keyed per `(user, store)` → multi-store stores don't throttle each other
  (🆕 to be keyed per `(user, store, device)` — [sync-engine §16](./sync-engine.md) — so one owner login
  on multiple counters doesn't throttle itself).
- **Apply order within a page:** an entity's `upserts[]` apply **before** its `deletes[]` — a row
  created and deleted in the same window must end deleted.
- **Pending-mutation shadow (INV-11) 🆕:** **never apply a pulled row over an entity that has a
  pending/conflict mutation in the queue.** Push-before-pull only protects the reconnect sequence — in
  steady state a pull can land between a local optimistic write and its push and would clobber the edit
  (UI reverts, then flickers back on the next pull). Skip such rows (or shadow-buffer them) until the
  mutation reaches a terminal state (`applied`/`duplicate`/`rejected`/resolved), then reconcile from the
  server row.
- Drain `has_more` fully before idling.

---

## 6. F-3 Mutation push — consuming `/sync/delta`

The write path is **optimistic local apply → enqueue → drain → reconcile.**

### 6.1 On a local write (e.g. ring a sale, edit a customer)

> 🆕 **Ringing a sale enqueues ONE composite mutation** (`entity_type:'order'` with items + payments +
> stock deltas embedded — [sync-engine §9.1](./sync-engine.md)), not an order + N item + payment chain.
> `parent_guuid` is only for cross-aggregate links (e.g. a new Customer created in the same offline
> session as their Order).
```
BEGIN tx
  repositories.apply(localChange)          // optimistic — UI updates instantly
  mutationQueue.insert({
    mutation_id: ULID(),                    // idempotency key
    entity_type, action,                    // create | update | delete
    payload,
    expected_row_version,                   // REQUIRED for master-data updates (optimistic lock)
    client_modified_at: ClockService.now(), // server-aligned; drives point-in-time grace
    parent_guuid,                           // child cascades if the parent fails
    priority, status:'pending', attempts:0
  })
COMMIT
```

### 6.2 Drain loop
```
batch = queue.takeDrainable()
  // ordering: HIGH (order/payment/refund) > MEDIUM (shift/cash/stock) > LOW (audit/analytics)
  // dependency-sorted WITHIN a tier (parent before child via parent_guuid)
  // ≤ 100 mutations/batch (server Zod cap) and ≤ 100 mutations / 5 min (server budget)

POST /sync/delta { sync_cursor, mutations: batch, permissions_version }
  → { mutation_results[], changes, sync_cursor, has_more, snapshot?, permissions_version? }

for each result:
  BEGIN tx
    reconcile(result)                       // patch FK/guuid/row_version OR roll back
    queue.setStatus(mutation_id, mapped)    // ← mark AFTER the effect is written (INV-10)
  COMMIT

applyDeltaPage(changes, sync_cursor)        // same rules as §5 (cursor-after-commit)
routeFreshness(snapshot, permissions_version) // §12
if has_more: re-poll
```

### 6.3 Per-result handling
| `kind` | Meaning | Client action |
|---|---|---|
| `applied` | server accepted | write back `entity_guuid` / `row_version`; `status='applied'` |
| `duplicate` | already applied (idempotent replay) | treat as applied (use cached result) |
| `rejected` | 4xx business (`SHIFT_NOT_OPEN`, `UNKNOWN_MUTATION`, `PERMISSION_DENIED`, `SUBSCRIPTION_LAPSED_AT_WRITE`) | **don't retry**; roll back the optimistic change + notify |
| `conflict` | stale `row_version` (master data) | keep on the queue row with `server_row`; surface the resolver (§8) |

- A **whole-call `5xx`** (e.g. idempotency-race `503`) → retry the **entire batch** (idempotency makes it
  safe; you'll get `duplicate` for the ones that landed).
- The combined response also returns the **delta page** — apply it (§5) so push and pull stay in step.

---

## 7. The POS write model — additive, not optimistic-lock

The one place you must **not** reuse the master-data pattern:

- A sale is an **append**, never a `row_version` update — and it is **ONE composite mutation**
  ([sync-engine §9.1](./sync-engine.md)): the payload embeds `order` + `order_item[]` +
  `order_payment[]` + the implied **signed-delta `stock_event`s** (`-qty`), applied server-side in
  **one tx** (all-or-nothing — a partial sale is impossible; no `parent_guuid` graph for the sale's own
  parts). Two devices selling the last unit each append `-1`
  (different `guuid`s) → **both apply**, stock can go negative, the nightly reconciliation surfaces
  oversell. No conflict, no rejected sale.
- `product.stock_quantity` is a **projection** = `SUM(stock_event.delta)` — recomputed, never the source
  of truth. **Display always uses the local projection** (synced + local pending events); the
  `stock_quantity` column on a pulled `product` row is the server's stale cache — **ignore it**
  ([sync-engine §14](./sync-engine.md)), or displayed stock jumps backwards between reconciliations.
- Shifts mirror this: `shift_event` is the append-only timeline; `shift_session.status/variance` is a
  projection; close **freezes an immutable `closing_snapshot`** in the same tx as `SHIFT_CLOSED`
  ([shifts §15C/§15D](./shifts-and-cash-management.md)).
- Never send `expected_row_version` for POS appends — there's nothing to lock.

> ⚠️ Until the server POS handlers ship, these pushes return `UNKNOWN_MUTATION`; the queue holds them.
> The local additive model is still correct to build now.

---

## 8. Idempotency & conflicts

**Idempotency (free):** the `mutation_id` ULID dedupes server-side (written same-tx as the business write).
A timeout-then-retry returns `duplicate`, never a double-apply. **Keep the queue row until a terminal
result** (`applied`/`duplicate`/`rejected`/resolved-conflict).

**Conflicts (master data only):**
- `update` must carry `expected_row_version`; stale → `conflict` with the live `server_row`.
- The server **does not merge.** The client **rebases**: present take-server / keep-mine / merge, then
  **submit a fresh mutation under the new `row_version`** (new `mutation_id`).
- Tracked **on the queue row** (`status='conflict'` + `server_row`) — no separate table. `GET
  /sync/conflicts` is the reconciliation source, not the live store.

---

## 9. The six durability invariants

Get these right and the rest is mechanics ([mobile-09 §4](./mobile-09-client-services-and-invariants.md)):

| # | Invariant | Bug if violated |
|---|---|---|
| **INV-9** | **Cursor advances only after the rows commit** (same tx) | persist cursor → crash → those rows **skipped forever** (silent data loss) |
| **INV-10** | **Mark a mutation applied only after its local effect commits** (same tx) | mark-first → crash → mutation gone from queue but effect never landed (drawer/report mismatch) |
| **INV-5** | **Migrate SQLite before any sync touches it** | first post-update delta applies new columns to an un-migrated table → corruption |
| **INV-11** 🆕 | **Never apply a pulled row over an entity with a pending/conflict mutation** (pending-mutation shadow) | steady-state pull clobbers an optimistic edit → UI reverts/flickers; with a missing `row_version` the edit is **silently lost** |
| push-before-pull | **Flush the queue before pulling** on reconnect | pulling first overwrites local edits / creates needless conflicts |
| additive POS | **Sales/stock/shift are append-only, not optimistic-lock; a sale is one composite mutation** | concurrent sale → false `conflict` → rejected real sale; split sale → **partial sale** committed |

---

## 10. Reconnect & scheduling

```
network restored → SyncScheduler:
  1. PUSH the queue        (flush local writes first → fewer conflicts)
  2. PULL /sync/changes    (drain has_more)
  3. freshness pass        (GET /me/pv; GET /me/subscription if x-subscription-version advanced)
```

- **Push-before-pull**, always.
- **Foreground:** pv heartbeat + scheduled `/changes`. **Background:** drain-only — flush the queue in the
  OS-granted window, **don't poll**. **Terminated:** nothing runs; durable state (INV-9/10) resumes next launch.
- Honor `429 Retry-After` over the local backoff curve.
- Scheduler cadence may scale with wifi-vs-cellular / battery / charging, but it only calls
  `runPush()`/`runPull()` — it never touches the queue or cursors directly.

---

## 11. Backoff & dead-letter

```
transient / 5xx / network  → next_attempt_at = now + min(2^attempts · base, cap)  (jittered)
                             honor server Retry-After (429) over the local curve
attempts > MAX (~7)        → status='dead'  → quarantine OUT of the active queue
                                            → surface in the owner's "stuck items" list
                                            → the rest of the queue keeps flowing
```

- `rejected` (4xx business) → **don't retry**, roll back + notify (logic failure, not transient).
- `conflict` → resolve via the resolver, then re-queue a fresh mutation.
- **Pull-side parity:** a `failed_applies` table records server rows that couldn't apply locally (missing
  FK, schema mismatch) — surface it like the push DLQ.
- Persist diagnostics on each row: `attempts`, `first_failure_at`, `last_failure_at`, `error_code`,
  `error_message` — invaluable for field debugging + the metrics chip.

---

## 12. Freshness piggyback (don't poll permissions separately)

The sync engine is a **delivery channel** for auth/subscription freshness — it routes, never interprets:

- `/sync/delta` returns `snapshot` + `snapshot_signature` + `permissions_version` when the client's pv is
  stale → hand to **SnapshotManager** (monotonic version guard + atomic swap, INV-1/INV-8).
- Every authed response carries `x-permission-version` / `x-subscription-version` → if advanced, the
  **RefreshCoordinator** pulls `GET /me/snapshot` / `GET /me/subscription`.
- `X-Subscription-Warning` (grace) → **SubscriptionManager** updates the banner + the cached
  `access_valid_until` write-gate ([device §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)).

So permissions/subscription reconcile **on the next sync automatically** — the engine just forwards.

---

## 13. Cursors & the horizon

- The cursor is an **opaque HMAC blob** bound to `(user, store)` with µs-precision keyset watermarks —
  **store it verbatim**; never parse it or round-trip through a JS `Date` (truncates µs → breaks the
  keyset, infinite-loop page).
- One **delta cursor per `store_fk`** (`sync_cursor`); per-entity cold-start cursors in `sync_init_progress`.
- A cursor older than **180 days** → `410 SYNC_HORIZON_EXCEEDED` → drop that store's local partition and
  re-run `/sync/initial` (that store only).
- A too-old app build → `410 UPGRADE_REQUIRED` → upgrade wall (distinct from the horizon).

---

## 14. Multi-store partitioning

- **Everything is per `store_fk`** — separate cursor, separate `sync_init_progress`, separate SQLite
  partition ([mobile-06](./mobile-06-multi-store-offline.md)). The snapshot covers **all** stores in one
  document (SecureStore), so the permission switch is zero-network.
- **Switch** = rebind the engine: cached store → instant `/sync/changes` delta; new store → cold start.
- **Last-N eviction** (`local_store_state`): dropping the (N+1)th store deletes its `store_fk` partition +
  its cursor. Pre-sync the last N in the background so a switch is instant offline.
- The rate limiters are per-`(user, store)`, so background-syncing one store can't throttle another.

---

## 15. Failure-handling matrix

| Failure | Retry? | Client behaviour |
|---|---|---|
| Network down / timeout | yes (backoff) | stay usable offline; ambient offline chip |
| `401` access expired | refresh+replay once | transparent (HttpClient single-flight, INV-3) |
| `429` rate-limited | yes (Retry-After) | back off the scheduler; never drop work |
| `5xx` on `/sync/delta` | yes (whole batch) | idempotency makes replay safe → `duplicate` for landed ones |
| mutation `rejected` (4xx) | no | roll back optimistic change + notify |
| mutation `conflict` | no (manual) | resolver → fresh mutation under new `row_version` |
| poison mutation (repeated 5xx) | capped → DLQ | quarantine; queue keeps flowing |
| `410 SYNC_HORIZON_EXCEEDED` | auto | drop partition → cold start (that store) |
| `410 UPGRADE_REQUIRED` | no | upgrade wall |
| apply failure (missing FK) | yes | `failed_applies` (pull DLQ) |
| SQLite migration failed | no → stop | "update/reinstall" wall (INV-5) |

---

## 16. End-to-end sequence

```
launch
  → migrate SQLite (INV-5)
  → resolve + open store → CLAIM_SLOT (online) → OPEN_CONTEXT
  → COLD_START (first time; unlock POS at G1–G3, background G4–G5) → persist next_delta_cursor
READY:
  local write → optimistic apply + enqueue            (one tx)
  scheduler tick →
     PUSH /sync/delta  (priority + dep-sorted, ≤100)  → reconcile results (tx, INV-10)
     PULL /sync/changes → apply + advance cursor       (tx, INV-9) → drain has_more
  every response → route piggybacked snapshot / x-*-version → Snapshot/SubscriptionManager
  reconnect → PUSH then PULL → freshness pass
  410 horizon → drop partition → COLD_START
  410 upgrade → wall
```

**The six rules that make it correct:** (1) cursor advances only after rows commit (INV-9); (2) mark
mutations applied only after the effect commits (INV-10); (3) migrate before sync (INV-5); (4) push before
pull; (5) POS writes are additive/event-sourced, not optimistic-lock — and a sale is **one composite
mutation** ([sync-engine §9.1](./sync-engine.md)); (6) never apply a pulled row over an entity with a
pending local mutation (INV-11, the pending-mutation shadow).
