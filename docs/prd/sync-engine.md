# Sync Engine — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** the complete offline-first sync engine — cold start, delta pull, mutation push,
> cursors, idempotency, conflicts, tombstones, the write models, rate limiting, the outbox, the
> stock ledger, cleanup, and every real-time scenario.
> **Companions:** the **client** counterpart [mobile-11 Client Sync Engine](./mobile-11-sync-engine-client.md);
> client storage & mutation queue [mobile-04 §8C](./mobile-04-storage-and-state.md);
> offline-expiry write-gate [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1);
> POS handlers to build [backend-implementation-plan.md WS-A](./backend-implementation-plan.md).
> **Status:** ✅ built · 🔧 modify · 🆕 new · ⚠️ design flag (from the architecture review). The
> engine is **production-grade for reference data**; the **transactional (POS) write path is not built**.
> **⚠️ Repo status (2026-07-02):** every ✅/"verified" flag refers to the *reference* implementation —
> **none of the sync code exists in this repository yet** (`apps/backend` has no sync module;
> `apps/mobile` has no `infrastructure/sync/`). Treat ✅ as *design intent* until re-verified here.
> This also resolves the contradiction with [mobile-12 §6](./mobile-12-sync-implementation-audit.md)
> ("the order handler exists and wires the ledger"): in **this repo** there is no order handler and the
> stock ledger is not wired — both are to-build.

---

## Table of contents
1. [Overview & principles](#1-overview--principles)
2. [The three endpoints](#2-the-three-endpoints)
3. [Sync entity registry](#3-sync-entity-registry)
4. [Cursor design](#4-cursor-design)
5. [F-SYNC-1 — Cold start (`/sync/initial`)](#5-f-sync-1--cold-start-syncinitial)
6. [F-SYNC-2 — Manifest + parallel cold start](#6-f-sync-2--manifest--parallel-cold-start)
7. [F-SYNC-3 — Delta pull (`/sync/changes`)](#7-f-sync-3--delta-pull-syncchanges)
8. [F-SYNC-4 — Tombstones (deletes)](#8-f-sync-4--tombstones-deletes)
9. [F-SYNC-5 — Mutation push (`/sync/delta`)](#9-f-sync-5--mutation-push-syncdelta)
10. [F-SYNC-6 — Idempotency](#10-f-sync-6--idempotency)
11. [F-SYNC-7 — Conflict resolution](#11-f-sync-7--conflict-resolution)
12. [F-SYNC-8 — Point-in-time entitlement (revocation grace)](#12-f-sync-8--point-in-time-entitlement-revocation-grace)
13. [The two write models — master vs transactional](#13-the-two-write-models--master-vs-transactional)
14. [F-SYNC-9 — Stock as an event ledger](#14-f-sync-9--stock-as-an-event-ledger)
15. [Client mutation queue (priority · backoff · DLQ)](#15-client-mutation-queue-priority--backoff--dlq)
16. [Rate limiting](#16-rate-limiting)
17. [Outbox (server-side events)](#17-outbox-server-side-events)
18. [RBAC filtering & revocation claw-back](#18-rbac-filtering--revocation-claw-back)
19. [Cleanup & retention](#19-cleanup--retention)
20. [Offline-first behaviour & the subscription write-gate](#20-offline-first-behaviour--the-subscription-write-gate)
21. [Real-time scenarios](#21-real-time-scenarios)
22. [Known issues & design flags](#22-known-issues--design-flags)
23. [Business rules](#23-business-rules)
24. [Backend changes required](#24-backend-changes-required)

---

## 1. Overview & principles

The sync engine keeps each store's data on-device (SQLite) and reconciles with the server. Three
endpoints, one cursor protocol, idempotent at-least-once delivery both ways.

**Principles:**
- **Offline-first spine** — the app reads/writes locally; the server is the **reconciler, not the gate**.
- **Per-store partitioning** — all data, cursors, and progress are scoped by `store_fk`; multi-store
  is N independent partitions ([mobile-06](./mobile-06-multi-store-offline.md)).
- **Server-assigned watermarks** — every cursor uses the DB's `modified_at`/`deleted_at`; the client
  clock never participates in the *read* path → **clock-skew-immune pulls**.
- **At-least-once + idempotent** — both pull (client upserts by `guuid`) and push (`mutation_id` ULID)
  tolerate redelivery; nothing is exactly-once.
- **Two write models** (the key design call, §13): **master data = optimistic lock**; **transactional
  data (sales/stock) = additive/event-sourced** — *never conflict-reject a sale.*

---

## 2. The three endpoints

All under `@Controller('stores/:storeId/sync')`, `@StoreContext('param.storeId')`,
`@RequirePermissions({entity:'Store', action:'view'})`, `@SkipTransform()`. Real paths `/api/v1/...`.

| Method | Path | Purpose | Throttle (guard) |
|---|---|---|---|
| GET | `/stores/:id/sync/initial?entity_type=&cursor=&reset=&supported_entity_types=` | cold-start dump, one entity-type per call, paged | **exempt** in the guard; `@Throttle` 30/min |
| GET | `/stores/:id/sync/changes?cursor=&supported_entity_types=` | delta pull (upserts + deletes since cursor) | 60/min |
| POST | `/stores/:id/sync/delta` (HTTP 200) | **push** mutations **+ pull** changes in one round trip | 20/min + 100 mutations/5min |
| GET | `/stores/:id/sync/manifest` 🆕 | per-entity counts + cursors for parallel cold start | (add) |
| GET | `/stores/:id/sync/conflicts` · PATCH `/:mutationId` | list / resolve conflicts | — |
| GET | `/time` (`@Public`) | server clock for skew correction | — |

**Page size:** `DELTA_PAGE_SIZE = 200` rows for delta; **cold start uses a larger
`INITIAL_PAGE_SIZE = 1000–2000`** 🆕. 200-row pages under the 30/min throttle cap `/sync/initial` at
~6k rows/min *no matter how many parallel workers run* (the limiter is shared per `(user, store)`), so
the bulk-dump page size — not parallelism — is the primary cold-start lever (§6). ⚠️ doc-comments say
"≤1000" — stale; align them with the two constants.

---

## 3. Sync entity registry

The **`SyncFilterRegistry`** (dependency-ordered) is the authoritative list of synced entities.
Cold-start iterates in `dependencyOrder`; mutation handlers are a separate registry.

| Order | entity_type | Pull (filter) | Push (mutation handler) |
|---|---|---|---|
| 0 | `store` | ✅ | — |
| 2 | `unit`, `store_device_access` | ✅ | — |
| 5 | `lookup`, `payment_method` | ✅ | `lookup` ✅ |
| 6 | `taxrate` | ✅ | — |
| 8 | `staff` | ✅ | — |
| 10 | `product` (+`product_case`) | ✅ | ✅ |
| 15 | `paymentaccount` | ✅ | ✅ |
| 20 | `customer` | ✅ | ✅ |
| 21 | `supplier` | ✅ | ✅ |
| 30/31 | `order`, `order_item`, `order_payment` 🆕 | ✅ read — **`order_payment` MUST ship in the same registry change as the order handler**: without it a second device sees the sale but not how it was paid → shift cash reconciliation, day-close totals, and refunds are wrong on every other device | **🆕 missing — build (WS-A) as ONE composite `order` mutation (§9.1)** |
| 40 | `shift` | ✅ read | **🆕 missing** |
| 70–76 | `stock_take(+line)`, `stock_adjustment(+line)`, `fifo_cost_layer`, `stock_history`, `stock_event` | ✅ read | **🆕 missing** |
| — | `shift_session`, `shift_event`, `cash_movement`, `audit_log` | not synced yet | **🆕 missing** (shift is event-sourced — [shifts §15C](./shifts-and-cash-management.md)) |

> **Writable today = product/customer/supplier/paymentaccount/lookup only.** Pushing a sale/shift/cash
> → `rejected: UNKNOWN_MUTATION`. This is the #1 gap (§24).

**Dependency groups** (for parallel cold start, §6):
```
G1 reference  store · unit · taxrate · payment_method · lookup · store_device_access · staff
G2 parties    customer · supplier
G3 catalog    product (+product_case) · paymentaccount
G4 inventory  stock_take(+line) · stock_adjustment(+line) · fifo_cost_layer · stock_history · stock_event
G5 txn        order · order_item · order_payment · shift · shift_session · cash_movement
```

---

## 4. Cursor design

Opaque, signed, version-4 cursor. Wire format `base64url(payload).base64url(hmac)`.

- **HMAC** — domain-separated key `HMAC(rootSecret,"sync-cursor-hmac-v1")`; verified constant-time.
- **Binding** — payload embeds `{v:4, u:userId, s:storeId, ia:issuedAtMs, e:{entity:{ts,id}}, t?:{ts,id}}`.
  Decode **rejects** on `v≠4`, `u/s` mismatch (cross-tenant replay), or `ia>180d` → epoch resync.
- **µs precision (critical)** — per-entity watermarks carry `modified_at` as a **6-decimal µs string**
  (`to_char(... 'US' ...)`), passed **verbatim** through the cursor (never a JS `Date` round-trip,
  which would truncate to ms and collapse the keyset tiebreaker → **infinite-loop page**). ✅ handled.
- **Keyset boundary** — `modified_at > cursor OR (modified_at = cursor AND id > cursorId)`,
  `ORDER BY modified_at ASC, id ASC`. No skips on identical timestamps, no infinite loop.
- **Horizon (keyed on `ia`, NOT per-entity watermark age)** 🔧 — the 180-day check is on the cursor's
  **`issuedAtMs` (`ia`)**, which is **re-minted on every `/sync/changes` and `/sync/delta` response**, so
  an actively-syncing client's cursor never ages out. Only a client **offline > 180 days** (never
  re-issued) trips **`410 SYNC_HORIZON_EXCEEDED`** → restart at `/sync/initial`. Tombstone retention
  (195d, §19) **exceeds** this horizon so any cursor that passes the `ia` check can still find every
  tombstone it needs.
  > ⚠️ **Do NOT key the horizon on the oldest per-entity watermark `ts` (S-31).** A low-churn entity
  > (`unit`, `taxrate`, `lookup`) legitimately unchanged for months carries an ancient `ts` while the
  > store syncs daily — keying on `ts` fires a **spurious `410` + full-catalog re-pull for a store that
  > simply didn't edit its reference data** (the normal state of reference data). A static entity with no
  > deletes needs no `410` at all. The "oldest stream" phrasing in earlier drafts was wrong; the horizon
  > is `ia` only.
- **Future-timestamp clamp** — a forged future cursor is clamped to server-now, never skips real rows.

> ⚠️ The µs-format contract is **unenforced by types** — a hand-rolled filter returning ms precision
> reintroduces the infinite loop. **Add a shared helper / runtime assert** (§22).

---

## 5. F-SYNC-1 — Cold start (`/sync/initial`)

**When:** first time a store is opened (must be **online**), or after a local DB wipe (`reset=true`),
or after a `410` horizon.

### Flow
```
loop:
  GET /sync/initial?entity_type=&cursor=
    → server picks the first entity in dependencyOrder whose phase ≠ 'completed'
      (or the explicit entity_type)
    → returns { entity_type, upserts[], has_more, page_cursor,
                all_entities_complete, remaining_entity_types[], next_delta_cursor, estimated_total? }
  client upserts rows into SQLite (store_fk=:id), persists page_cursor
  repeat until all_entities_complete === true
  persist next_delta_cursor  ← the global delta cursor for the first /sync/changes
```

### Mechanics (✅ correct)
- **One entity-type per call, `INITIAL_PAGE_SIZE` (1000–2000) rows/page** 🔧 (was 200 — see §2: the
  page size, not parallelism, is the cold-start lever), keyset on `id ASC` (`page_cursor = last row id`,
  prefixed `${entity_type}:` so a cursor can't be replayed against another entity).
- **Resumable** — progress tracked in `sync_init_progress` PK `(store_fk, device_fk, entity_type)`
  with `phase ('in_progress'|'completed')` + `cursor`. A crash mid-cold-start resumes from the last
  persisted page (deterministic keyset → same rows for the same cursor).
- **`next_delta_cursor` is anchored at `sessionStartedAt`** (the *start* of the cold-start), **not**
  server-now → **a row written during the (long) cold-start is caught by the first delta poll.** Cost:
  harmless idempotent re-delivery of rows both dumped and modified during the window.
- **`estimated_total`** (first page only) drives the progress bar.

### Loading (mobile-08)
**B full-screen until G1–G3 (config + catalog) are in → unlock POS**, finish G4–G5 in **D** background.
Don't block to 100%.

### ⚠️ Flag — `sessionStartedAt` inheritance
When a **new entity type** ships in a new app version and the device is **already complete** (no
`reset`), the new entity inherits the **old session's** `sessionStartedAt` (possibly months old) → can
anchor its delta cursor >180d → **spurious `410` / forced full resync**. **Fix:** scope
`sessionStartedAt` per cold-start *session*, or reset it when starting a brand-new entity on an
otherwise-complete device (§22).

---

## 6. F-SYNC-2 — Manifest + parallel cold start 🆕

**Goal:** turn the sequential one-entity-per-call cold start into a parallel, progress-driven one.

```
GET /sync/manifest → {
  schema_version,                 // server's data-schema generation
  minimum_client_version,         // oldest app build allowed to sync this schema
  entities: [ {
    entity_type, dependency_order,
    estimated_count,              // drives the progress bar
    latest_watermark,             // newest modified_at in this entity for this store
    checksum,                     // content hash of the entity set (skip-if-unchanged)
    entity_version,               // bumps when this entity's shape/semantics change
    initial_cursor
  } ]
}
client: if app_build < minimum_client_version → STOP, force upgrade (see §6.2)
        for each entity: if local checksum == manifest checksum AND local entity_version
            matches → SKIP download (nothing changed since last cold start / schema bump)
        spawn bounded-concurrency (3–4) downloaders for the remaining entities
        download in parallel WITHIN a dependency group; gate BETWEEN groups on FKs
        APPLY in dependency order locally (parallel fetch, ordered insert)
        progress bar from manifest counts; respect 429/Retry-After
```
**Why:** a 100k-product store today = ~500 sequential 200-row pages against a 30/min limit (~17 min).

> ⚠️ **Corrected math:** parallel workers do **not** beat the throttle — the 30/min budget is shared per
> `(user, store)`, so wall-clock is capped at ~6k rows/min regardless of concurrency. The real levers, in
> order: (1) **raise `INITIAL_PAGE_SIZE` to 1000–2000** (§2); (2) raise the `/initial` throttle; (3) only
> then parallelism, for latency-hiding. The manifest's lasting value is **§6.1 skip-unchanged + §6.2
> forced upgrade**, not raw speed.

> ⚠️ **Checksum cost:** a content hash over a 100k-row entity set is too expensive to compute per
> manifest request. **Maintain it incrementally** (bump on every write, in-tx) or substitute
> `(latest_watermark, estimated_count)` — near-equivalent, catches everything except pathological
> same-timestamp rewrites.

### 6.1 Skip-unchanged after a schema bump 🆕
The per-entity **`checksum` + `entity_version`** let an upgraded client **download only the entities that
actually changed**, instead of a full `reset` re-pull. An entity whose local checksum still matches the
manifest is left untouched — no re-pull of an unchanged 100k-product catalog just because *one other*
entity's shape changed. This is the manifest's main steady-state payoff, not just first-run parallelism.

### 6.2 Minimum client version → forced upgrade 🆕
The manifest carries **`minimum_client_version`**. If the app build is older, cold start **stops** and the
client shows an **upgrade-required** wall — it never interprets a schema it can't model. The gate is also
enforced on **`/sync/initial` and** the steady-state endpoints: a too-old client hitting
`/sync/initial`, `/sync/changes`, or `/sync/delta` gets
**`410 UPGRADE_REQUIRED`** (distinct from `410 SYNC_HORIZON_EXCEEDED`) → routes to the upgrade wall,
never silently corrupts local data against a newer schema.

---

## 7. F-SYNC-3 — Delta pull (`/sync/changes`)

**When:** steady state (foreground poll / on reconnect), and folded into every `/sync/delta` response.

```
GET /sync/changes?cursor=<delta cursor>
  → { changes: { entity_type: { upserts[], deletes[] } }, sync_cursor, has_more, server_time }
client: apply upserts (idempotent by guuid) + deletes (tombstones); persist sync_cursor; re-poll if has_more
```

### Mechanics (✅ correct)
- **Per-entity watermark** `(lastSyncedAt, lastSyncedId)` advanced independently per entity.
- **No-gap advance (the key fix):** on a *drained* page advance only to the **last row actually
  returned**, never to the pre-query `serverNow`; on an *empty* page keep the previous cursor. So a row
  committed during the read window is **never skipped** — it's picked up next poll.
- **`perEntityLimit = floor(200 / N filters)`** — fair sharing across entities.
- **`has_more`** = OR across all entities + tombstone page-full → client re-polls until false.

> ⚠️ **Large single-entity backlog is slow:** with many entities, `perEntityLimit` is small (e.g. 10),
> so a 50k-row backlog drains ~10 rows/round-trip. Acceptable but worth knowing (§22).

> **Client apply rules (normative — [mobile-11 §5](./mobile-11-sync-engine-client.md)) 🆕:** within one
> page, an entity's **upserts apply before its deletes** (a row created+deleted in the same window must
> end deleted), and the client **never applies a pulled row over an entity with a pending/conflict
> mutation in its local queue** (the **pending-mutation shadow**, INV-11). Push-before-pull only protects
> the reconnect sequence — in steady state a pull can land between a local optimistic write and its push
> and would clobber the edit (UI reverts, then flickers back on the next pull; combined with a missing
> `expected_row_version` the edit is silently lost).

---

## 8. F-SYNC-4 — Tombstones (deletes)

Deletes propagate via a **shared tombstone stream** (not per-filter), merged into
`changes[entity].deletes[]`.

- **Row shape:** `{ id, guuid, deleted_at, deleted_by_user_fk, deleted_by_display_name, hard_delete }`.
  ⚠️ `deleted_by_*` ship on every delete — pure sync only needs `guuid`+`hard_delete`; **move "who
  deleted" to an activity endpoint** (mobile-02 §3e).
- **One shared `(deleted_at, id)` watermark**; **same no-gap advance** as upserts → a delete committed
  during the read window is **never skipped** (a missed delete = a resurrected row, treated as worse).
- **Idempotent** — unique `(entity_type, entity_guuid)`; re-delete updates `deleted_at` (re-surfaces
  via the keyset, not skipped).
- **`hard_delete`** → client purges the row entirely; soft → tombstone locally.
- **Written in the same tx as the business delete** (mandatory `tx` param on the tombstone repo).
- **Retention 195 days** 🔧 — retention must **exceed** the 180-day horizon
  (`TOMBSTONE_RETENTION = SYNC_HORIZON + 15d buffer`). ⚠️ The previous spec (179d, a "1-day buffer
  *inside* the horizon") was **inverted**: a cursor aged 179–180 days passed the horizon check (< 180d,
  no `410`) but the tombstones it needed were already purged → deletes never delivered → **silently
  resurrected rows** — exactly the failure class this section calls "worse than a missed upsert". The
  invariant is: *any cursor that survives the horizon check can still find every tombstone it needs.*

---

## 9. F-SYNC-5 — Mutation push (`/sync/delta`)

The combined **push + pull**: submit local writes, get per-mutation results **and** the next delta page.

### Request (`SyncDeltaSchema`)
```
{ sync_cursor?, permissions_version?, supported_entity_types?,
  mutations: [ {
    mutation_id,            // client ULID = idempotency key
    entity_type, action,    // create|update|delete
    payload,
    expected_row_version?,  // REQUIRED for update (optimistic lock)
    client_modified_at?,    // ISO — queue time; drives point-in-time grace + skew check
    parent_guuid?           // cascade-fail children if parent fails
  } ]   // max 100
}
```

### Response
```
{ mutation_results: [ applied | duplicate | rejected | conflict ],
  changes, sync_cursor, has_more, server_time,
  snapshot?, snapshot_signature?, permissions_version? }   // freshness piggyback
```
Per-mutation outcome:
- `applied` `{ entity_id?, entity_guuid?, row_version?, data? }`
- `duplicate` `{ cached }` (the original result, replayed)
- `rejected` `{ code, message }` (e.g. `PERMISSION_DENIED`, `SHIFT_NOT_OPEN`, `UNKNOWN_MUTATION`, `SERVER_ERROR`)
- `conflict` `{ server_row, message }` (stale `row_version`)

### Submit loop (✅ correct — robust isolation)
1. Batch ≤ **100** (Zod + defensive 400).
2. **Per-mutation transaction** (no outer batch tx): mutation #5 failing rolls back only #5; #1–#4 stay
   committed; #6–50 proceed.
3. **Preflight guards, in order:** idempotency dedupe (before tx) → clock-skew (**clamp, don't
   reject** — §12) → row-version-required → handler-exists → authorization (current perms, then
   point-in-time grace, §12).
4. A `5xx` (e.g. idempotency-race `503`) **aborts the whole HTTP call** (client retries the batch);
   any other failure → per-mutation `rejected`, batch continues.

> **Dispatcher, not a `switch`:** handler resolution goes through the **`MutationHandlerRegistry`** (an
> entity→handler map), so adding `order`/`shift`/`cash` handlers (WS-A) is registry registration, not
> editing a giant `switch(entity)` in the sync service. The controller stays thin: dispatch → handler →
> result. Keep it that way as POS handlers land.

### 9.1 Composite sale mutation — one sale = ONE mutation 🆕🔴

**Per-mutation transactions make partial sales possible** if a sale ships as separate `order` /
`order_item` / `order_payment` mutations linked by `parent_guuid`:

- The `order` can commit while `order_item` #2 fails (validation, poison payload, FK).
  `PARENT_FAILED` cascades only on *parent* failure — a **child failing after the parent committed**
  leaves a committed order missing an item or its payment → revenue / GST-report mismatch, the worst
  bug class for a POS.
- It builds the most critical path on the mechanism with the most known holes (the S-3 cascade gaps,
  plus the client doesn't enforce `parent_guuid` cross-batch — [mobile-12 gap #5](./mobile-12-sync-implementation-audit.md)).
- **Rate-limit pressure:** 100 mutations/5 min = 20/min sustained. A sale as ~5–8 mutations means a
  busy counter (3–4 sales/min at rush) exceeds the budget on legitimate traffic — the queue grows
  exactly when the shop is busiest.

**Design rule:** `entity_type:'order'` is a **composite aggregate** — the payload embeds `items[]`,
`payments[]`, and the implied stock deltas. The handler applies **everything in one transaction**:
insert order + items + payments, append the `stock_event` rows (§14), write the idempotency row —
**all-or-nothing**. Same for shift close: `SHIFT_CLOSED` event + frozen `closing_snapshot` = one
mutation ([shifts §15C](./shifts-and-cash-management.md)). `parent_guuid` remains only for genuinely
**cross-aggregate** links (Customer→Order). This makes partial sales impossible, shrinks S-3 to
non-critical paths, cuts mutation volume ~6×, and gives the DLQ a natural unit ("this *sale* is
stuck", not "mutation 4 of 7"). The additive/event-sourced concurrency model (§13) is untouched —
this is about **transaction boundaries**, not concurrency semantics.

> 🆕 **Per-mutation payload cap (S-36):** the composite aggregate has a `≤100 mutations`/batch cap but
> needs a **per-mutation payload / line-count cap** too — a 500-line B2B order is one multi-MB mutation
> and one long tx. Bound `items[]` / `payments[]` length **and** raw body size so a wholesale order can't
> blow the request/tx budget; split genuinely huge orders at the client.

### Parent-failed cascade (`parent_guuid`)
A `failedGuuids` set: if a mutation's parent is in it → `rejected: PARENT_FAILED` (no tx); the child's
own guuid is added so grandchildren cascade.
> ⚠️ **Two gaps** (matter once `order`→`order_item` ships): (a) **order-dependent** — relies on the
> client sending parent-before-child in one batch (no topological sort); (b) a parent **rejected on a
> prior batch** returns as `duplicate` on retry and is **not** added to `failedGuuids` → children
> don't cascade and run against a never-applied parent. **Fix the cascade to be dependency-sorted and
> treat cached-rejected parents as failed** (§22).

---

## 10. F-SYNC-6 — Idempotency

- **Key** = client ULID `mutation_id`; DB PK is **compound `(mutation_id, user_fk)`** (cross-tenant-safe
  at the DB, not just in code).
- **Written in the SAME tx as the business write** → a crash between business-commit and idempotency-write
  is impossible. *This is the single most important correctness property.* ✅
- **Duplicate** → returns the cached original outcome (with stale `server_row` stripped from cached
  conflicts).
- **TTL:** applied/rejected/duplicate = **30 days** (matched to refresh-token life); conflicts = **5 min**
  (so a post-merge resubmit isn't wrongly returned as a stale `duplicate`).
- 🆕 **TTL floor vs the client DLQ (S-35):** the applied/rejected TTL **must exceed the maximum time a
  mutation can sit in the client DLQ (§15) before a manual retry** — not just "≈ refresh-token life". A
  sale quarantined in the DLQ and retried by the owner **after** its idempotency row was purged
  **re-executes → double sale**. Size the TTL to `max(refresh-token life, DLQ max-dwell + margin)`, or
  have the client **refuse to replay a `mutation_id` older than the server TTL**.
- **Race (two concurrent identical mutations):** both run their handler; `ON CONFLICT DO NOTHING` on the
  idempotency insert; loser rolls back + polls for the winner's result; poll exhaustion → **`503`** (the
  client retries → hits the now-committed row → `duplicate`). ✅ correct (a `rejected` would risk silent
  data loss).

---

## 11. F-SYNC-7 — Conflict resolution

- **Detection:** optimistic locking. `update` **must** carry `expected_row_version` (else
  `SYNC_MISSING_ROW_VERSION`). The handler reads + version-gated-updates in **one tx** (no TOCTOU);
  zero rows updated → `kind:'conflict'` with `server_row` (the live row).
- A `local_sync_conflict` row is written in-tx; surfaced via **`GET /sync/conflicts`**.
- **Resolution = bookkeeping + client rebase** — `/sync/conflicts/:mutationId` only flips status
  (`resolved`/`discarded`) + note. The **server does not merge**; the client picks take-server /
  keep-mine / merge-locally, then **re-submits a fresh mutation under the new `row_version`**.
- **Sound for master data** (customer/product edits). ⚠️ **No disjoint-field auto-merge** (two cashiers
  editing different fields of one customer both conflict — noisy at scale). And critically: **this model
  must NOT be used for sales/stock** (§13).

### 11.1 Typed conflicts ✅ (present in `SyncDeltaResponseDto` — verify handlers populate it)
A single "conflict" channel conflates three very different client experiences. The `conflict_type`
field exists on the DTO — ensure every non-`applied` rejection populates it so the client routes
UX correctly instead of showing one generic "sync conflict":

| `conflict_type` | Cause | Client UX |
|---|---|---|
| `MASTER_DATA` | stale `expected_row_version` (optimistic lock) | rebase: take-server / keep-mine / merge → resubmit |
| `VALIDATION` | payload fails schema / field rules | fix the input, then resubmit (not a "conflict") |
| `BUSINESS_RULE` | server invariant blocked it (e.g. `SHIFT_NOT_OPEN`, `SUBSCRIPTION_LAPSED_AT_WRITE`, oversell-blocked) | explain the rule; usually un-resubmittable as-is |

The wire shape gains `conflict_type` on `conflict`/`rejected` results; `GET /sync/conflicts` filters by it.
This is purely additive — existing `MASTER_DATA` behaviour (§11) is unchanged.

---

## 12. F-SYNC-8 — Point-in-time entitlement (revocation grace)

The strongest part of the engine — **and the template for the subscription `access_valid_until` gate.**

- A write is authorized if the user is authorized **now**, OR was authorized **at the instant it was
  queued** (`client_modified_at`) — so a sale rung before a cashier's access was revoked still applies.
- **`wasCrudAuthorizedAt(asOf)`** checks the grant + role assignment were active *as of* `asOf`
  (`revoked_at > asOf`, not `IS NULL`).
- **Three-layer backdate defense:** (1) future-skew at preflight (±5 min) — 🔧 **clamp
  `client_modified_at` to server-now and apply, don't reject**: a device whose clock runs 10 min fast,
  offline long enough for ClockService alignment to go stale, queues *honest* sales stamped "in the
  future"; rejecting them destroys real revenue for a clock error (same principle as "never
  conflict-reject a sale" — rejection is reserved for privilege, not honesty); (2) future-timestamp
  **reject inside the grace path** (backdating grants privilege there — stay strict);
  (3) **`effectiveAsOf < sessionCreatedAt` reject**
  (server-trusted session time — a mutation can't predate its own device session). Plus a **30-min grace
  clamp** caps how far back any honored mutation reaches.
- **Subscription reuse caveat:** copy this pattern for the `access_valid_until` gate, but use a
  **billing-specific grace constant** (likely the 7-day subscription grace, not `REVOCATION_GRACE_WINDOW_MS`),
  and gate **store-wide at queue time**, not per-entity.

---

## 13. The two write models — master vs transactional

**🔴 The key architectural decision.** Two different write primitives, by data type:

| | **Master / reference data** | **Transactional / POS data** |
|---|---|---|
| Entities | product, customer, supplier, paymentaccount, lookup | **order, order_item, order_payment, stock (`stock_event`), shift (`shift_event`), cash_movement, audit_log** |
| Concurrency model | **Optimistic lock** (`expected_row_version`) | **Additive / event-sourced — append-only** |
| Concurrent offline edit | → **conflict** → manual rebase (correct) | → **both apply** (a sale is NOT a conflict) |
| Example | two cashiers edit a customer's phone → conflict | two cashiers sell the last unit → **both sales recorded**, stock reconciles |
| Truth vs projection | the row **is** the truth | the **append-only log** is truth; the mutable row (`product.stock_quantity`, `shift_session.status/variance`) is a **recomputable projection** |
| Status | ✅ built | **🆕 to build (WS-A)** — stock ledger ([§14](#14-f-sync-9--stock-as-an-event-ledger)) + shift timeline ([shifts §15C](./shifts-and-cash-management.md)) |

> **DO NOT copy the customer-handler optimistic-lock pattern onto orders/stock.** A concurrent stock
> decrement is **not** a `row_version` conflict — it's two valid additive events. Sales are append-only
> inserts; stock is a signed-delta ledger (§14). Getting this primitive wrong = rejected sales.
> And a sale is **one composite mutation** (§9.1) — additive *between* devices, atomic *within* the
> aggregate.

---

## 14. F-SYNC-9 — Stock as an event ledger

**The correct, conflict-free model — schema exists, but is currently unwired.**

- **`stock_event`** = append-only signed-delta ledger. Authoritative stock = `SUM(delta)`.
  🔴 **The recomputed cache does NOT live on the synced `product` row (S-32).** Storing `stock_quantity`
  on `product` and recomputing it nightly bumps `product.modified_at` → **every product enters the delta
  stream → all devices re-pull the entire catalog every morning** (unbounded write-amplification + a
  3 AM sync storm straight into the small `perEntityLimit`/20-per-min drain). Keep the cache in a
  **separate `product_stock_cache` table outside the sync registry** (or recompute the column **without
  touching `modified_at`**), so a reconciliation pass never pollutes the change stream. The cache is a
  server-side read convenience only; the client never trusts it (client rule below).
- Two offline `-1` appends (different `guuid`s) **never collide** → you let stock go to `−1` and
  **reconcile**, rather than blocking/conflicting at write time. This is the CRDT-style answer to oversell.
- 🆕 **The oversell window equals `stock_event` propagation latency (S-33).** "Let it go negative and
  reconcile" is only as safe as how fast device B sees device A's appends. Those propagate via the delta
  pull at `perEntityLimit = floor(200 / N)` (~10 rows/round-trip with many entities) under the shared
  20/min `/delta` budget — i.e. **slowest exactly at rush hour**, which is when concurrent selling
  happens. Give `stock_event` a **dedicated drain lane / higher per-entity floor** (not the shared
  fair-share divisor) so live stock across counters stays fresh when it matters most; rate-limiting must
  not widen the very window the ledger exists to reconcile.
- **`stock-reconciliation` job** recomputes the cache + **detects oversell** (`SUM < 0`).
  ⚠️ today it only **logs** oversell — should **surface it actionably** (alert/flag the owner).
  🆕 **Detection must run against a "synced-through" watermark, not a wall clock (S-34).** `SUM(delta)`
  is only authoritative once **all** devices' events are collected; an offline device can carry days of
  events, so a fixed nightly `SUM < 0` check races device sync → **false oversells** for stores with a
  lagging device and **missed real ones** until that device syncs. Gate detection on
  `T = min(last_sync_at across the store's active devices)` and evaluate oversell only for events
  `≤ T`; surface "pending — device offline" for the rest instead of a false alarm.
- **⚠️ `StockEventService.recordDelta` has ZERO callers today** — the ledger is dormant. Live stock is a
  **mutable `product.stock_quantity` + optimistic lock**, which **conflict-rejects** the 2nd concurrent
  offline sell instead of summing both. **Wire the ledger when building the order/stock handlers** (§24).
- **Client display rule 🆕:** the client's displayed stock is **always the local projection**
  `SUM(stock_event.delta)` (synced events + local pending appends). The `stock_quantity` **column on a
  pulled `product` row is ignored** — it is the server's stale (nightly-recomputed) cache; upserting it
  over the local projection makes displayed stock **jump backwards** past locally-appended ledger events
  between reconciliations, then "correct" later. The pulled column may at most seed the base for a store
  with no local events.

---

## 15. Client mutation queue (priority · backoff · DLQ)

The on-device outbound queue (SQLite) — see [mobile-04 §8C.2a](./mobile-04-storage-and-state.md).

- **Two orthogonal mechanisms — don't conflate them:** numeric **priority** decides *scheduling order*
  (what drains first under a poor connection); **`parent_guuid`** (§9) is the *dependency graph* (a child
  never applies before/without its parent — Customer→Order→Item→Payment). Priority is best-effort UX;
  `parent_guuid` is correctness. Extend `parent_guuid` for new dependencies — do **not** build a second
  dependency mechanism on top of priority.
- **Priority tiers** (drain high→low; **FK/dependency order wins within a tier**):
  HIGH `order/payment/refund` · MEDIUM `shift/cash/stock/inventory` · LOW `audit/analytics`.
  Sales **never starve** on a poor connection.
- **Backoff** — exponential + jitter on transient/5xx; honor server `Retry-After` (429).
- **Dead-letter** — after N attempts (~7) → `status='dead'`, **quarantined** out of the active queue,
  surfaced to the owner; the rest of the queue keeps flowing (one bad sale never blocks the day).
- `rejected` (4xx business) → **don't retry**, roll back optimistic change + notify; `conflict` →
  resolve via `/sync/conflicts` then re-queue.
- **Server-side parity (🆕):** the server should also cap retries on a permanently-poison mutation —
  today a 500-ing mutation re-runs its handler+tx on **every** sync forever (§22).
- **Diagnostic columns (🆕):** each queue row persists `attempts`, `next_attempt_at`, **`first_failure_at`,
  `last_failure_at`, `error_code`, `error_message`** — invaluable for field debugging and for tuning retry
  policy (which mutation type poisons, how long it's been stuck, the exact server reason). These also feed
  the owner-facing DLQ review screen.

---

## 16. Rate limiting

**Two layers** (both verified against the real backend — api-reference §5):

1. **`SyncRateLimitGuard`** — ✅ **correctly keyed per-`(user, store, endpoint)`**
   (`sync_rate_limit:{userId}:{storeId}:{endpoint}`). `/sync/initial` exempt · `/changes` 60/min ·
   `/delta` 20/min. `/sync/pull`/`/sync/push` are **stale comments, not live routes** — no bug there.
   ⚠️ Fail-open is **narrow** (only `ECONNREFUSED`) → other Redis errors hard-500 sync.
2. ✅ **FIXED — `checkMutationRateLimit`** is now keyed `sync_mutations:{userId}:{storeId}` — includes storeId.
   Two stores of one operator no longer share the mutation budget (verified api-reference §5).
3. 🆕 **Key the sync limits per-`(user, store, device)`** — real small-retail usage (this market
   especially) is **one owner login on 2–3 counter devices**. Keyed per `(user, store)`, those counters
   *share* the 20/min `/delta` and 100/5min mutation budgets and throttle each other exactly at rush
   hour. Device identity is already first-class in the auth model (device sessions) — add `deviceId` to
   the key; keep any abuse ceiling per user.

> ⚠️ Triple-stacked limiters (guard + `UserThrottlerGuard` + `@Throttle`) with inconsistent windows —
> works, hard to reason about; consolidate (§22).

---

## 17. Outbox (server-side events)

**Transactional outbox** — domain events written **in the same tx** as the business change, relayed to
in-process `@OnEvent` consumers (analytics/search/notifications).

- **Relay:** 5s poll, two-phase claim (`SELECT … FOR UPDATE SKIP LOCKED` + 30s lease, commit, then
  dispatch outside the tx) → multi-instance-safe.
- **At-least-once** — consumers **must dedup on `event_id`** (UUIDv7).
- **Backoff** — exponential + jitter, 8 attempts → **dead-letter** (`dead_lettered_at`, excluded from the
  due index, kept for operator review).
- **Ordering** — roughly insertion order (`id ASC`) but **not** strict per-aggregate (no
  `aggregate_id` serialization) — fine for independent events; a problem only if a consumer needs ordered
  replay.
- **Caveat** — dispatch is **in-process** `EventEmitter2`; "downstream" = in-process handlers, not an
  external broker (this relay becomes the bridge if anything moves out-of-process later).

---

## 18. RBAC filtering & revocation claw-back

- **Per-request permissions** resolved once (live `effectivePermissions`, not the JWT snapshot) and
  reused for all entities in that call.
- **Entity-type-level filter** — each filter returns an **empty page** if the user lacks `view` on that
  entity; row-level RBAC is opt-in per filter (`store_fk` scoping only in the generic filter).
- ⚠️ **No revocation claw-back on the pull side:** if `view` on an entity is revoked mid-sync, the next
  page is empty AND the entity is marked `completed`, so **already-synced rows stay stranded on-device**
  (data-exposure-after-revocation). **🆕 Add:** on `permissions_version` change, the client **purges
  entities it no longer has `view` on** (§22).
- 🆕 **Purge vs the pending queue:** the claw-back purge must define what happens to **pending mutations
  against a purged entity** — purging rows but leaving the queue pushes against locally-deleted
  entities; purging both silently drops queued work. Rule: **reject-locally-with-notice** (mirror
  `PERMISSION_DENIED`) — purge the rows, mark the queue rows `rejected` + notify; never drop silently.

---

## 19. Cleanup & retention (✅ safe by construction)

| Job | Schedule | Retention | Safety |
|---|---|---|---|
| Tombstone cleanup | daily 3 AM | **195 days** 🔧 | retention **exceeds** the 180-day horizon by a 15-day buffer → any cursor that passes the horizon check can still find every tombstone it needs. ⚠️ the old 179d spec was **inverted** (see §8) — a 179–180d cursor passed the horizon but its tombstones were purged → resurrected rows |
| Idempotency cleanup | daily 3 AM | **30 days** | matched to refresh-token life; read-time TTL enforced, so cleanup is space-only |
| Outbox cleanup | daily 4 AM | published rows **> 7 days** | dead-lettered rows **excluded** (kept for review) |

All use a distributed `cronLock` (single-instance), staggered to spread DB load.
⚠️ The **180-day horizon is triplicated** across 3 files (changes service, cursor codec, cleanup) —
**hoist to one shared constant and encode the relationship, not magic numbers**:
`TOMBSTONE_RETENTION = SYNC_HORIZON + RETENTION_BUFFER` (drift → premature `410`s or silent
resurrections).

---

## 20. Offline-first behaviour & the subscription write-gate

- **Everything works offline** — read from SQLite; writes queue and push via `/sync/delta`. Open shift,
  ring a sale, take cash, close — all offline ([shifts §14](./shifts-and-cash-management.md)).
- **Reconnect:** **push queue first, then pull** (flush local writes before pulling → fewer conflicts) →
  update versions → silent refresh.
- **Subscription lapse mid-shift:** the [§30 write-gate](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)
  — client blocks new sales once cached `access_valid_until` passes; server **accepts offline sales
  stamped before it** (`client_modified_at`), rejects later ones (`SUBSCRIPTION_LAPSED_AT_WRITE`). This
  reuses the §12 point-in-time pattern.

---

## 21. Real-time scenarios

| Scenario | Verdict |
|---|---|
| Two devices cold-start same store | ✅ progress PK `(store, device, entity)` — independent |
| Row created *during* cold start | ✅ caught (delta anchored at `sessionStartedAt`) |
| Client crashes mid-cold-start | ✅ resumes (per-page persisted, deterministic keyset) |
| Offline 200 days → horizon | ✅ `410 SYNC_HORIZON_EXCEEDED` → `/sync/initial` |
| Clock skew (read path) | ✅ immune (server-assigned watermarks) |
| Row updated rapidly (watermark thrash) | ✅ keyset on `(modified_at, id)`; latest state delivered once |
| Same `mutation_id` retried after timeout | ✅ `duplicate` — no double-apply (same-tx idempotency) |
| Two cashiers edit same customer offline | 🟡 conflict detected, no data loss; **no disjoint-field merge** |
| **Two offline devices sell last unit** | 🔴 **conflict-rejects 2nd sale today** — needs the additive ledger (§14) |
| Mutation references a failed parent | 🟡 correct only same-batch/parent-first/fresh-fail; gaps §9 |
| Clock-skewed backdate to dodge revoke | ✅ closed (3-layer defense, §12) |
| Poison 500 mutation | 🟡 contained but **re-runs forever** (no server DLQ cap) |
| New entity added in app upgrade (no reset) | 🟠 `sessionStartedAt` inheritance → possible spurious full resync |
| Two stores of one user cold-start | ✅ pull independent · ✅ push **mutation-count** budget per-`(user, store)` — fixed |
| Outbox publisher crashes mid-batch | ✅ re-published (lease expiry), never lost |
| Tombstone cleaned while a 179.5-day device needs it | ✅ safe **after the §8 fix** (195d retention > 180d horizon). ⚠️ the old 179d spec silently resurrected rows for any cursor aged 179–180d |
| Idempotency key expired, client retries | 🟡 re-executes; safe given 30-day TTL ≈ refresh-token life |
| **Pull lands between a local edit and its push** | 🔴 would clobber the optimistic row → UI reverts, then flickers; **pending-mutation shadow (INV-11) required** (§7) |
| **Child of a committed order fails (partial sale)** | 🔴 possible under per-mutation tx + `parent_guuid` → **composite sale mutation** makes it impossible (§9.1) |
| Sale queued on a clock-fast offline device | ✅ after §12 fix — future skew is **clamped**, never rejects revenue |
| One owner login on 3 counter devices at rush hour | 🟠 shared `(user, store)` budgets throttle each other → key per device (§16) |
| Second device reconciles cash for a synced sale | 🔴 `order_payment` not in the pull registry → ship it with the order handler (§3) |
| Row created **and** deleted in one delta window | ✅ upserts apply before deletes within a page → ends deleted (§7) |
| Pulled `product` row overwrites local stock projection | 🟠 displayed stock jumps backwards → client ignores the pulled cache column (§14) |
| Revoked `view` + pending mutations on that entity | 🟠 purge rows + reject-locally-with-notice on the queue (§18) |
| Store hasn't edited reference data in 6 months | ✅ after S-31 fix — horizon on `ia` (fresh each poll), no spurious `410`; ⚠️ keying on per-entity watermark would force a full re-pull (§4) |
| Nightly stock reconciliation runs | ✅ after S-32 fix — cache off the synced row, no catalog re-sync; ⚠️ on-row cache bumps `modified_at` → 3 AM catalog storm (§14) |
| Two counters oversell at rush hour | 🟠 window = `stock_event` drain latency → dedicated lane (S-33, §14) |
| Nightly oversell check with a device offline for days | 🟠 wall-clock `SUM<0` false-alarms → gate on `min(last_sync_at)` (S-34, §14) |
| DLQ'd sale retried after 30 days | 🟠 idempotency row may be purged → double sale unless TTL ≥ DLQ dwell (S-35, §10) |

---

## 22. Known issues & design flags

| # | Flag | Severity | Fix |
|---|---|---|---|
| S-1 | **Optimistic-lock model wrong for sales/stock** | 🔴 architectural | use **additive ledger** for order/stock (§13/§14); wire `stock_event.recordDelta` |
| S-2 | **No POS handlers** (order/shift/cash/stock) | 🔴 | build (WS-A) — the #1 gap |
| S-3 | **Parent-cascade gaps** (order-dependent; cached-rejected parent returns `duplicate`, doesn't cascade) | 🟠 | dependency-sort the batch; treat cached-rejected parents as failed |
| S-4 | **`sessionStartedAt` inheritance** on new-entity upgrade | 🟠 | scope per cold-start session / reset for a brand-new entity |
| S-5 | **No revocation claw-back on pull** | 🟠 | `permissions_version` change → client purges entities it can't view |
| S-6 | ✅ **FIXED — Mutation-count limiter is per-`(user, store)`** (`sync_mutations:{userId}:{storeId}`) | — | verified api-reference §5 |
| S-7 | **No server-side poison-mutation cap** | 🟡 | max-retry / dead-letter on the push side |
| S-8 | **µs-`modifiedAt` contract unenforced** | 🟡 | shared helper / runtime assert in the filter base |
| S-9 | **Narrow fail-open** (only `ECONNREFUSED`) | 🟡 | fail-open on any Redis error for the limiter |
| S-10 | **180-day horizon triplicated** (+ retention was specced *inside* the horizon) | 🟡 | one shared constant; encode `TOMBSTONE_RETENTION = SYNC_HORIZON + BUFFER` (§8/§19) |
| S-11 | **Large single-entity backlog slow** (`perEntityLimit` small) | 🟡 | manifest + parallel (§6); per-entity floor |
| S-12 | **Oversell only logged**, not actioned | 🟡 | alert/flag on reconciliation |
| S-13 | Doc/comment drift ("≤1000 rows" vs 200; idempotency PK docstring; `/sync/pull` stale comments) | 🟢 | fix comments |
| S-14 | `device_sync_health` written but never read | 🟢 | consume (stale-device alerts) or drop |
| S-15 | **No device-lease crash recovery** — slot reclaimed only on explicit logout, not on crash/dead device | 🟠 | heartbeat + server lease TTL auto-reclaim ([device F10B](./device-management.md)) |
| S-16 | **Manifest can't skip unchanged entities** after a schema bump → full re-pull | 🟡 | per-entity `checksum` + `entity_version` (§6.1) |
| S-17 | **No too-old-client gate** | 🟡 | `minimum_client_version` → `410 UPGRADE_REQUIRED` (§6.2) |
| S-18 | ✅ **`conflict_type` is already in `SyncDeltaResponseDto`** (verified api-reference §5) | — | verify handlers populate it for all rejection kinds |
| S-19 | **Thin queue diagnostics** | 🟢 | persist `first_failure_at`/`last_failure_at`/`error_code`/`error_message` (§15) |
| S-20 | **Sale not atomic across mutations** — child failing after the parent committed = partial sale (revenue/GST mismatch); per-mutation tx can't provide sale atomicity | 🔴 architectural | **composite sale mutation** — one sale = one mutation = one server tx (§9.1) |
| S-21 | **Pull clobbers rows with pending local mutations** — steady-state pulls (not just reconnect) overwrite optimistic edits; with L-1 this is silent data loss end-to-end | 🔴 | **pending-mutation shadow** on the client applier — INV-11 ([mobile-11 §9](./mobile-11-sync-engine-client.md)) |
| S-22 | **Tombstone retention was inverted** (179d retention < 180d horizon → resurrected rows for 179–180d cursors) | 🔴 design bug | ✅ **fixed in this spec** — retention 195d > horizon (§8/§19) |
| S-23 | **Pulled `product.stock_quantity` clobbers the local ledger projection** (stock jumps backwards between reconciliations) | 🟠 | client always projects from the local ledger; pulled cache column ignored (§14) |
| S-24 | **Future-skew reject destroys honest sales** from a clock-fast offline device | 🟠 | **clamp** at preflight; strict reject only inside the grace path (§12) |
| S-25 | **Sync rate limits shared across devices of one login** (owner login on N counters throttles itself at rush) | 🟠 | key per `(user, store, device)` (§16) |
| S-26 | **`order_payment` missing from the pull registry** — second device can't reconcile cash/day-close | 🟠 | ship in the same registry change as the order handler (§3) |
| S-27 | **Cold-start parallelism capped by the shared throttle** — manifest workers don't cut wall-clock | 🟡 | raise `INITIAL_PAGE_SIZE` to 1000–2000 + raise the `/initial` throttle (§2/§6) |
| S-28 | **Manifest checksum too expensive** computed per request over 100k rows | 🟡 | maintain incrementally, or use `(latest_watermark, count)` (§6) |
| S-29 | **Claw-back purge vs pending queue undefined** | 🟡 | reject-locally-with-notice for mutations against purged entities (§18) |
| S-30 | **Doc status drift** — ✅ flags refer to a reference codebase; none of the sync code exists in this repo; contradicted [mobile-12 §6](./mobile-12-sync-implementation-audit.md) | 🟢 | header warning added; re-verify every ✅ against this repo before relying on it |
| S-31 | **Cursor horizon keyed on oldest per-entity watermark → spurious `410` for low-churn entities** — static `unit`/`taxrate`/`lookup` age out an actively-syncing store's cursor → forced full-catalog re-pull | 🔴 | key the 180d horizon on cursor `ia` (re-minted each poll), **never** on per-entity `ts`; static no-delete entities need no `410` (§4) |
| S-32 | **Nightly stock reconciliation re-syncs the entire catalog** — recomputing `product.stock_quantity` bumps `modified_at` → all products enter the delta stream every morning (write-amplification + 3 AM sync storm) | 🔴 | move the cache off the synced `product` row (separate `product_stock_cache` table, or recompute without touching `modified_at`) (§14) |
| S-33 | **Oversell window = `stock_event` propagation latency** — shared `perEntityLimit`/20-per-min drain makes cross-device stock stalest at rush hour, widening the window the ledger exists to reconcile | 🟠 | dedicated drain lane / higher per-entity floor for `stock_event` (§14/§15) |
| S-34 | **Oversell detection races device sync** — a wall-clock nightly `SUM<0` against a partially-synced ledger → false oversells (lagging device) + missed real ones until sync completes | 🟠 | gate detection on `T = min(last_sync_at)` across active devices; evaluate only events `≤ T` (§14) |
| S-35 | **Idempotency TTL can expire before a DLQ retry → double sale** — 30d applied-TTL sized to token life, not DLQ max-dwell | 🟠 | TTL ≥ `max(token life, DLQ max-dwell + margin)`; or client refuses to replay a `mutation_id` older than the TTL (§10) |
| S-36 | **Composite mutation has no per-payload size cap** — a 500-line B2B order = one multi-MB mutation / long tx | 🟡 | cap `items[]`/`payments[]` length + raw body size; split huge orders client-side (§9.1) |

---

## 23. Business rules

| ID | Rule |
|---|---|
| BR-SYNC-001 | All data/cursors/progress are **per `store_fk`**; multi-store = N independent partitions. |
| BR-SYNC-002 | Read cursors use **server-assigned** `modified_at`/`deleted_at` → clock-skew-immune pulls. |
| BR-SYNC-003 | Cursor is HMAC-signed + `(user, store)`-bound; cross-tenant replay rejected; >180d → `410`. |
| BR-SYNC-004 | µs-precision `modified_at` carried verbatim through the cursor — never a `Date` round-trip. |
| BR-SYNC-005 | Watermarks advance only to the **last row returned** (never pre-query `serverNow`) — no gap. |
| BR-SYNC-006 | Cold-start `next_delta_cursor` anchored at `sessionStartedAt` (start), catching mid-window writes. |
| BR-SYNC-007 | Push = **per-mutation tx**; one failure never blocks the batch; `5xx` aborts the whole call. |
| BR-SYNC-008 | Idempotency row written **same-tx** as the business write; duplicate replays the cached result. |
| BR-SYNC-009 | `update` must carry `expected_row_version`; stale → `conflict` (server doesn't merge; client rebases). |
| BR-SYNC-010 | **Master data = optimistic lock; transactional (sales/stock) = additive/event-sourced.** Never conflict-reject a sale. |
| BR-SYNC-011 | Stock = signed-delta ledger; authoritative = `SUM(delta)`; cache recomputed; oversell reconciled. |
| BR-SYNC-012 | Point-in-time grace honors `client_modified_at` with future + backdate + session-floor defenses. |
| BR-SYNC-013 | Tombstones written same-tx; **195-day retention *exceeds* the 180-day horizon** (`RETENTION = HORIZON + BUFFER`); `hard_delete` purges. |
| BR-SYNC-014 | Outbox is transactional + at-least-once; consumers dedup on `event_id`. |
| BR-SYNC-015 | Client queue: HIGH sales > MEDIUM stock > LOW audit; backoff + DLQ; FK order wins within a tier. |
| BR-SYNC-016 | Reconnect: **push before pull**; never require network to open a shift or ring a sale. |
| BR-SYNC-017 | A sale (and a shift close) is **one composite mutation** applied in one server tx — a partial sale is impossible (§9.1). |
| BR-SYNC-018 | The client **never applies a pulled row over an entity with a pending/conflict mutation** (pending-mutation shadow, INV-11). |
| BR-SYNC-019 | Client-displayed stock is **always the local ledger projection**; the pulled `stock_quantity` cache column is ignored (§14). |
| BR-SYNC-020 | Pure clock skew is **clamped, never rejected** — a clock error must never destroy a sale; strict rejection only where backdating grants privilege (§12). |
| BR-SYNC-021 | Within one delta page, an entity's upserts apply **before** its deletes — a row created+deleted in-window ends deleted (§7). |
| BR-SYNC-022 | The 180-day cursor horizon is keyed on the cursor's `ia` (re-minted every poll), **never** on per-entity watermark age — low-churn entities never force a spurious full resync (§4). |
| BR-SYNC-023 | The stock cache never lives on a synced row — recomputing it must **not** bump a sync watermark (§14). |
| BR-SYNC-024 | Oversell is evaluated only for ledger events at or before `T = min(last_sync_at)` across the store's active devices (§14). |
| BR-SYNC-025 | Idempotency TTL ≥ the client DLQ's max dwell — a retry can never outlive its idempotency row (§10). |

---

## 24. Backend changes required

| # | Change | Priority |
|---|---|---|
| 1 | **POS mutation handlers** — the **composite `order` mutation** (items + payments + stock deltas in ONE tx, §9.1) + `shift_session`/`cash_movement` on the **additive model** (not optimistic-lock); add **`order_payment` to the pull registry** in the same change (S-26) | 🔴 #1 |
| 2 | **Wire `stock_event.recordDelta`** from the sale/stock handlers; surface oversell actionably | 🔴 |
| 3 | **`SUBSCRIPTION_LAPSED_AT_WRITE`** point-in-time gate on `/sync/delta` (mirror §12; use the account `access_valid_until`) | 🔴 |
| 4 | **Open-shift check** in the order handler (resolve dead `SHIFT_NOT_OPEN`) | 🔴 |
| 5 | **Parent-cascade** dependency-sort + cached-rejected-as-failed (S-3) | 🟠 |
| 6 | **`sessionStartedAt`** per-session scoping (S-4) | 🟠 |
| 7 | **Revocation claw-back** on pull via `permissions_version` (S-5) | 🟠 |
| 8 | ✅ **DONE — Mutation-count limiter** per-`(user, store)` (S-6) — verified api-reference §5 | — |
| 9 | **Server poison-mutation DLQ cap** (S-7) | 🟡 |
| 10 | **`GET /sync/manifest`** + parallel cold start, incl. `checksum`/`entity_version` skip-unchanged + `minimum_client_version` → `410 UPGRADE_REQUIRED` (F-SYNC-2, §6.1, §6.2) | 🟡 |
| 11 | **Typed conflicts** — `conflict_type` on results + `/sync/conflicts` filter (§11.1) | 🟡 |
| 12 | **Queue diagnostics** — persist `first_failure_at`/`last_failure_at`/`error_code`/`error_message` (§15) | 🟢 |
| 13 | **Device-lease crash recovery** — heartbeat + lease TTL auto-reclaim ([device F10B](./device-management.md)) | 🟠 |
| 14 | µs-contract assert · single horizon constant · fail-open widen · trim tombstone `deleted_by_*` · fix doc drift (S-8…S-14) | 🟡 |
| 15 | **Tombstone retention → 195d** (> horizon) with `RETENTION = HORIZON + BUFFER` as one constant (S-22/S-10) | 🔴 |
| 16 | **Skew clamp at preflight** — never reject an honest sale for a fast clock (S-24, §12) | 🟠 |
| 17 | **Per-`(user, store, device)` rate-limit keys** (S-25, §16) | 🟠 |
| 18 | **`INITIAL_PAGE_SIZE` 1000–2000** + `/initial` throttle raise (S-27) · incremental manifest checksums (S-28) | 🟡 |
| 19 | **Claw-back queue rule** — reject-locally-with-notice for mutations against purged entities (S-29, §18) | 🟡 |
| 20 | **Cursor horizon on `ia`, not per-entity watermark** — prevent spurious `410` / full re-pull for low-churn entities (S-31, §4) | 🔴 |
| 21 | **Stock cache off the synced row** — `product_stock_cache` table (or no-`modified_at` recompute) to kill the nightly catalog re-sync (S-32, §14) | 🔴 |
| 22 | **`stock_event` dedicated drain lane** + **oversell detection gated on `min(last_sync_at)`** (S-33/S-34, §14/§15) | 🟠 |
| 23 | **Idempotency TTL ≥ DLQ max-dwell** + **per-mutation payload cap** (S-35/S-36, §10/§9.1) | 🟡 |
