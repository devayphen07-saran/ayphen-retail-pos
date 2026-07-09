# QA Test Cases — Sync Pull (Server → Client)

**Module under test:** Offline-first sync engine, pull path.
**Files reviewed:**
- `apps/backend/src/sync/pull/changes.service.ts` (`SyncChangesService` — `/sync/changes`, and the pull half of `/sync/delta`)
- `apps/backend/src/sync/pull/initial-sync.service.ts` (`InitialSyncService` — `/sync/initial`)
- `apps/backend/src/sync/cursor/sync-cursor.service.ts` (`SyncCursorService` — cursor mint/decode)
- `apps/backend/src/sync/registry/entity-filter.ts` (`GenericSyncFilter`, `SyncPullContext`, scope helpers)
- `apps/backend/src/sync/registry/sync-filter.registry.ts` (`SyncFilterRegistry`, `StaffSyncFilter`)
- `apps/backend/src/sync/repositories/tombstone.repository.ts`, `sync-init-progress.repository.ts`, `device-sync-health.repository.ts`
- `apps/backend/src/sync/services/sync-conflict.service.ts`, `apps/backend/src/sync/sync.controller.ts`, `sync.module.ts`, `sync.constants.ts`, `us-timestamp.ts`
- `apps/backend/src/sync/dto/sync-delta.schema.ts`, `apps/backend/src/sync/dto/response/conflict.response.ts`
- Guards: `guards/device-slot.guard.ts`, `guards/sync-rate-limit.guard.ts`, plus `SubscriptionStatusGuard`
- Cross-referenced: `docs/prd/sync-engine.md` (design intent / known issues §22 / business rules §23), current RBAC service (`common/rbac/rbac.service.ts`), and `git diff` of the in-flight (uncommitted) working tree.

**Out of scope (noted only where it touches pull correctness):** mutation push handlers, conflict resolution write path, stock ledger, outbox.

---

## 1. Feature understanding (BA)

### What it does
Two read endpoints plus one embedded pull give a mobile POS device the server's view of store data:

1. **`GET /stores/:storeId/sync/initial`** — cold start. One entity type per call, paged by `id ASC` (`INITIAL_PAGE_SIZE = 1000`), resumable via a persisted `(store, device, entity)` progress row. Iterates the registry in `dependencyOrder` until every entity's phase is `completed`, then mints and returns `next_delta_cursor`.
2. **`GET /stores/:storeId/sync/changes?cursor=`** — steady-state delta pull. For every entity the cursor already tracks, returns rows with `modified_at` (or `id` tiebreak) after the entity's watermark, plus a shared tombstone (delete) stream, and mints a new cursor.
3. **`POST /stores/:storeId/sync/delta`** — combined push+pull. If the request carries `sync_cursor`, the same `SyncChangesService.pull()` is invoked once, after mutations are applied, using a **critical (30s TTL)** permission snapshot (mutations forced a fresh fetch); a bare `GET /sync/changes` call uses the **standard (5 min TTL)** snapshot.

### Actors
- **Device/user pair** (`userId`, `deviceId`, `storeId`) — a mobile principal from `MobileJwtGuard`.
- **Server sync engine** — stateless per request; all position state lives in the opaque cursor (delta) or `sync_init_progress` table (cold start).

### Inputs / outputs
- Inputs: signed cursor token, optional `entity_type`/`cursor`/`reset`/`sync_cursor` (initial), `supported_entity_types` (comma-separated wire string, both endpoints).
- Outputs: `{ changes: { [entityType]: { upserts[], deletes[] } }, sync_cursor, has_more, server_time }` (delta) or `{ entity_type, upserts[], has_more, page_cursor, all_entities_complete, remaining_entity_types[], estimated_total?, next_delta_cursor?, server_time }` (initial).

### Business rules / invariants extracted from code (traced IDs used below)
- **BR-1 (no-gap advance, BR-SYNC-005):** a drained delta page advances the per-entity watermark only to the **last row actually returned**; an empty page **keeps the previous watermark**. A row committed inside the read window is re-delivered next poll, never skipped.
- **BR-2 (µs precision, BR-SYNC-004/S-8):** every watermark is a 6-decimal-µs string (`to_char(...,'US')`), asserted at runtime by `assertMicroIso`; a ms-precision leak would collapse the keyset tiebreak into an infinite-loop page.
- **BR-3 (read-safety lag):** rows with `modified_at` inside the last `READ_SAFETY_LAG_MS = 2000ms` are excluded from delta pulls (both `GenericSyncFilter` and `StaffSyncFilter`) — covers a long transaction that commits "into the past" of an already-advanced watermark. Not applied to `pullInitial` (id-keyset, no time predicate) or to tombstone pulls.
- **BR-4 (cursor binding/horizon, BR-SYNC-003/022):** cursor is HMAC-signed (`v4`), bound to `(userId, storeId)`; horizon is keyed **only** on `ia` (re-minted every response) — never on any per-entity watermark age — so a low-churn entity (`unit`, `taxrate`) never forces a spurious `410`.
- **BR-5 (future clamp):** any watermark (`ia`, per-entity `ts`) newer than server-now is clamped to server-now on decode — a forged/future cursor can delay delivery, never skip rows.
- **BR-6 (fair share, S-11):** `perEntityLimit = max(floor(200 / filters.length), 20)` — a per-entity floor keeps one entity's backlog from starving under many registered entities.
- **BR-7 (entity-level RBAC gate, §18):** a filter with no `view` on `permissionEntity` returns an empty page for that entity. In **delta**, the entity's watermark is **not** advanced (so once re-granted, the client back-fills from where it stopped). In **cold start**, the entity's progress phase is set to **`completed`** anyway (since `hasMore` is false on the empty page) — see F-1 below, this is an asymmetry, not a mirrored behavior.
- **BR-8 (shared tombstone stream, §8):** one `(deleted_at, id)` keyset per **store** (not per entity), same no-gap advance; **not filtered by RBAC `view` and not filtered by `supported_entity_types`** — every delete in the store is merged into `changes[entity_type].deletes` regardless of whether the caller's registry-filtered `filters` list included that entity this call.
- **BR-9 (cold-start resumability):** `sync_init_progress` PK `(store_fk, device_fk, entity_type)`; two devices cold-starting the same store are independent; a crash mid-page resumes from the last persisted `cursor` (deterministic `id ASC` keyset).
- **BR-10 (delta-cursor anchoring, BR-SYNC-006):** `next_delta_cursor` anchors each entity at **its own** `sessionStartedAt` (from the progress row), not global server-now, and takes the **oldest** entity's session start for the shared tombstone watermark; if the client passed its own live `sync_cursor` (a new entity type shipped mid-life on an otherwise-complete device), existing per-entity watermarks **win** over fresh anchors (never regress an already-delta-syncing entity).
- **BR-11 (dependency order is a total order):** the registry throws at construction if two filters share a `dependencyOrder` — enforced fail-fast, not a runtime pull-time concern, but gates whether the module boots at all.
- **BR-12 (device health touch, F1):** `devices.last_sync_at` is stamped on every pull surface (`/initial`, `/changes` when `deviceId` is passed, `/delta`) — best-effort, swallowed on failure, never fails the sync response.
- **BR-13 (reads are never subscription-gated):** `SubscriptionStatusGuard` only blocks non-GET methods and non-`@AllowExpiredSubscription` handlers; both `/sync/initial` and `/sync/changes` are `GET`, so they are **never** blocked by a lapsed/suspended/locked subscription.
- **BR-14 (device slot required):** `DeviceSlotGuard` requires an active `store_device_access` slot for `(storeId, deviceId)` on **every** sync route, pull included — a device that skipped `POST /stores/:id/access` gets `403 DEVICE_SLOT_REQUIRED` even for a pure read.
- **BR-15 (rate limits, per user+store+device, not per user+store alone):** `/sync/changes` 60/min, `/sync/delta` 20/min (keyed `sync_rate_limit:{userId}:{storeId}:{deviceId}:{bucket}`); `/sync/initial` carries **no** `@SyncRateLimit` decorator, so this guard no-ops for it (protected only by the app-wide `ThrottlerGuard`, likely per-IP).

### State machine — cold-start progress (`sync_init_progress.phase`)
`(none)` → **`in_progress`** (page returned, `hasMore=true`) → **`completed`** (page returned, `hasMore=false`, *or* the caller had no `view` on the entity at all). Legal transitions: `(none)→in_progress`, `(none)→completed`, `in_progress→in_progress`, `in_progress→completed`. `reset=true` deletes all progress rows for `(store, device)`, returning to `(none)` for every entity. There is **no** `completed → in_progress` transition triggered by a later permission grant — see F-2.

### Assumptions flagged (ambiguous / needs product-dev confirmation — see §7 Open Questions)
- **A1:** Whether a `staff` entity whose only store role is revoked is *intended* to never receive a tombstone (silent local staleness) or whether this is a gap to fix.
- **A2:** Whether marking a no-`view` entity `completed` during cold start (BR-7) is intended to permanently forfeit historical backfill once permission is later granted, or is a bug (see F-2).
- **A3:** The in-flight, uncommitted removal of the `location` entity type from the registry (and the `Location` RBAC entity + `location.guard.ts`) — whether this repo state is a deliberate feature descope mid-refactor or an incomplete change that needs to also clean up `apps/backend/src/db/schema.ts`'s `locations` sync columns/trigger and any lingering `permissionEntity: 'Location'` references.
- **A4:** Whether `/sync/initial` intentionally has no per-`(user,store,device)` rate limit (relying solely on the page-size lever + global IP throttle), matching the PRD's "exempt in the guard" note, or whether it should carry its own bucket.

---

## 2. Coverage plan

| Dimension (§4) | Cases planned | Why |
|---|---|---|
| Happy paths | 10 | Cold start (single/multi-page/multi-entity), steady delta, combined `/delta` pull, tombstone delivery, resume, `has_more` loop |
| Business rules (satisfied + violated) | 24 | BR-1…BR-15 above, each with a positive and (where applicable) a violating/edge variant |
| Boundaries | 14 | Page-size ±1, empty store, `perEntityLimit` floor, cursor length limits, µs tie, horizon edge, lag-window edge |
| Negative / invalid | 16 | Malformed cursor, tampered MAC, wrong tenant, wrong version, bad entity_type, cursor/entity mismatch, oversized payloads |
| Failure & recovery | 9 | Crash mid cold-start page, Redis down (rate limiter), DB error mid-page, device-health stamp failure, horizon 410 → resync |
| Concurrency | 8 | Two devices cold-starting same store, concurrent writes during a page read, permission change mid-loop, role revoke mid-poll |
| Permissions / roles | 12 | View revoked/granted mid-flight, unknown permission code, per-entity gating, staff visibility via role membership |
| State transitions | 6 | `sync_init_progress` phase legal/illegal transitions, `reset=true`, explicit `entity_type` on a completed device |
| Cross-cutting (offline/tenancy/time) | 14 | Long-offline device (>180d), tenant-scoped cursor replay, clock skew immunity, entity added mid-life, subscription lapsed device still pulling |
| UX / experience | 6 | `has_more` re-poll contract, `estimated_total` presence, empty `remaining_entity_types`, progress-bar first page |

**Total planned: ~119 cases** (enumerated below; some collapse into one ID with multiple sub-rows where the mechanics are identical).

---

## 3. Test cases

### A. Cold start — `/sync/initial` (happy path & mechanics)

**SP-A01 / First-ever cold start, single entity, single page**
Area: happy · Criticality: Critical · Traces to: F-SYNC-1, BR-9
Preconditions: New device, no `sync_init_progress` rows; store has 5 active products, user has `Product:view`.
Input: `GET /sync/initial` (no `entity_type`, no `cursor`).
Steps: 1) Call with no params. 2) Inspect response.
Expected: `entity_type='store'` (lowest `dependencyOrder=10`) returned first with its 1 row; `has_more=false` for that entity; `all_entities_complete=false`; `remaining_entity_types` lists all other 11 types; `estimated_total=1`. `sync_init_progress` now has a `store` row, `phase='completed'`.
Notes: Client must loop, not assume one call finishes cold start.

**SP-A02 / Cold start drains a multi-page entity**
Area: happy · Criticality: Critical · Traces to: F-SYNC-1
Preconditions: `product` has 2,500 active rows, `INITIAL_PAGE_SIZE=1000`.
Input: 3 sequential `GET /sync/initial?entity_type=product` calls, each using the prior `page_cursor`.
Steps: Call 1 (no cursor) → 1000 rows, `has_more=true`, `page_cursor='product:<id1000>'`. Call 2 with that cursor → next 1000, `has_more=true`. Call 3 → remaining 500, `has_more=false`.
Expected: Rows never repeat or skip across the 3 pages (deterministic `id ASC` keyset); `estimated_total` only present on call 1 (`afterId===null`); final call's `all_entities_complete` reflects whatever other entities remain.
Notes: `estimated_total` is a snapshot at page 1 — if rows are inserted between pages 1 and 3, the client-visible total undercounts; that's expected (see SP-B-boundary).

**SP-A03 / Explicit `entity_type` param jumps the queue**
Area: happy · Criticality: Medium · Traces to: F-SYNC-1 mechanics
Preconditions: Device mid-cold-start; `store`/`unit` completed, `product` not yet started.
Input: `GET /sync/initial?entity_type=customer` (skipping ahead of `product` in dependency order).
Expected: Server honors the explicit `entity_type` and dumps `customer`, ignoring `dependencyOrder` sequencing for this call; `sync_init_progress` gets/updates a `customer` row independent of `product`'s untouched state.
Notes: Confirms the API allows out-of-order entity fetches (e.g., client-side parallel/manifest-style fetching), not just the sequential default loop.

**SP-A04 / Loop completes → `next_delta_cursor` handed back exactly once**
Area: happy · Criticality: Critical · Traces to: BR-10, F-SYNC-1
Preconditions: All 12 entities dumped down to the last one.
Input: Final `GET /sync/initial` call that completes the last remaining entity.
Expected: `all_entities_complete=true`, `remaining_entity_types=[]`, `next_delta_cursor` present and is a valid v4 cursor whose `e` map has one `EntityWatermark` per entity, each `ts = microIsoFromDate(that entity's sessionStartedAt)`, `id = ZERO_UUID`; the `t` (tombstone) watermark equals the **oldest** of all `sessionStartedAt` values.
Notes: Verify by decoding the returned cursor (test harness needs the HMAC key or a decode endpoint/unit test).

**SP-A05 / Calling `/sync/initial` again after `all_entities_complete=true`**
Area: happy/state · Criticality: Medium · Traces to: F-SYNC-1
Preconditions: Device fully cold-started.
Input: `GET /sync/initial` (no params) again.
Expected: `InitialSyncService.completedResult()` path — `entity_type=null`, `upserts=[]`, `has_more=false`, `all_entities_complete=true`, `next_delta_cursor` reminted with the **same** anchors as before plus current `now`'s `ia` (fresh horizon clock), not a fresh full dump.

**SP-A06 / `reset=true` restarts cold start from zero**
Area: state · Criticality: High · Traces to: F-SYNC-1, BR-9
Preconditions: Device fully cold-started (all `completed`).
Input: `GET /sync/initial?reset=true`.
Steps: 1) Call with `reset=true`. 2) Call again without `reset`.
Expected: Call 1 deletes all `sync_init_progress` rows for `(store, device)` first, then proceeds exactly as a first-ever cold start (`store` first, phase `in_progress`/`completed` per its own row count). Call 2 continues the fresh sequence, not the old one.
Notes: This is the client's local-DB-wipe recovery path and also the `410 SYNC_HORIZON_EXCEEDED` recovery path.

**SP-A07 / Unknown/unsupported `entity_type` in query**
Area: negative · Criticality: Medium · Traces to: F-SYNC-1 validation
Input: `GET /sync/initial?entity_type=warehouse_zone` (not in `SYNC_ENTITY_TYPES`, or valid type but excluded by `supported_entity_types`).
Expected: `400 VALIDATION_FAILED` — "Unknown or unsupported entity_type 'warehouse_zone'". No progress row created, no DB touched for that call beyond the lookup.

**SP-A08 / `page_cursor` reused against the wrong entity**
Area: negative · Criticality: High · Traces to: F-SYNC-1 cursor-prefix guard
Preconditions: Client holds `page_cursor='product:aaaa-...'` from a `product` page.
Input: `GET /sync/initial?entity_type=customer&cursor=product:aaaa-...`.
Expected: `400 INVALID_CURSOR` — "Page cursor does not match the entity being pulled". No rows leaked from the wrong entity's keyset.

**SP-A09 / Malformed `page_cursor` (no colon, empty id, garbage id)**
Area: negative · Criticality: Medium
Input: `cursor=product` (no separator) → prefix becomes `''`, mismatches `product` → 400. `cursor=product:` → `afterId=null` (falls back to "from start" for that entity — not an error, since `q.cursor.slice(sep+1) || null` turns empty string into `null`). `cursor=product:not-a-uuid` → passed to `sql\`${id} > ${afterId}::uuid\``; Postgres rejects with a cast error → surfaces as a 500/DB error (not a clean 400).
Expected: First case 400 `INVALID_CURSOR`. Second case behaves like "start of product from the top" (verify this is the intended empty-cursor semantics, not silently wrong). Third case should ideally be a 400, not a raw DB error — **flag as a gap** (see coverage gaps).

**SP-A10 / Entity with zero rows in the store**
Area: boundary/empty · Criticality: Medium · Traces to: §5 empty-list checklist
Preconditions: Brand-new store with no suppliers yet.
Input: `GET /sync/initial?entity_type=supplier`.
Expected: `upserts=[]`, `has_more=false`, phase→`completed` immediately, `estimated_total=0` (first page, `canView=true`).

**SP-A11 / No `view` permission on an entity mid-cold-start**
Area: permission · Criticality: Critical · Traces to: BR-7, A2, F-2
Preconditions: User's role has no `Customer:view`; device is cold-starting and reaches `customer` in the queue.
Input: `GET /sync/initial?entity_type=customer` (or default sequential reach).
Expected: `upserts=[]`, `has_more=false`, phase→`completed`, **no** `estimated_total` (since `canView=false` short-circuits `estimated_total` computation even on the "first page"). Cold start proceeds to the next entity as if `customer` were fully synced.
Notes: **This is F-2** — see Edge Cases §4 for the downstream consequence when `view` is later granted.

**SP-A12 / Crash / client kill mid multi-page cold start, then resume**
Area: failure/recovery · Criticality: Critical · Traces to: BR-9
Preconditions: `product` cold start page 1 of 3 has been served and acknowledged by a **prior** call (server already persisted `cursor`), then the client process dies before requesting page 2.
Input: Client restarts, calls `GET /sync/initial?entity_type=product` **without** a `cursor` query param (relies on server-persisted resume point).
Expected: Server resumes from `row.cursor` (the persisted `afterId`) — page 2's exact same 1000 rows are returned again (deterministic keyset), not page 3 and not page 1. Confirms "the deterministic keyset returns the same rows for the same cursor" (idempotent re-delivery, no gap, no duplicate-forever loop).

**SP-A13 / Concurrent cold start of the same store from two different devices**
Area: concurrency · Criticality: High · Traces to: BR-9, §21 "two devices cold-start same store"
Preconditions: Same store, Device A and Device B, both never synced.
Input: Both issue `GET /sync/initial` concurrently for the same entity.
Expected: Independent progress rows (PK includes `device_fk`); no cross-device interference; both eventually reach `all_entities_complete=true` with their own `next_delta_cursor`.

**SP-A14 / `ensure()` race — concurrent delete of the just-inserted progress row**
Area: concurrency/failure · Criticality: Low · Traces to: `SyncInitProgressRepository.ensure`
Preconditions: Contrived — a concurrent process deletes the `sync_init_progress` row between the `onConflictDoNothing()` insert and the fallback re-select.
Expected: `ConflictError CONCURRENT_MODIFICATION` — "Sync progress row changed concurrently; retry". Client should retry the `/sync/initial` call.
Notes: Genuinely rare in production (nothing else deletes these rows except `reset`), but the code path exists and should not throw an unhandled exception.

**SP-A15 / New entity type ships in an app upgrade, device already fully synced (no reset)**
Area: cross-cutting/edge · Criticality: High · Traces to: S-4, §22 flag
Preconditions: Device previously completed cold start under an older `SYNC_ENTITY_TYPES` set (e.g., 11 types); server adds a 12th type; device upgrades its app and calls `/sync/initial` with the new `supported_entity_types` including the new type, and its existing live `sync_cursor` as `q.syncCursor`.
Expected: Server finds the new entity's phase undefined → dumps it. Its cursor anchor in `next_delta_cursor` uses **its own fresh `sessionStartedAt`** (this cold-start's session, not inherited from the months-old original session) per `buildDeltaCursor`'s per-entity `row?.sessionStartedAt ?? now` computation — each entity pulls its OWN progress row, so a brand-new entity's row is created fresh. Existing entities' watermarks in `existingCursorToken` win over the fresh anchors (merge step), so they are **not** regressed to session start.
Notes: This is the mechanism the PRD's S-4 flag warns about — verify in code (not just doc) that the new entity's `sessionStartedAt` truly comes from *this* session's progress row and not a stale shared value. Confirmed correct by reading `buildDeltaCursor`: anchors are keyed per current progress rows, which are fresh for a never-before-seen entity type.

**SP-A16 / `supported_entity_types` narrower than the full registry**
Area: happy/boundary · Criticality: Medium · Traces to: `SyncFilterRegistry.supported()`
Input: `GET /sync/initial?supported_entity_types=store,unit,product` (older client build).
Expected: Only those 3 entities are iterated/dumped; `remaining_entity_types` never lists `customer`/`supplier`/etc.; `all_entities_complete` becomes true once just those 3 are done — the client is never told about entities it doesn't support.

---

### B. Delta pull — `/sync/changes` (happy path & mechanics)

**SP-B01 / Steady-state poll with no changes since last cursor**
Area: happy · Criticality: High · Traces to: BR-1
Preconditions: Device holds a valid cursor from 5 minutes ago; nothing changed.
Input: `GET /sync/changes?cursor=<valid>`.
Expected: Every entity's `upserts=[]`, `deletes=[]`; `has_more=false`; `sync_cursor` returned is **byte-different** from the input (new `ia`) but **same** `e`/`t` watermarks (no gap, nothing advanced past what's real).

**SP-B02 / One product updated since last poll**
Area: happy · Criticality: Critical · Traces to: BR-1, BR-2
Preconditions: Cursor watermark for `product` is `T0`; one product's `modified_at` is `T0 + 10s` (older than `now() - 2s` lag).
Input: `GET /sync/changes?cursor=<T0>`.
Expected: `changes.product.upserts` contains exactly that row (wire snake_case, `modified_at` as µs string, `stock_quantity` absent per BR-SYNC-023 — product filter doesn't select it); new cursor's `e.product = {ts: <that row's modified_at>, id: <that row's id>}`.

**SP-B03 / `has_more=true` loop until drained**
Area: happy · Criticality: High · Traces to: F-SYNC-3 loop contract
Preconditions: 500 products changed since last poll; `perEntityLimit` for `product` alone (12 entities registered) = `max(floor(200/12),20) = 20`.
Steps: Poll repeatedly, feeding each response's `sync_cursor` into the next call, until `has_more=false`.
Expected: Client needs **25 round trips** to drain the 500-row product backlog at ~20 rows/poll (S-11 in practice); no row is skipped or duplicated across the sequence; final poll's `has_more=false`.
Notes: Demonstrates the real-world cost of S-11 — worth a perf/UX note, not just correctness.

**SP-B04 / Tombstone delivered alongside upserts, applied-order contract**
Area: happy/business-rule · Criticality: Critical · Traces to: BR-8, BR-SYNC-021
Preconditions: A customer row is created and then deleted inside the same poll window.
Input: `GET /sync/changes?cursor=<before both>`.
Expected: `changes.customer.upserts` contains the create (or the last-known state before delete, if the row still existed at query time) **and** `changes.customer.deletes` contains its tombstone; contract requires the client to apply upserts before deletes for that entity within one page so it ends up deleted. Server does not need to suppress the upsert — that's a client-apply-order responsibility, not filtered server-side.

**SP-B05 / `supported_entity_types` narrows the deltas returned**
Area: happy/boundary · Criticality: Medium
Input: `GET /sync/changes?cursor=<..>&supported_entity_types=product,customer`.
Expected: Only `product`/`customer` entries appear in `changes` from the upsert loop; **however** the shared tombstone stream (BR-8) is **not** filtered by `supported_entity_types` — a delete for, say, `supplier` (not in the supported list) still lands under `changes.supplier.deletes` even though `changes.supplier.upserts` was never populated this call (key created fresh via `??=`). Client must tolerate/ignore delete entries for entity types it doesn't model.
Notes: This is a real behavior difference worth calling out explicitly — see Edge Cases §4.

**SP-B06 / Combined pull inside `POST /sync/delta`**
Area: happy/cross-cutting · Criticality: High · Traces to: §9, `delta.service.ts buildResult`
Preconditions: Client submits 3 mutations and a `sync_cursor`.
Input: `POST /sync/delta { sync_cursor, mutations: [...] }`.
Expected: Mutations are applied first (`runMutationWaves`), **then** `changes.pull()` runs once using the same cursor, using a permissions snapshot that was already force-refreshed (critical, 30s TTL) for the mutation preflight — so any permission change in the last ≤30s is reflected in the pull half too, unlike a bare `/sync/changes` call (5 min TTL). Response bundles `mutation_results` + `changes` + new `sync_cursor` + `has_more` in one payload.

**SP-B07 / `/sync/delta` with no `sync_cursor` at all**
Area: boundary · Criticality: Medium
Input: `POST /sync/delta { mutations: [...] }` (no `sync_cursor` field — it's optional in `SyncDeltaSchema`).
Expected: `pulled = null`; response has `changes: {}`, `sync_cursor: null`, `has_more: false` — a push-only call never invokes the pull path or advances/mints anything. Mutations still process normally.

**SP-B08 / Entity present in registry but not yet in the client's cursor (`cursor.e[type] === undefined`)**
Area: business-rule · Criticality: Critical · Traces to: `changes.service.ts` filters line, BR-SYNC entity-cold-start-only-through-initial rule
Preconditions: A brand-new entity type shipped server-side; client's existing delta cursor predates it and was never merged via `/sync/initial`.
Input: `GET /sync/changes?cursor=<old cursor missing the new entity key>`.
Expected: The new entity is **silently excluded** from `filters` (via `.filter((f) => cursor.e[f.entityType] !== undefined)`) — no error, no partial/epoch dump; `changes` simply has no key for it. Client must run `/sync/initial` for that entity to ever receive it via delta. Confirms "a brand-new entity type cold-starts through /sync/initial ... never epoch-dumped through the delta path" by design.

**SP-B09 / Empty store, first-ever delta poll right after cold start**
Area: boundary/first-run · Criticality: Medium
Preconditions: Store has zero rows in every entity (freshly created store).
Input: `GET /sync/changes?cursor=<next_delta_cursor from an all-empty cold start>`.
Expected: All entities' `upserts=[]`/`deletes=[]`; `has_more=false`; well-formed cursor returned, no crash on the "0 filters" or "0 rows" boundary.

---

### C. Cursor codec (`SyncCursorService`)

**SP-C01 / Tampered payload (bit-flip in body, MAC unchanged)**
Area: negative/security · Criticality: Critical · Traces to: BR-4
Input: Take a valid cursor, flip one base64url character in the body segment, keep the original MAC segment.
Expected: `400 INVALID_CURSOR` (constant-time MAC compare fails — `timingSafeEqual` on mismatched buffers, or length mismatch caught first). No information about *why* it failed is leaked in the message.

**SP-C02 / Cross-tenant replay — cursor minted for Store B used against Store A**
Area: negative/security · Criticality: Critical · Traces to: BR-4, "tenant mismatch deliberately indistinguishable from garbage"
Preconditions: User has access to both Store A and Store B; holds a valid cursor for Store B.
Input: `GET /stores/{storeA}/sync/changes?cursor=<store B's cursor>`.
Expected: `400 INVALID_CURSOR` (not a distinct "wrong tenant" code) — `payload.s !== storeId` fails the same branch as garbage. Verify the tenant-guard/`storeId` path param still matches the JWT's accessible stores independent of this check (defense in depth).

**SP-C03 / Cursor minted for a different user used by this user (even same store)**
Area: negative/security · Criticality: Critical · Traces to: BR-4
Input: User B presents User A's valid cursor for the same store.
Expected: `400 INVALID_CURSOR` (`payload.u !== userId`).

**SP-C04 / Wrong cursor version (`v ≠ 4`)**
Area: negative · Criticality: High · Traces to: BR-4
Preconditions: Simulate an old `v3` cursor format (e.g., from before a version bump) with a valid-looking MAC for that old payload shape but current key.
Expected: `400 INVALID_CURSOR`. No silent partial-parse.

**SP-C05 / Horizon exceeded — device offline > 180 days**
Area: boundary/cross-cutting · Criticality: Critical · Traces to: BR-4, F-SYNC-8/§21
Preconditions: Cursor's `ia` is 181 days old (never re-issued because the device never called any sync endpoint since).
Input: `GET /sync/changes?cursor=<181-day-old ia>`.
Expected: `410 SYNC_HORIZON_EXCEEDED` — "restart at /sync/initial". Client must fall back to cold start (`reset=true` optional if local DB is intact — code allows resuming initial sync progress if any exists, or starting fresh).
Notes: Boundary case — **exactly 180 days** (`now - ia === SYNC_HORIZON_MS` exactly) should still pass (`>` strict, not `>=`); **180 days + 1ms** should 410. Add both as explicit sub-cases.

**SP-C06 / Horizon NOT triggered by an old per-entity watermark on a low-churn entity**
Area: business-rule (violated-then-fixed) · Criticality: High · Traces to: BR-4, S-31
Preconditions: Store actively syncs daily (cursor `ia` always fresh); `taxrate` hasn't changed in 300 days, so `cursor.e.taxrate.ts` is 300 days old.
Input: Normal daily `GET /sync/changes?cursor=<fresh ia, ancient taxrate ts>`.
Expected: **No** `410` — horizon check only inspects `ia`, never any per-entity `ts`. Confirms S-31 is fixed in this codebase (contradicts an older/different reference implementation that might key on the oldest watermark).

**SP-C07 / Forged future cursor (client clock tampering or malicious replay)**
Area: negative/security · Criticality: High · Traces to: BR-5
Input: Craft a cursor whose `e.product.ts` is 1 year in the future (still correctly MAC'd, since an attacker with cursor-forging capability implies key compromise — but also test the honest case: client clock was wildly fast when a *previous* server response was cached and replayed).
Expected: Decode clamps that watermark to `nowMicro`; the resulting delta query effectively asks for "changes after right now," so no rows are skipped — at worst, the next legitimately-committed row for that entity is still delivered on a subsequent poll. `ia` itself is also clamped: `ia = Math.min(payload.ia, now.getTime())`.

**SP-C08 / Cursor exactly at 8192-char `max` on `ChangesQuerySchema`**
Area: boundary · Criticality: Low · Traces to: `sync-delta.schema.ts`
Input: A cursor string of exactly 8192 chars vs. 8193 chars (many registered entity watermarks inflate cursor size over time, especially with S-31-style long-lived stale entity keys — see Edge Case E-3 below).
Expected: 8192 passes Zod; 8193 → `400` schema validation error before even reaching `SyncCursorService.decode`.

**SP-C09 / Missing/malformed dot separator, missing MAC, empty body**
Area: negative · Criticality: Medium · Traces to: `decode()` guard clauses
Input variants: `""`, `"noDotAtAll"`, `".onlyMac"`, `"onlyBody."` (dot at last char), `"a.b.c"` (uses `lastIndexOf('.')`, so this parses as body=`"a.b"`, mac=`"c"` — still likely fails MAC, not a parse crash).
Expected: All → `400 INVALID_CURSOR`, never a 500/unhandled exception.

**SP-C10 / `e` is not an object (null, array, string) after JSON parse**
Area: negative · Criticality: Medium
Input: A forged-but-correctly-MAC'd payload (test-harness-only scenario, or a future key-rotation bug) where `e: null` or `e: "oops"`.
Expected: `400 INVALID_CURSOR` from the `typeof payload.e !== 'object' || payload.e === null` guard.

**SP-C11 / Individual watermark fails the µs-ISO regex**
Area: negative · Criticality: Medium · Traces to: BR-2
Input: A cursor whose `e.product = {ts:"2026-01-01T00:00:00.123Z", id:"..."}` (ms precision, 3 decimals, not 6).
Expected: `400 INVALID_CURSOR` — `MICRO_ISO_RE` fails on the `clamp()` helper before any query runs (prevents the ms-precision infinite-loop class of bug from ever reaching the DB).

---

### D. Registry / entity-filter mechanics

**SP-D01 / Keyset tie on identical `modified_at` — multiple rows same µs timestamp**
Area: boundary · Criticality: Critical · Traces to: BR-2, keyset correctness
Preconditions: A bulk import or migration sets 50 products to the exact same `modified_at` (same microsecond) with `perEntityLimit=20`.
Input: Poll repeatedly from a watermark before that batch.
Expected: Rows are delivered in `id ASC` order **within** the tied timestamp across successive polls (`(modified_at = ts AND id > id)` branch) — 20, then next 20, then remaining 10 — never re-delivering the same 20 forever, never skipping any of the 50.

**SP-D02 / Read-safety-lag boundary — row committed 1.9s ago vs 2.1s ago**
Area: boundary · Criticality: High · Traces to: BR-3
Preconditions: `READ_SAFETY_LAG_MS=2000`. Two rows: A committed 1.9s before the poll, B committed 2.1s before.
Input: `GET /sync/changes?cursor=<before both>`.
Expected: B is returned (older than the 2s lag), A is **withheld** this poll (its `modified_at` is inside the exclusion window) and appears on the **next** poll once it ages past 2s. Watermark does not advance past A since it wasn't in the returned page (no-gap rule holds).

**SP-D03 / Global-or-store scope — a global (no `store_fk`) lookup row is visible to every store**
Area: business-rule · Criticality: High · Traces to: `globalOrStoreScope`
Preconditions: A `lookup` row with `store_fk=NULL` (system-wide) and one with `store_fk=StoreA`.
Input: Cold start / delta pull as a user in Store B.
Expected: The global row is included; the Store-A-scoped row is excluded. Verifies `or(isNull(storeFk), eq(storeFk, ctx.storeId))`.

**SP-D04 / Self-store scope — the `store` entity only ever returns the caller's own store row**
Area: business-rule · Criticality: Medium · Traces to: `selfStoreScope`
Input: Pull `store` entity as a user of Store A.
Expected: Exactly one row (Store A itself), never any sibling store even if the user also has access to Store B (`eq(idColumn, ctx.storeId)` — scoped to the path's `:storeId`, not the user's full store list).

**SP-D05 / Soft-deleted row excluded from both upserts and initial dump (must arrive only as a tombstone)**
Area: business-rule · Criticality: Critical · Traces to: `aliveWhere`
Preconditions: A product is soft-deleted (`deletedAt` set) after being previously synced.
Input: Cold start (fresh device) and delta pull (existing device) both after the soft-delete.
Expected: Cold start `pullInitial` never includes it (excluded by `aliveWhere: isNull(deletedAt)`); delta `pullChanges` never includes it as an upsert either; it is delivered **only** via the tombstone stream (assuming the delete handler wrote one — out of scope here, but the pull side's job is to never leak a soft-deleted row as an upsert).

**SP-D06 / `store_device_access` and `unit` have no `aliveWhere` beyond `isNull(deletedAt)` where defined — verify entities without one (`lookup`, `payment_method`... wait paymentMethod has aliveWhere) behave correctly**
Area: boundary · Criticality: Medium
Preconditions: `store_device_access` filter config has **no `aliveWhere`** at all (confirmed by reading the registry — only `scopeWhere`, no `aliveWhere` key).
Expected: Revoked device-access rows (`revokedAt` set, `status` changed) are **not excluded** from sync — they continue to be delivered as upserts (status flip visible), which is correct for this entity (its revocation is itself a piece of state the client needs to see, e.g., to know a sibling device was logged out), unlike a hard "deleted" row. Confirm this is intentional, not a missed `aliveWhere`.

**SP-D07 / `estimateCount` reflects only alive, in-scope rows**
Area: boundary · Criticality: Low · Traces to: cold-start progress bar
Preconditions: Store has 100 products, 10 soft-deleted.
Input: First page of `product` cold start.
Expected: `estimated_total=90`, not 100 — matches `aliveWhere` filter, so the client's progress bar denominator is accurate.

**SP-D08 / `estimateCount` skipped entirely on later pages**
Area: boundary · Criticality: Low
Input: Page 2+ of a multi-page `product` cold start (`afterId !== null`).
Expected: `estimated_total` key is **absent** from the response (not merely `undefined` serialized as null) — the `...(estimatedTotal !== undefined ? {...} : {})` spread guard confirms the key is omitted, not present-with-null. Verify actual wire JSON, since some serializers turn `undefined` into `null` instead of omitting.

**SP-D09 / Staff visibility — user's role revoked but user row itself unchanged otherwise**
Area: permission/business-rule · Criticality: Critical · Traces to: `StaffSyncFilter`, F-1 (see Edge Cases)
Preconditions: User X had one role in Store A (`userRoleMappings.revokedAt IS NULL`); an admin revokes it (`revokedAt=now()`); the `sync_touch` trigger bumps `users.modified_at` for X per the class doc-comment.
Input: A delta poll for `staff` from another device in Store A, using a watermark from before the revoke.
Expected: User X's row is **excluded** from the result (INNER JOIN on `userRoleMappings` with `isNull(revokedAt)` no longer matches) even though `users.modified_at` advanced past the watermark. **No tombstone is written for `staff`** (confirmed: `TombstoneRepository.write` is only called from product/customer/supplier/paymentaccount/lookup mutation handlers — never from role-management code). Net effect: the already-synced staff row for User X **remains on other devices forever**, with no removal signal. **This is F-1 — flag as a defect**, see §4/§6.

**SP-D10 / Staff visibility — user gains their first role in a store they previously had none in**
Area: permission/business-rule · Criticality: High · Traces to: `StaffSyncFilter`
Preconditions: User Y is granted a role in Store A for the first time.
Input: Delta poll for `staff` after the grant.
Expected: Y's row now satisfies the INNER JOIN and appears as a fresh upsert (their `users.modified_at` was bumped by the grant per the sync_touch trigger) — correctly delivered even though `users` itself wasn't otherwise edited.

**SP-D11 / `staff` `selectDistinct` de-dupes a user holding two roles in the same store**
Area: boundary · Criticality: Medium · Traces to: `membershipJoin`
Preconditions: User Z holds both "Cashier" and "Shift Supervisor" role mappings in Store A (two `userRoleMappings` rows, both un-revoked).
Input: Cold start / delta pull of `staff`.
Expected: Exactly **one** row for Z (the `selectDistinct` on the full projection collapses the join fan-out) — not two duplicate rows with the same `id`.

---

### E. Rate limiting, device slot, subscription interplay on pull

**SP-E01 / `/sync/changes` at exactly the 60/min limit, then +1**
Area: boundary · Criticality: High · Traces to: `SYNC_CHANGES_RATE_LIMIT`
Input: 60 calls within one 60s window from the same `(user, store, device)`, then a 61st.
Expected: Calls 1–60 succeed; call 61 → `429 RATE_LIMIT_EXCEEDED` — "Too many sync requests — please slow down and retry shortly". Window resets after 60s from the first call (Redis `EXPIRE` set only on first `INCR`).

**SP-E02 / `/sync/delta` request-rate (20/min) vs mutation-volume (100/5min) are independent budgets**
Area: business-rule · Criticality: High · Traces to: `SYNC_DELTA_RATE_LIMIT`, `SYNC_MUTATION_RATE_LIMIT`
Input: 20 `/sync/delta` calls in 60s, each with exactly 5 mutations (100 total, within the 5-min mutation budget) — then a 21st call with 0 mutations (pure pull, still counts against the 20/min request budget).
Expected: Call 21 is blocked by the **request** limiter (`429`) even though it carries zero mutations and would not have touched the mutation-count budget at all — confirms the two limiters are independent and a "pull-only" `/sync/delta` call still consumes the request-rate budget.

**SP-E03 / Two devices of one login at rush hour don't throttle each other**
Area: cross-cutting/business-rule · Criticality: High · Traces to: BR-15 (per-device keying), S-25 fixed
Preconditions: One owner logged into Device 1 and Device 2 in the same store.
Input: Device 1 makes 60 `/sync/changes` calls in a minute (its own limit); Device 2 makes its own call in the same minute.
Expected: Device 2's call succeeds — the Redis key includes `deviceId`, so Device 1 exhausting its budget never affects Device 2. Confirms the PRD's S-25 flag is fixed in this repo (key format `sync_rate_limit:{userId}:{storeId}:{deviceId}:{bucket}`).

**SP-E04 / Redis outage during a pull's rate-limit check**
Area: failure/recovery · Criticality: High · Traces to: "fails OPEN on Redis error"
Input: `GET /sync/changes` while Redis is unreachable (connection refused or any other Redis error).
Expected: The guard logs a warning and returns `true` (fails open) — the pull still succeeds; sync is never blocked by a rate-limiter outage. Verify this covers **any** Redis error class, not just `ECONNREFUSED` (the PRD's S-9 flag claims the *reference* implementation narrows this to `ECONNREFUSED` only — check this repo's actual `catch` block breadth; the code read here catches unconditionally in `try/catch`, which appears to already fail open on any error — confirm no narrower filter exists elsewhere).

**SP-E05 / Device has no active slot (never claimed, or slot revoked) attempting a pull**
Area: negative/permission · Criticality: Critical · Traces to: BR-14
Preconditions: Device authenticated (valid JWT) but never called `POST /stores/:id/access`, or its slot was reclaimed/logged out.
Input: `GET /sync/initial` or `/sync/changes`.
Expected: `403 DEVICE_SLOT_REQUIRED` — "call POST /stores/:storeId/access first" — before any pull logic runs (guard order: `DeviceSlotGuard` precedes the controller method).

**SP-E06 / Subscription expired/suspended/locked — pull still works**
Area: business-rule · Criticality: Critical · Traces to: BR-13
Preconditions: Account subscription `status='expired'` (payment required) or `paused` (suspended) or store `isLocked=true`.
Input: `GET /sync/initial`, `GET /sync/changes`.
Expected: Both succeed normally (GET is in `READ_METHODS`, always passes `SubscriptionStatusGuard` regardless of `allowExpired`). Response still carries `X-Subscription-Version`/`X-Subscription-Warning` headers. Contrast with a mutation in the same state, which would 402/403 on `POST /sync/delta` (if not for the endpoint's own `@AllowExpiredSubscription`, which additionally exempts the write side for point-in-time grace — but even without that decorator, pull itself is unconditionally exempt).

---

### F. Boundary & numeric/string edges

**SP-F01 / `perEntityLimit` floor kicks in with many registered entities**
Area: boundary · Criticality: Medium · Traces to: BR-6
Preconditions: All 12 entity types active in `cursor.e` and `supported_entity_types`. `floor(200/12)=16`, which is **below** `PER_ENTITY_FLOOR=20`.
Expected: `perEntityLimit=20` (floor wins over the arithmetic share) — every entity gets at least 20 rows/poll even though 12×20=240 could exceed the nominal 200-row "budget" (the floor is an explicit trade-off, not a bug).

**SP-F02 / `perEntityLimit` with a single entity supported**
Area: boundary · Criticality: Low
Input: `supported_entity_types=product` only.
Expected: `perEntityLimit = max(floor(200/1),20) = 200` — a lone entity gets the full page budget.

**SP-F03 / Zero filters after `supported`/cursor intersection (e.g., client supports only types the cursor has none of)**
Area: boundary · Criticality: Medium
Input: `supported_entity_types=warehouse_zone` (unknown to registry) plus a fresh cursor with no matching `e` keys.
Expected: `filters=[]`; `perEntityLimit = max(floor(200/max(0,1)),20) = 20` (division-by-zero guarded via `Math.max(filters.length,1)`); loop over `filters` does nothing; only the tombstone stream still runs; response has `changes={}` plus possibly a `deletes`-only structure if any store-wide tombstones exist for entity types the client didn't ask about (ties back to SP-B05).

**SP-F04 / `INITIAL_PAGE_SIZE` exact boundary — entity has exactly 1000 rows**
Area: boundary · Criticality: Medium · Traces to: `limit+1` hasMore trick
Input: `product` has exactly 1000 active rows.
Expected: Query fetches `limit+1=1001`, gets exactly 1000 back → `hasMore=false` (not true) — the `rows.length > limit` check correctly distinguishes "exactly full page, nothing more" from "more exists." Also test **1001 rows**: first page returns 1000, `hasMore=true`; second page (from last id) returns the 1 remaining row, `hasMore=false`.

**SP-F05 / `DELTA_PAGE_SIZE`/per-entity boundary — entity has exactly `perEntityLimit` changed rows**
Area: boundary · Criticality: Medium
Same `limit+1` mechanic as F04, applied to `pullChanges`; verify no off-by-one at the exact-page-full boundary specifically for the `(modified_at, id)` composite keyset (not just `id`).

**SP-F06 / Cursor's `supported_entity_types` wire string at max length (4096) and beyond**
Area: boundary · Criticality: Low · Traces to: `ChangesQuerySchema`
Input: A `supported_entity_types` query string of exactly 4096 chars, then 4097.
Expected: 4096 passes Zod; 4097 → `400` before reaching `splitTypes`/registry filtering.

**SP-F07 / `entity_type` param at the 40-char max (Zod) vs a legitimately-long-but-under type name**
Area: boundary · Criticality: Low
Input: `entity_type` string of 40 chars (passes schema) that still doesn't match any real registry entity → falls through to the "unknown or unsupported" 400 in the service layer, not the schema layer, distinguishing schema-shape validity from semantic validity.

**SP-F08 / Unicode/emoji in synced text fields pass through unmodified**
Area: boundary/i18n · Criticality: Low · Traces to: `toWireRow` passthrough
Preconditions: A customer named `"मुकेश 🛒 & Co."` (Devanagari + emoji + ampersand).
Input: Delta pull after that customer's creation.
Expected: Wire row's `name` field is byte-identical UTF-8, no mangling, no HTML-escaping (this is JSON over HTTP, not rendered HTML) — the sync layer does no sanitization/transformation of arbitrary text fields (that's a display-layer concern), confirm this expectation is shared by the client team (Open Question).

---

### G. Failure & recovery

**SP-G01 / DB error mid-page (e.g., connection drop) during `pullChanges`**
Area: failure · Criticality: High
Input: Simulate a DB error while a `GenericSyncFilter.pullChanges` query is in flight for one of several entities in the loop.
Expected: The whole `/sync/changes` call fails (500) — there's no per-entity try/catch in the loop, so one entity's transient DB error fails the entire response; **no partial cursor is minted** (mint happens only at the very end, after all entities' loop iterations succeed) — so the client's stored cursor is untouched and a retry re-attempts cleanly from the same starting point. Confirm no partial state (e.g., `nextEntities` map mutated in-loop) leaks into a "half-advanced" cursor on a later successful call — it doesn't, because `mint()` is only called after the function returns normally.

**SP-G02 / `devices.last_sync_at` stamp fails (device row locked/gone)**
Area: failure/recovery · Criticality: Low · Traces to: BR-12
Input: `deviceId` no longer exists (deleted between session issuance and this call) or the update fails for any reason.
Expected: `DeviceSyncHealthRepository.touch` catches and logs the error; the sync response **still succeeds** — a failed health-stamp never blocks a pull.

**SP-G03 / Cold start crash exactly between "page persisted" and "response sent"**
Area: failure/recovery · Criticality: High · Traces to: BR-9
Preconditions: Server persists `savePage()` successfully but the HTTP response is lost (network drop) before the client receives it.
Input: Client retries the same `/sync/initial?entity_type=X` call with the cursor it had **before** the lost response (i.e., it never learned the new `page_cursor`).
Expected: Server ignores the client's stale/absent cursor param if none is supplied and instead resumes from its own persisted `row.cursor` (server-side state wins over an omitted client param) — client re-receives the page it already applied (idempotent, safe to re-apply by `guuid`).
Notes: **If the client instead resends its own `q.cursor` matching the pre-crash position**, the explicit `q.cursor` **overrides** the persisted server cursor (`let afterId = row.cursor; if (q.cursor) afterId = ...`) — so it would replay the *same* page again too, consistent either way. Verify both paths converge to no gap/no gap gap gain.

**SP-G04 / Horizon-exceeded recovery loop**
Area: failure/recovery · Criticality: High · Traces to: BR-4
Steps: 1) Device offline 200 days, its stored cursor's `ia` never refreshed. 2) Device reconnects, calls `/sync/changes` with the stale cursor → `410`. 3) Client catches `410`, calls `/sync/initial` (optionally with `reset=true` if local storage was also wiped, or without if it wants to resume/reconcile). 4) Cold start (or resume) completes, yields a fresh `next_delta_cursor`. 5) `/sync/changes` with the new cursor succeeds.
Expected: Full recovery without manual intervention; no data corruption from mixing the old expired cursor's watermarks with the new session.

---

### H. Concurrency

**SP-H01 / Permission revoked between the RBAC check and the query executing (TOCTOU-scale race)**
Area: concurrency/permission · Criticality: Low (practically unreachable window, but worth documenting)
Preconditions: `permissions` is resolved once per pull call (`getCachedPermissions`) and reused for every entity in the loop; a revoke happens mid-loop (between entity 3 and entity 4 of 12).
Expected: The **entire call** uses the permission snapshot taken at the start — entities 1–3 already evaluated under the old (pre-revoke) permissions, 4–12 also evaluate under that same old snapshot (nothing re-fetches mid-loop) — consistent-within-request behavior, not a security hole (worst case: this single response is one cache-TTL "behind" — resolved on the *next* call). Confirm this is the intended "resolved once and reused for all entities in that call" design (§18), not an inconsistency bug.

**SP-H02 / Row committed exactly inside the read-safety-lag window, straddling two devices' polls**
Area: concurrency/business-rule · Criticality: High · Traces to: BR-3
Preconditions: A long-running transaction on Device A's mutation started at `T`, commits at `T+3s` with `modified_at=T` (transaction-start timestamp per the code's trigger design). Device B polls at `T+1s` (before commit) and again at `T+4s`.
Expected: Poll at `T+1s` doesn't see the row (not committed yet — normal MVCC). Poll at `T+4s` sees it (committed, and `modified_at=T` is now `> 2s` old, past the lag) — even though `T` itself is now `4s` in the past relative to poll time, the row is correctly included because the lag is evaluated against **now**, not against when the poll started.

**SP-H03 / Two devices delta-polling the same store simultaneously, no interference**
Area: concurrency · Criticality: Medium
Input: Device A and B call `/sync/changes` with their own distinct cursors at the same instant.
Expected: Independent responses (cursor state lives in the opaque token per-device, not shared server-side mutable state) — no cross-device locking, no serialization needed, both succeed with their own advancing watermarks.

**SP-H04 / Concurrent identical cold-start page request (double-tap / retry storm)**
Area: concurrency · Criticality: Medium · Traces to: `SyncInitProgressRepository.savePage`
Input: Client fires two identical `GET /sync/initial?entity_type=product` requests concurrently (e.g., a buggy retry-without-backoff).
Expected: Both read the same `afterId`, both query the same page, both get the same rows (deterministic keyset) — no duplication or corruption; `savePage` is a plain `UPDATE`, so the later-committing one just overwrites with the same value (idempotent), no unique-constraint error, no lost update beyond "wrote the same thing twice."

---

### I. Permission / role dimension (beyond staff-specific D09–D11)

**SP-I01 / Permission version bump on `/sync/delta`'s embedded pull vs bare `/sync/changes`' 5-minute lag**
Area: permission/cross-cutting · Criticality: High · Traces to: caching TTL asymmetry noted in §1 BA
Preconditions: `Product:view` revoked at `T`. Device is a "pull-only" kiosk/display screen that **only** calls `GET /sync/changes` (never `/sync/delta`).
Input: Poll at `T+1min` (within the 5-min standard cache TTL).
Expected: The stale cached permission snapshot (issued before `T`) may still show `Product:view=true` for up to 5 minutes — **the entity filter still gates on cached permissions**, so a pull-only device can keep receiving `product` upserts for up to ~5 minutes after revocation. Contrast: a device that also does `/sync/delta` (even with zero mutations, since that still forces the `isCritical=true` fetch during `loadMutationEnv`) sees the revoke reflected within 30s. **Flag as a real staleness window** for read-only devices — see Edge Cases §4.

**SP-I02 / Unknown/typo'd `permissionEntity` code (defensive — registry misconfiguration)**
Area: negative · Criticality: Low · Traces to: `checkCrud` fail-closed
Preconditions: Hypothetical/regression-guard scenario — a filter's `permissionEntity` doesn't match any `EntityCode` (would be a coding bug, not a runtime user input).
Expected: `isEntityCode` returns false → `checkCrud` returns `false` → the entity behaves as "no view" (empty page) — fails closed, never leaks data on a typo.

**SP-I03 / User has `view` on entity but is scoped to zero stores (multi-store, wrong store context)**
Area: permission/tenancy · Criticality: High · Traces to: `TenantGuard` + `storeScope`
Input: User attempts to pull for a `storeId` they have no membership in at all.
Expected: Blocked upstream by `TenantGuard` before reaching the sync controller at all (out of this module, but must be verified as a precondition — a test should confirm `403`/`404` here, not that the pull logic itself silently returns empty).

**SP-I04 / Grant `Customer:view` mid-cold-start (between entity N and N+1), device hasn't reached `customer` yet**
Area: permission/state · Criticality: Medium
Preconditions: Grant happens while cold start is still on, say, `product` (order 90), before `customer` (order 120).
Expected: By the time the loop reaches `customer`, `getCachedPermissions` is re-fetched fresh for **that** call (each `/sync/initial` call re-resolves permissions independently — no cross-call caching of the RBAC decision itself beyond Redis's normal TTL) — so if the grant is already reflected in Redis/DB, `customer` dumps normally. If the grant is still within the old cached-permission TTL window, `customer` gets marked `completed` with zero rows exactly as SP-A11 — same downstream consequence (F-2).

**SP-I05 / Revoke `view` mid-delta-poll-loop for an entity NOT yet processed in this call**
Area: permission/concurrency · Criticality: Low
Covered functionally by SP-H01 (single-snapshot-per-call design) — included here for the permission-dimension coverage matrix cross-reference.

---

### J. Tenancy / multi-store cross-cutting

**SP-J01 / One operator, two stores — cold start of Store A doesn't touch Store B's progress**
Area: cross-cutting/tenancy · Criticality: High · Traces to: BR-9 (PK includes `store_fk`)
Input: Same user+device, cold-start Store A fully, then start cold start of Store B.
Expected: Store B starts from `(none)` for every entity — Store A's `completed` phases are entirely separate rows (different `store_fk`), zero leakage or shortcutting.

**SP-J02 / Same device used to access two different stores — device slot is per-store**
Area: cross-cutting/permission · Criticality: Medium · Traces to: `DeviceSlotGuard` scoping
Input: Device has an active slot in Store A but not Store B; attempts to pull Store B.
Expected: `403 DEVICE_SLOT_REQUIRED` for Store B specifically, unaffected by having a valid slot in Store A.

---

## 4. Edge-case scenarios (§5 checklist — the sneaky ones)

**E-1 (Empty/first-run) — Brand-new store, first device, first cold start.**
Traces to: SP-A01/A10. Every entity returns 0 or few rows; `estimated_total=0` where applicable; `next_delta_cursor` still mints correctly even with all-empty anchors (no divide-by-zero, no null-pointer on an empty progress-row set — `oldestStart` defaults to `now` when no rows exist yet). **Test explicitly: cold start on a store with absolutely zero rows in every one of the 12 entities.**

**E-2 (First-run, permission-gated) — First cold start where the user has `view` on only a subset of entities (e.g., a newly-hired cashier with a minimal role).**
Traces to: SP-A11, F-2. Entities without `view` are marked `completed` with zero rows and no `estimated_total`, permanently anchored at this session's start. **If this user's role is later upgraded to include those entities, historical rows created before the upgrade are never backfilled via delta** (only rows created after the *original* cold-start session's `sessionStartedAt` will ever appear, because that's where the entity's delta watermark was frozen). Recommended test: grant `Customer:view` to a role a week after a cashier's cold start (during which `customer` was skipped), pull `/sync/changes`, and confirm customers created **before** the original cold-start session date never arrive. **This is a data-completeness defect (F-2) unless product confirms client is expected to force a `reset=true` (or at least a per-entity re-`/sync/initial`) whenever its own local permission snapshot gains a new viewable entity** — verify whether the mobile client actually does this (out of this backend's control, but the backend offers no signal to trigger it beyond the general `permissions_version` bump).

**E-3 (Maximum/overflow) — Cursor payload grows unbounded as entities are deprecated/renamed over the product's life.**
Traces to: SP-C08. Because `nextEntities = {...cursor.e}` in `changes.service.ts` **carries forward every key ever put into the cursor**, including entity types later removed from the registry (e.g., the in-flight removal of `location` from `SYNC_ENTITY_TYPES` — see Open Questions A3), a long-lived device's cursor accumulates dead entries forever with no pruning path. At `SYNC_ENTITY_TYPES.length` growing over years, plus the 8192-char cap on `ChangesQuerySchema`, this is a slow-burn boundary risk. **Recommended test: simulate a cursor with 5–10 dead entity keys (mimicking years of deprecations) and confirm the cursor still round-trips under 8192 chars, and decide/verify whether dead-key pruning is needed.**

**E-4 (Decimals/rounding) — Not directly applicable to the pull path (no money math here); N/A for this module, confirmed by inspection — no monetary rounding occurs in cursor/registry/repository code. Sale amounts pass through as opaque payload fields, unrounded by the sync layer.**

**E-5 (Duplicate/repeat) — Same `mutation_id`... N/A to pull; instead, the pull-side duplicate concern is a repeated identical `GET /sync/changes` call with the exact same cursor (double-tap/retry).**
Traces to: SP-B01. Expected: fully idempotent — same cursor twice returns the same (or, if time passed, a superset of) rows; never double-applies anything server-side because pull has no server-side "apply," only "read."

**E-6 (Out-of-order) — A row's `modified_at` moves backward relative to wall-clock delivery order due to the read-safety lag + long transactions.**
Traces to: SP-D02, SP-H02. Explicitly covered — this is the exact scenario `READ_SAFETY_LAG_MS` exists to close.

**E-7 (Concurrent identical) — Two devices cold-starting the very same entity page at the very same instant.**
Traces to: SP-H04, SP-A13.

**E-8 (Offline → sync, long gap) — Device offline exactly 180 days to the millisecond.**
Traces to: SP-C05. Exact-boundary test: `now - ia == SYNC_HORIZON_MS` must NOT 410 (strict `>`); `+1ms` must 410.

**E-9 (Permission/subscription change mid-flow) —**
(a) Permission revoked while a multi-page cold-start loop for that specific entity is in progress (e.g., revoked between page 1 and page 2 of a 3-page `product` dump). Expected: page 2's call re-checks `canView` fresh — becomes `false` mid-entity, returns `{rows:[], hasMore:false}` for page 2 (even though page 1 had already handed out 1000 real rows and the entity wasn't finished) — the entity is marked `completed` with a `page_cursor` frozen mid-way, and the client now has a **partial** copy of that entity (1000 of e.g. 2500 rows) permanently, since delta will also stay dark until re-granted (BR-7). **High-severity edge case — recommend an explicit test.**
(b) Subscription lapses mid-cold-start — no effect on pull per BR-13 (reads always allowed) — confirm explicitly with a test, since it's easy to assume (incorrectly) that a lapsed subscription would pause cold start.

**E-10 (Abandonment/interruption) — App killed mid-page, no retry for hours; when it resumes, does the server's persisted progress still make sense?**
Traces to: SP-A12, SP-G03. Yes — `sync_init_progress` has no TTL/expiry of its own; a week-old half-finished cold start resumes exactly where it left off, since only wall-clock-independent `id` keysets are involved (not time-based, so no horizon-style staleness concern on the *initial* path — only the *delta* cursor's `ia` ages).

**E-11 (Time: DST/timezone) — All watermarks are UTC (`to_char(... at time zone 'UTC' ...)`), so DST transitions and store-local timezones never affect ordering or the keyset.**
Traces to: BR-2. Recommend one explicit regression test around a DST-transition instant in a timezone the store operates in (e.g., India has no DST, but verify no code path assumes `Intl`/local time anywhere in this module — confirmed by inspection there isn't).

**E-12 (Connectivity transitions) — Device goes offline mid-`/sync/changes` call (request sent, response lost).**
Traces to: SP-G01 pattern applied to delta: since the cursor mint happens server-side and is only returned in the (lost) response, the client's locally-stored cursor is untouched — a retry with the same old cursor is fully safe (no-gap rule guarantees no lost rows), at worst re-delivering rows the client already applied (idempotent by `guuid`).

**E-13 (Long/unusual input) — `supported_entity_types` with excessive/duplicate/whitespace-padded entries: `"product, product,  ,customer"`.**
Traces to: `splitTypes`. Expected: `.split(',').map(s=>s.trim()).filter(Boolean)` → `['product','product','customer']` (duplicates NOT de-duped) → `SyncFilterRegistry.supported()` builds a `Set`, so duplicates collapse harmlessly there; a literal empty segment is dropped by `filter(Boolean)`.

**E-14 (State edge — acting on a record type removed from the platform) — the in-flight `location` entity removal.**
Traces to: Open Question A3. If a device's local cursor still has a `location` watermark from before the entity was retired, does the server error, ignore it, or (worse) accidentally re-include it if the registry entry reappears under a different name later? Currently: silently ignored/carried forward inertly (E-3's overflow risk), never actively erroring. **Recommend an explicit regression test once this refactor lands**, to confirm no dangling `Location` `EntityCode` reference anywhere in the RBAC matrices causes a `checkCrud` throw (currently fails closed to `false`, not a throw, per `isEntityCode` guard — so this is actually safe by construction, but should be asserted, not assumed).

---

## 5. Coverage summary — requirement/rule → case matrix

| Rule / requirement | Satisfied case(s) | Violated / edge case(s) | Gap? |
|---|---|---|---|
| BR-1 No-gap watermark advance | SP-B01, SP-B02 | SP-D02 (lag-window straddle), SP-G01 (no partial mint on error) | none |
| BR-2 µs precision | SP-D01 (tie-break) | SP-C11 (ms-precision cursor rejected) | none |
| BR-3 Read-safety lag | SP-D02, SP-H02 | — | none |
| BR-4 Cursor binding/horizon on `ia` only | SP-C05, SP-C06 | SP-C01/C02/C03/C04 (tamper/tenant/user/version) | none |
| BR-5 Future clamp | SP-C07 | — | none |
| BR-6 Fair share + floor | SP-F01, SP-F02 | SP-F03 (zero-filter guard) | none |
| BR-7 RBAC entity gate (delta doesn't advance / initial marks completed) | SP-A11, SP-D09/D10 | E-2, E-9(a) (asymmetric consequence) | **flagged (F-2)** |
| BR-8 Shared tombstone stream, unfiltered by RBAC/support list | SP-B04 | SP-B05 (unsupported-entity delete still delivered) | flagged, needs client-behavior confirmation |
| BR-9 Cold-start resumability, per-device PK | SP-A12, SP-A13 | SP-A14 (concurrent-delete race), SP-H04 | none |
| BR-10 Delta-cursor anchoring (own session start, merge existing) | SP-A04, SP-A15 | — | none |
| BR-11 Total dependency order | (build-time guard; not runtime-testable via HTTP) | — | covered by construction, no HTTP case needed |
| BR-12 Device health touch, best-effort | (implicit in every happy-path case) | SP-G02 | none |
| BR-13 Reads never subscription-gated | SP-E06 | — | none |
| BR-14 Device slot required for pull | SP-E05 | — | none |
| BR-15 Per-device rate-limit keys | SP-E03 | SP-E01, SP-E02 | none |
| Staff membership visibility (via JOIN, not soft-delete) | SP-D10, SP-D11 | SP-D09 | **flagged (F-1) — no tombstone on role revoke** |
| `estimateCount`/progress-bar accuracy | SP-D07 | SP-D08 (absent on later pages) | none |
| Cursor length/entity-type-string boundaries | SP-C08, SP-F06, SP-F07 | — | none |
| New entity mid-life (S-4 anchoring) | SP-A15 | — | none |
| Cross-tenant / cross-user isolation | SP-C02, SP-C03, SP-J01 | — | none |

**Gaps requiring product/dev decision before they can be marked pass/fail (see §7):**
1. **F-1 — Staff tombstone gap**: revoking a user's last role in a store never removes their `staff` row from already-synced devices. No test can "pass" this until a fix or an explicit accepted-risk sign-off exists.
2. **F-2 — Initial-sync permission-gate anchoring**: an entity skipped at cold-start time due to missing `view` freezes its future delta anchor at that moment; a later permission grant never backfills history older than the original cold-start session. Needs a decision: is client-triggered re-`/sync/initial` on permission-version-bump the intended fix, and does the mobile client actually do it?
3. **SP-A09 third case** (malformed UUID in a page cursor) — likely surfaces as a raw DB error instead of a clean `400`; needs verification against actual error-handling middleware (may already be normalized upstream — flagged for confirmation, not assumed broken).
4. **A3 / E-14** — in-flight `location` entity removal: needs a follow-up regression pass once that refactor is committed, to confirm no dangling references anywhere in the RBAC/sync stack.

---

## 6. Priority roll-up — run these first

**Critical (money/auth/data-integrity/concurrency — must pass before any release):**
- SP-C01, SP-C02, SP-C03 (cursor tamper / cross-tenant / cross-user isolation)
- SP-C05 (180-day horizon, both boundary directions)
- SP-D01 (keyset tie-break correctness — infinite-loop-class bug if wrong)
- SP-D05 (soft-deleted rows never leak as upserts)
- SP-D09 (staff revoke → stale-forever data exposure — **F-1**)
- SP-A11 / E-2 (permission-gated cold start → permanent historical gap — **F-2**)
- SP-B02, SP-B08 (basic delta correctness; new-entity-not-in-cursor exclusion)
- SP-E05 (device slot enforcement)
- SP-A04 / SP-A15 (delta-cursor anchoring correctness on cold-start completion and new-entity merge)

**High (core flows, common errors, offline correctness — test next):**
- SP-A02, SP-A06, SP-A12 (multi-page cold start, reset, crash/resume)
- SP-B03, SP-B04, SP-B05 (drain loop, tombstone apply-order, unfiltered tombstone delivery)
- SP-C06 (S-31 low-churn-entity horizon fix)
- SP-D02, SP-H02 (read-safety-lag straddle)
- SP-E01, SP-E02, SP-E03, SP-E06 (rate limits, per-device keying, subscription-never-blocks-reads)
- SP-I01 (permission-cache staleness window on pull-only devices)
- SP-J01, SP-J02 (multi-store isolation)

**Medium/Low:** everything else in §3 — schedule after Critical/High are green, particularly the pure boundary/Zod-limit cases (SP-F06–F08, SP-C08–C11) which are cheap to automate and unlikely to regress silently.

---

## 7. Open questions (need product/dev confirmation)

1. **F-1 (staff tombstone gap):** Is it acceptable that a device never learns a staff member's role was revoked (no tombstone, no upsert reflecting removal — the row just silently stops appearing in future *diffs*, while the *old* copy sits in local storage forever)? If not, does the fix belong here (write a `staff` tombstone on role revoke, keyed off `userRoleMappings`) or does the mobile client separately reconcile its local staff list against a fresh full pull periodically?
2. **F-2 (permission-gated cold-start anchoring):** When a role gains `view` on an entity it didn't have at the device's original cold-start time, is the intended recovery client-triggered (client detects a `permissions_version` bump and calls `/sync/initial?entity_type=X&reset=` for just that entity, or a full reset)? The backend today gives no explicit signal distinguishing "this entity was fully synced" from "this entity was completed-with-zero-because-no-permission" — should `all_entities_complete`/the progress row distinguish those two so the client can react correctly once permission changes?
3. **SP-B05 / BR-8 (tombstones unfiltered by `supported_entity_types` and RBAC):** Is it intentional that an older client (narrower `supported_entity_types`) or a permission-less user still receives delete notices for entity types they don't model/can't view? Confirm client code tolerates unknown keys in `changes.<unknown_type>.deletes` gracefully (no crash), and confirm there's no meaningful information leak in delivering "guuid X was deleted" for an entity type the caller can't `view` (design comment says this is deliberate — "pure sync needs guuid + hard_delete only" — but that's an entity-existence signal, worth an explicit sign-off).
4. **A3 (in-flight `location` removal):** Confirm whether this working-tree change (removing `location` from `SYNC_ENTITY_TYPES`, the RBAC `Location` entity code, and `location.guard.ts`) is a deliberate, in-progress descope that will also clean up the `locations` table's sync trigger/columns and any lingering references elsewhere in RBAC role matrices, or whether it should be treated as incomplete/WIP and excluded from this test pass until it lands and stabilizes.
5. **A4 (`/sync/initial` has no dedicated rate-limit bucket):** Confirm this is intentional (page-size is "the cold-start lever," not request rate) versus a gap that should get its own `SyncRateLimit('initial')` bucket now that `INITIAL_PAGE_SIZE=1000` makes each call meaningfully heavier than a `/sync/changes` call.
6. **SP-A09 (malformed UUID cursor):** Confirm whether a bad-UUID `page_cursor` value is caught by a global Postgres-error-to-400 mapping layer elsewhere in the stack (out of this module's own files), or genuinely surfaces as an unhandled 500 — if the latter, this is a legitimate small hardening gap (validate as UUID shape in the Zod schema or a manual regex check before the query runs).
7. **E-9(a) (permission revoked mid-multi-page cold start):** Confirm the expected client behavior for a partially-dumped, now-permission-less entity (1000 of 2500 rows locally, marked "complete" server-side) — should the client purge those 1000 rows too (mirroring the RBAC claw-back discussion for steady-state), or is a partial-but-frozen local copy acceptable?
8. **Unicode/long-text fields (SP-F08):** Confirm the client's SQLite schema and rendering layer are expected to accept arbitrary Unicode (including RTL scripts and emoji) verbatim with no length truncation on any synced text column — the backend applies no sanitization or length enforcement beyond the underlying DB column type at the pull layer.