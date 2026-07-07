# Offline-First Sync Engine — Ayphen Retail Mobile ⇄ Backend

> **App:** Ayphen Retail (React Native · Expo · Expo Router · offline-first POS)
> **Mobile stack:** Drizzle ORM over `expo-sqlite` (device) / `better-sqlite3` (tests) ·
> `@react-native-community/netinfo` · React Native `AppState` · Zustand
> **Backend stack:** NestJS · Drizzle ORM over Postgres · Zod validation · `@nestjs/throttler`
> **Status:** Canonical, derived directly from the code in `apps/mobile/src/core/sync/`,
> `apps/mobile/src/features/sync/`, and `apps/backend/src/sync/` (plus the shared
> `apps/backend/src/db/schema.ts` / `sync-columns.ts`). Every factual claim below is cited to its
> source file; anything not confirmed in code is explicitly marked "not found."

---

## Table of Contents

1. [Overview](#1-overview)
2. [File Inventory](#2-file-inventory)
3. [Data Model](#3-data-model)
4. [Flows (End-to-End, Cross-Layer)](#4-flows-end-to-end-cross-layer)
5. [Business Rules (Invariants)](#5-business-rules-invariants)
6. [Business Logic (Per-Component)](#6-business-logic-per-component)
7. [API Contract](#7-api-contract)
8. [Mobile Implementation Details](#8-mobile-implementation-details)
9. [Sync & Offline Mechanics](#9-sync--offline-mechanics)
10. [Seed & Reference Data](#10-seed--reference-data)
11. [Dependencies & Coupling](#11-dependencies--coupling)
12. [Open Questions / Not Found](#12-open-questions--not-found)

---

## 1. Overview

The sync module is a **cursor-based, offline-first delta-sync engine**. Mobile keeps a local
SQLite mirror (Drizzle over `expo-sqlite`) of a subset of Postgres tables, scoped per store. Two
independent flows move data:

- **Pull** — server → device. Cold start (`GET /sync/initial`, one entity type per page,
  resumable) followed by steady-state delta pulls (`GET /sync/changes`, cursor-based, includes
  tombstones for deletes).
- **Push** — device → server. Local writes are appended to an outbound `mutation_queue`
  (6-state machine: `pending|inflight|applied|rejected|conflict|dead`) and drained via
  `POST /sync/delta`, which also piggybacks a delta pull in its response.

The engine is built around two hard invariants that recur everywhere in this doc:

- **INV-9 (no-gap cursor commit):** a sync cursor/watermark may only advance in the **same
  transaction** as the rows it claims are durable. Advancing it separately risks silently
  skipping rows forever if the process crashes between the two writes
  (`apps/mobile/src/core/sync/engine/apply-changes.ts`, `apps/mobile/src/core/sync/engine/cold-start.ts`).
- **Push-before-pull:** every sync cycle drains the local mutation queue before pulling deltas,
  so a pull never clobbers or manufactures conflicts against not-yet-pushed local edits
  (`apps/mobile/src/core/sync/engine/sync-engine.ts`).

A third invariant gates everything: **migrate-before-sync** — Drizzle migrations must resolve
before any cold start / delta pull / queue drain touches the local DB
(`apps/mobile/src/core/sync/db/client.ts`, `apps/mobile/src/core/sync/engine/sync-engine.ts`).

Mobile registers **8 entity types** with local appliers (`store, unit, taxrate, lookup,
payment_method, product, product_case, customer` —
`apps/mobile/src/core/sync/appliers/appliers.registry.ts`). The backend's pull-side registry
supports **13** (`apps/backend/src/sync/sync.constants.ts`: adds `store_device_access, location,
staff, paymentaccount, supplier`), and its push-side registry supports **6** mutation handlers
(`lookup, product, product_case, customer, supplier, paymentaccount` —
`apps/backend/src/sync/sync.module.ts`). Section 11 documents this gap in full — it is real,
current, and load-bearing for what data actually reaches this app build today.

---

## 2. File Inventory

### 2.1 Mobile — `apps/mobile/src/core/sync/`

| File | Role |
|---|---|
| `appliers/applier.types.ts` | `SyncApplier` interface — `entityType`, `upsertAll()`, `applyDeletes()`; the seam every entity plugs into the apply pipeline through. |
| `appliers/appliers.registry.ts` | `AppliersRegistry` — registers the 8 supported entity appliers in parent→child order; `entityTypes()` doubles as the client's `supported_entity_types` wire list. |
| `db/client.ts` | Singleton `expo-sqlite` connection, `getSyncDb()` (widened cross-driver type) vs `getSyncDbForQueries()` (concrete type for `useLiveQuery`), and `runMigrations()` (the migrate-before-sync gate). |
| `db/schema.ts` | Drizzle schema for all 13 local tables — 8 synced entity tables + `syncCursors`, `syncInitProgress`, `mutationQueue`, `failedApplies`, `schemaMeta`. |
| `db/types.ts` | `SyncDb` — the driver-agnostic `BaseSQLiteDatabase<'sync', unknown, SyncSchema>` type every repository is written against. |
| `db/transaction.ts` | `withTransaction()` — manual `BEGIN`/`COMMIT`/`ROLLBACK` plus a module-level promise-chain mutex serializing every transaction across independent call sites. |
| `db/transaction.test.ts` | Proves cross-call-site serialization and no lost writes under real concurrent timing (real in-memory SQLite, not mocks). |
| `db/__testing__/create-test-db.ts` | Builds an in-memory `better-sqlite3` DB, runs real migration SQL off disk, for Node-environment tests. |
| `db/migrations/0000_noisy_guardian.sql` | Initial migration — creates all 11 original tables. |
| `db/migrations/0001_tidy_goliath.sql` | Rebuilds `lookups` to add the composite `(store_id, id)` primary key and make `store_id` `NOT NULL`. |
| `db/migrations/migrations-data.ts` | Auto-generated (by `scripts/generate-mobile-migrations.mjs`), filesystem-free, string-inlined migration+journal bundle — what `client.ts` actually loads at runtime. |
| `db/migrations/migrations.js` | Drizzle's own default-generated migrator shape (imports `.sql` files directly via Metro's transform) — superseded by, but co-existing with, `migrations-data.ts`. |
| `db/migrations/meta/0000_snapshot.json` / `0001_snapshot.json` / `_journal.json` | drizzle-kit's schema snapshots and applied-migration manifest. |
| `engine/apply-changes.ts` (+ `.test.ts`) | `applyChangesPage()` — applies one page of pulled changes (forward upserts, reverse deletes) and advances the cursor in one transaction (INV-9). |
| `engine/apply-with-isolation.ts` | Batch-then-per-row fallback so one poison row can't block a whole page; isolated failures land in `failed_applies`. |
| `engine/cold-start.ts` | `runColdStartStep()` / `runColdStart()` — first-sync pagination, one applier's page per step, atomically committing upsert + progress + (on the last page) the delta cursor. |
| `engine/delta-pull.ts` | `pullDeltaToCompletion()` — steady-state incremental pull loop, requires an existing cursor. |
| `engine/drain-queue.ts` | `drainMutationQueueOnce()` — pushes one batch (≤100) of queued mutations, reconciles each result, applies the piggybacked delta page. |
| `engine/reconcile-mutation-result.ts` (+ `.test.ts`) | Pure function mapping a server mutation result (`applied|duplicate|conflict|rejected|retry_later`) to a `ReconcileAction`. |
| `engine/sync-engine.ts` | `SyncEngine` class — `openStore()` (migrate + cold start if needed), `runSyncCycle()` (push-before-pull), `runPush()`, `runPull()`. |
| `engine/sync-scheduler.ts` (+ `.test.ts`) | `SyncScheduler` — heartbeat timer, reentrancy mutex, rate-limit backoff with capped retries. |
| `mutations/enqueue-create-product.ts` | Example write path: optimistic local insert + queue enqueue in one transaction, then a best-effort immediate-sync kick. |
| `mutations/resolve-conflict.ts` | `takeServerVersion()` / `resubmitMine()` — the two conflict-resolution actions. |
| `mutations/ulid.ts` | Custom ULID generator using `expo-crypto` as the PRNG (fixes an RN/Metro `nodeCrypto.randomBytes` crash). |
| `repositories/customer.repository.ts`, `payment-method.repository.ts`, `product-case.repository.ts`, `product.repository.ts`, `store.repository.ts`, `tax-rate.repository.ts`, `unit.repository.ts` | Thin per-entity wrappers over the generic synced-table factory. |
| `repositories/lookup.repository.ts` (+ `.test.ts`) | Same factory, but overrides `conflictTarget` to the composite `(storeId, id)` key. |
| `repositories/failed-applies.repository.ts` | Pull-side DLQ repo — `record()` / `listByStore()` (no clear/delete method exists). |
| `repositories/mutation-queue.repository.ts` | Full CRUD + state-machine transitions for `mutation_queue`. |
| `repositories/sync-cursor.repository.ts` | Per-store opaque delta cursor get/set/clear. |
| `repositories/sync-init-progress.repository.ts` | Per (store, entityType) cold-start resume position. |
| `repositories/synced-table.repository.ts` | Generic factory (`createSyncedTableRepository`) every per-entity repo wraps. |
| `scheduler-instance.ts` | Module-level singleton binding one `SyncScheduler` to the active store; `initSyncListeners()` wires NetInfo + AppState. |
| `store-open-status.ts` | `useStoreOpenStatus` (Zustand) — reactive `idle\|opening\|ready\|error` readiness gate for the currently open store. |
| `use-sync-store-binding.ts` | React hook — starts/stops the scheduler as the active store id changes. |
| `transport/rate-limit-error.ts` (+ `.test.ts`) | `RateLimitedError` + `rethrowIfRateLimited()` — parses `Retry-After` (seconds → ms) off a 429. |
| `transport/sync-transport.ts` | Axios-based HTTP client for all 5 sync endpoints. |
| `transport/sync-wire-types.ts` | Every request/response TypeScript shape, verified against backend code (not the PRDs). |

### 2.2 Mobile — `apps/mobile/src/features/sync/`

| File | Role |
|---|---|
| `index.ts` | Re-exports `ConflictsScreen` — the feature's entire public surface. |
| `screens/ConflictsScreen.tsx` | 3-section UI: conflicts (actionable), rejected/dead (visibility-only), pull-side DLQ (visibility-only). Live via `useLiveQuery` + `getSyncDbForQueries()`. |
| `utils/format-sync-row.ts` (+ `.test.ts`) | Pure `summarize()` / `entityLabel()` display helpers, deliberately RN-free. |

### 2.3 Mobile wiring points

| File | Role |
|---|---|
| `apps/mobile/src/app/_layout.tsx` | Mounts `initSyncListeners()` and `useSyncStoreBinding()` at the root `RootNavigator`, above all auth/store gating. |
| `apps/mobile/src/app/(store)/sync-issues.tsx` | One-line route re-export of `ConflictsScreen`. |
| `apps/mobile/src/app/(store)/_layout.tsx` | Gates all `(store)` routes (incl. `sync-issues`) behind `AuthGate` + an active `storeId` + `useStoreOpenStatus().phase === 'ready'`. |
| `apps/mobile/src/features/more/utils/menu-config.ts` / `menu-utils.ts` | Menu entry `key: 'sync-issues'` (no permission gating in this app) mapped via `ITEM_ROUTES['sync-issues'] = '/(store)/sync-issues'`. |
| `apps/mobile/src/app/(app)/index.tsx`, `(auth)/otp.tsx`, `(auth)/phone.tsx` | **Confirmed false positives** — matches are `useSyncExternalStore` (a code comment) and `async`/`mutateAsync` substrings, unrelated to this module. |
| `apps/mobile/src/store/activeStore.ts` (via `@store` alias) | `useActiveStoreStore` (Zustand) — holds `store`/`storeId`; the source of truth `use-sync-store-binding.ts` subscribes to. |
| `apps/mobile/jest.config.js` | Two-project split: `sync-engine` (Node env, real SQLite) covers `core/sync/**` and `features/sync/utils/**`; `app` (jest-expo) covers everything else. |

### 2.4 Backend — `apps/backend/src/sync/`

| File | Role |
|---|---|
| `sync.module.ts` | Wires every sync provider; builds `MutationHandlerRegistry` via factory from 6 handler providers; exports only `TombstoneRepository`. |
| `sync.controller.ts` | `@Controller('stores/:storeId/sync')` — the 5 HTTP endpoints. |
| `sync.constants.ts` | Every tunable constant (page sizes, TTLs, horizon, poison cap, entity type list). |
| `us-timestamp.ts` | Microsecond-precision ISO timestamp helpers (`microIso`, `assertMicroIso`, `microIsoFromDate`) underpinning every watermark. |
| `time.controller.ts` | `GET /time` — public, unauthenticated server-clock endpoint for clock-skew bootstrapping. |
| `cursor/sync-cursor.service.ts` | Mints/decodes the HMAC-signed opaque cursor; horizon (410) and tenant/version checks. |
| `dto/sync-delta.schema.ts` | Zod schemas for all request bodies/queries. |
| `dto/response/conflict.response.ts` / `mappers/response/conflict.response-mapper.ts` | Conflict response DTO + row→DTO mapper. |
| `pull/initial-sync.service.ts` | Cold-start pull — one entity type per call, resumable, builds the initial delta cursor on completion. |
| `pull/changes.service.ts` | Steady-state delta pull — fan-out across all cursor-tracked entities with fair-share paging, plus tombstones. |
| `push/delta.service.ts` | Orchestrates `POST /sync/delta` — idempotency, skew clamp, poison cap, parent cascade, authorization, subscription gating, per-mutation transactions. |
| `push/master-data.handler.ts` | Shared abstract write primitive (`MasterDataSyncHandler`) for all 6 concrete handlers — optimistic-lock update, soft-delete, FK resolution. |
| `push/mutation-handler.registry.ts` | Registry mapping entity type → handler, duplicate-registration guard. |
| `push/mutation.types.ts` | `MutationContext`, `HandlerOutcome`, `SyncMutationHandler` interface. |
| `push/handlers/customer.handler.ts`, `lookup.handler.ts`, `payment-account.handler.ts`, `product.handler.ts` (2 handlers), `supplier.handler.ts` | The 6 concrete `MasterDataSyncHandler` subclasses. |
| `push/handlers/payload-helpers.ts` | `money`, `quantity` Zod transforms; `prune()` (drop `undefined` keys). |
| `registry/entity-filter.ts` | `SyncEntityFilter` interface, `GenericSyncFilter` generic implementation, scope-where helpers. |
| `registry/sync-filter.registry.ts` | Registers 13 filters (12 generic + 1 custom `StaffSyncFilter`); `supported()` intersects with client's declared types. |
| `repositories/device-sync-health.repository.ts` | Stamps `devices.last_sync_at` (best-effort, swallow-and-log). |
| `repositories/sync-conflict.repository.ts` | CRUD for `sync_conflicts`. |
| `repositories/sync-idempotency.repository.ts` | Duplicate-detection by `(mutation_id, user_fk)`, TTL-gated liveness, race-claim via `onConflictDoNothing`. |
| `repositories/sync-init-progress.repository.ts` | Server-side cold-start progress per (store, device, entity). |
| `repositories/sync-mutation-failure.repository.ts` | Poison-mutation failure counter, written on the root connection after rollback. |
| `repositories/tombstone.repository.ts` | Tombstone write (mandatory tx param) + keyset pull. |
| `services/sync-conflict.service.ts` | `list()` / `resolve()` for the conflicts endpoints — bookkeeping only, no merge. |

### 2.5 Backend schema

| File | Role |
|---|---|
| `apps/backend/src/db/sync-columns.ts` | `syncColumns()` factory — `guuid`, `rowVersion`, `modifiedAt`, spread into every synced table. |
| `apps/backend/src/db/audit.ts` | `auditColumns` — `createdAt/updatedAt/deletedAt/createdBy/updatedBy/deletedBy` (plain object, not a factory). |
| `apps/backend/src/db/schema.ts` | Full Postgres schema; sync-relevant tables covered in §3.2. |

---

## 3. Data Model

### 3.1 Mobile SQLite schema (`apps/mobile/src/core/sync/db/schema.ts`)

Header comment states this is a **wire projection**, not the full backend row — a column's
absence here means the backend doesn't sync it. Every synced row's `modifiedAt` is stored
verbatim as a µs-precision TEXT ISO string, never round-tripped through `Date` (schema.ts:19-22,
labeled "S-8" in the code). All synced tables carry `storeId` as an ordinary column (not a
per-store SQLite file); evicting an unused store is a `DELETE`, not a file operation
(schema.ts:15-17).

**Synced entity tables** (all have `id` PK, `storeId`, `guuid`, `modifiedAt`; all but `stores`
also have `rowVersion`):

| Table | Extra columns | PK |
|---|---|---|
| `stores` | `name, gstNumber, address, phone, email, invoicePrefix, isActive, locked` — **no `rowVersion`** (pull-only, never pushed) | `id` |
| `units` | `name, abbreviation, allowsFractions, isActive, rowVersion` | `id` |
| `taxRates` | `name, ratePercent` (canonical string, not float), `isInclusive, isActive, rowVersion` | `id` |
| `lookups` | `lookupTypeFk, code, label, description, sortOrder, isHidden, isSystem, isActive, rowVersion` | **composite `(storeId, id)`** — added by migration `0001_tidy_goliath.sql` |
| `paymentMethods` | `code, label, kind, sortOrder, isSystem, isActive, rowVersion` | `id` |
| `products` | `name, sku, barcode, categoryLookupFk, unitFk, taxrateFk, sellingPrice` (canonical 2dp string), `costPrice, mrp, hsnCode, trackInventory, isActive, rowVersion` | `id` |
| `productCases` | `productFk, name, quantity` (up to 3dp string), `barcode, sellingPrice, isActive, rowVersion` | `id` |
| `customers` | `name, phone, email, gstNumber, customerTypeLookupFk, creditLimit, isActive, rowVersion` | `id` |

**Why `lookups` has a composite PK:** the server's `store_fk` is nullable (global-or-store
scope), but the mobile `fromWire()` mapper always stamps the caller's active `storeId` locally.
A single-column `id` PK would mean a second store's sync silently overwrites the first store's
local `storeId` stamp on a shared global row via `onConflictDoUpdate(target: id)` — a multi-store
device would see a lookup value vanish from one store. The composite `(storeId, id)` PK (added
in migration `0001_tidy_goliath.sql`, confirmed via `meta/0001_snapshot.json`'s
`compositePrimaryKeys` entry) keeps each store's copy independent
(`db/schema.ts:67-79`, `repositories/lookup.repository.ts:6-11`, tested in
`repositories/lookup.repository.test.ts`).

**Client-only bookkeeping tables** (no server counterpart, or a 1:1 local mirror of one):

| Table | Columns | PK |
|---|---|---|
| `syncCursors` | `storeId, token` (opaque, HMAC-signed — never parsed client-side), `updatedAt` | `storeId` |
| `syncInitProgress` | `storeId, entityType, cursor` (nullable, `"entityType:lastId"`), `phase` (`in_progress\|completed`), `updatedAt` | composite `(storeId, entityType)` |
| `mutationQueue` | `mutationId` (ULID, also the server idempotency key), `storeId, entityType, entityGuuid, action` (`create\|update\|delete`), `payload` (JSON text), `expectedRowVersion` (required for update), `clientModifiedAt, parentGuuid, priority` (default 0), `status` (`pending\|inflight\|applied\|rejected\|conflict\|dead`, default `pending`), `attempts` (default 0), `nextAttemptAt, serverRow` (JSON, populated on conflict), `firstFailureAt, lastFailureAt, errorCode, errorMessage, createdAt` | `mutationId` |
| `failedApplies` | `id` (autoincrement), `storeId, entityType, entityGuuid, data` (JSON of the row that failed), `attempts` (default 0), `lastAttemptAt, lastError` | `id` |
| `schemaMeta` | `id, version, migratedAt` — single-row local schema version gate ("migrate-before-sync," INV-5) | `id` |

No canonical `SYNCED_ENTITY_TYPES` enum/const is exported from `schema.ts` itself — `entityType`
columns are free-text; the canonical list lives in `appliers.registry.ts`'s registration order.

### 3.2 Backend Postgres schema (sync-relevant tables)

`apps/backend/src/db/sync-columns.ts` exports `syncColumns()` as a **factory function** (not a
shared object) — `guuid` (uuid, not null, `defaultRandom()`, `.unique()`), `rowVersion`
(integer, default 1), `modifiedAt` (timestamptz, `defaultNow()`). It must be invoked fresh
(`...syncColumns()`) at every table because `.unique()` bakes a fixed constraint name into the
builder instance; sharing one object instance across tables would collide constraint names
(`sync-columns.ts:14-18`). `rowVersion` is bumped by a DB trigger (`sync_touch_row`) on `UPDATE`
unless the statement itself already set it; `modifiedAt` is maintained **only** by that trigger,
never application code, and is read back at µs precision via `to_char(.., 'US')`
(`sync-columns.ts:3-13`, `us-timestamp.ts`).

`stores` and `lookup` predate/bypass `syncColumns()` and hand-roll their own
`guuid`/`modifiedAt`(/`rowVersion`) columns.

| Table (schema.ts) | PK | Sync columns | Store scoping | Notable |
|---|---|---|---|---|
| `stores` (81-105) | `id` | `guuid`, `modifiedAt` inline — **no `rowVersion`** (pull-only, never pushed) | is the store itself | FK `accountFk → accounts.id`; `idx_stores_account` |
| `locations` (113-143) | `id` | `...syncColumns()` | `storeFk → stores.id` cascade | "pull-only for now — no mutation handler yet"; partial-unique `isPrimary`/`isDefault` per store; `idx_locations_sync(storeFk, modifiedAt, id)` |
| `lookupType` (747-755) | `id` | none | global | reference-only, no store scoping |
| `lookup` (757-795) | **`id` (single column)** | `guuid`, `rowVersion`, `modifiedAt` inline (predates `syncColumns()`) | `storeFk` **nullable** (null = global, set = store-custom) | Composite **unique** (not PK) `uk_lookup_type_id (lookupTypeFk, id)` for future composite-FK targeting; `idx_lookup_sync(modifiedAt, id)` — no `storeFk` prefix, since the store filter is `(storeFk IS NULL OR storeFk = :store)`, not an equality prefix |
| `units` (937-952) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | `idx_units_sync(storeFk, modifiedAt, id)` |
| `taxRates` (956-971, table `taxrates`) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | `ratePercent numeric(6,3)`; "pull-only for now" |
| `paymentMethods` (975-993) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | unique `(storeFk, code)`; "pull-only for now" |
| `paymentAccounts` (997-1014) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | writable via sync; FK `paymentMethodFk → paymentMethods.id` nullable |
| `products` (1021-1049) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | deliberately **no `stock_quantity`** column (stock is a separate event-sourced ledger so recomputes don't pollute `modifiedAt`); partial-unique `(storeFk, sku) WHERE sku IS NOT NULL AND deletedAt IS NULL` |
| `productCases` (1053-1071) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` + `productFk → products.id`, both cascade | `quantity numeric(12,3)` = base units per case |
| `customers` (1075-1094) | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | `customerTypeLookupFk → lookup.id` nullable |
| `suppliers` | `id` | `...syncColumns()` + `...auditColumns` | `storeFk` cascade | (fields per `supplier.handler.ts`: name, phone, email, gstNumber, isActive) |

Sync-infrastructure tables:

| Table | PK | Notes |
|---|---|---|
| `syncTombstones` (1124-1141) | `id` | unique `(entityType, entityGuuid)` (idempotent re-delete key); `idx_tombstones_stream(storeFk, deletedAt, id)`; retention `TOMBSTONE_RETENTION_DAYS` = `SYNC_HORIZON_DAYS(180) + 15` = 195 days — deliberately longer than the 180-day cursor horizon so no still-valid cursor can miss a tombstone |
| `syncInitProgress` (1150-1164) | **composite `(storeFk, deviceFk, entityType)`** | per-device cold-start progress; own `sessionStartedAt` per entity row |
| `syncMutationIdempotency` (1173-1189) | composite `(mutationId, userFk)` | `storeFk` here has no `.references()` FK |
| `syncMutationFailures` (1196-1209) | composite `(mutationId, userFk)` | poison-mutation counter |
| `syncConflicts` (1215-1238) | `id` | unique `(mutationId, userFk)`; `idx_sync_conflicts_store_status(storeFk, status)` |

**Correction to a prior assumption:** `lookup`'s primary key is a single column (`id`), not a
composite `(store_id, id)` — that composite PK exists only on the **mobile** `lookups` table
(§3.1). The backend's composite-PK table is `syncInitProgress`, keyed
`(store_fk, device_fk, entity_type)`.

### 3.3 Wire types (`apps/mobile/src/core/sync/transport/sync-wire-types.ts`)

- `InitialResult` — `entity_type, upserts, has_more, page_cursor, all_entities_complete, remaining_entity_types, estimated_total?, next_delta_cursor?, server_time`.
- `TombstoneWireRow` — `entity_type, guuid, entity_id, deleted_at, hard_delete`.
- `EntityChanges` — `{ upserts: WireRow[]; deletes: TombstoneWireRow[] }`.
- `ChangesResult` — `changes: Record<string, EntityChanges>, sync_cursor, has_more, server_time`.
- `SyncMutationInput` — `mutation_id, entity_type, action, payload, expected_row_version?, client_modified_at?, parent_guuid?`.
- `MutationResultWire` — discriminated union on `status`: `applied | duplicate | rejected | retry_later | conflict`, each with its own fields (row_version/data on applied; cached on duplicate; code/message on rejected & retry_later; server_row/message on conflict).
- `SyncDeltaResult` — `mutation_results, changes, sync_cursor, has_more, server_time, permissions_version, snapshot?, snapshot_signature?`.
- `ConflictResponse` / `ConflictListResponse` — mirrors the backend `ConflictResponse` DTO.

Header comment notes these shapes were verified directly against backend code, not PRDs, which
have drifted (no `/sync/manifest` endpoint exists; `retry_later` is real but undocumented in the
PRD).

---

## 4. Flows (End-to-End, Cross-Layer)

### 4.1 App cold start / first sync

1. `use-sync-store-binding.ts` fires when `useActiveStoreStore`'s `storeId` becomes non-null →
   `startSyncForStore(storeId)` (`scheduler-instance.ts:24-42`).
2. `startSyncForStore` constructs a fresh `SyncScheduler`, sets `useStoreOpenStatus` to
   `opening`, and calls `scheduler.openStoreOnce()` — unwrapped, errors surface immediately so
   the readiness gate never reports "ready" over a failed cold start
   (`sync-scheduler.ts:70-72`).
3. `SyncEngine.openStore()` runs `runMigrations()` (migrate-before-sync, idempotent), then checks
   `syncCursorRepository.get(db, storeId)` — a `null` cursor means cold start hasn't completed,
   so `runColdStart(db, storeId)` runs (`engine/sync-engine.ts:27-34`).
4. `runColdStart` loops `runColdStartStep`: each step calls `GET /sync/initial` with the full
   8-entity `supported_entity_types` list plus resume hints (local `syncInitProgress` row's
   `entityType`/`cursor`, preferred over asking the server fresh because the server marks a page
   "sent" the moment it's generated, not once durably applied client-side —
   `engine/cold-start.ts:18-26`).
5. Server-side, `InitialSyncService.pull()` picks the next entity in `dependencyOrder` whose
   progress isn't `completed`, gates on RBAC `view` permission (no permission → empty page, still
   marked completed), pages by `id ASC` keyset (`INITIAL_PAGE_SIZE` = 1000), and persists its own
   per-(store, device, entity) progress row (`pull/initial-sync.service.ts:59-150`).
6. Mobile applies the page inside **one transaction**: `upsertWithIsolation()` for the rows,
   `syncInitProgressRepository.savePage()` for the local progress marker, and — **only** once the
   server reports `all_entities_complete && next_delta_cursor` — the delta cursor itself
   (`engine/cold-start.ts:44-70`). This is INV-9's cold-start counterpart: splitting the final
   cursor write into a separate call would mean a crash between "every entity completed" and
   "cursor written" forces a full cold-start re-run next launch, even though nothing was actually
   lost.
7. Once `openStoreOnce()` resolves, `useStoreOpenStatus` flips to `ready` for this `storeId`
   (guarded against stale callbacks from a superseded store switch —
   `store-open-status.ts:33-40`), unblocking `(store)/_layout.tsx`'s gate. `scheduler.start()`
   then begins the periodic heartbeat.

### 4.2 Steady-state delta pull

1. `pullDeltaToCompletion(db, storeId)` loops: read the local cursor (throws if absent — cold
   start must run first), call `GET /sync/changes`, apply the page via the shared
   `applyChangesPage()`, repeat while `has_more` (`engine/delta-pull.ts`).
2. Server-side, `SyncChangesService.pull()` decodes the cursor (400/410 on invalid/expired),
   filters to entities the cursor already tracks (a brand-new entity type must cold-start via
   `/sync/initial` first), computes a fair-share per-entity page budget
   (`max(floor(200/entityCount), 20)`), and for each entity gated by RBAC `view` fetches a
   `(modified_at, id)` keyset page. An unauthorized entity gets an empty page **without**
   advancing its watermark, so a later permission re-grant resumes from where it stopped rather
   than permanently missing the gap (`pull/changes.service.ts:77-90`).
3. Tombstones are pulled as one shared `(deleted_at, id)` keyset stream across the whole store
   and merged per-entity into the response (`repositories/tombstone.repository.ts:68-107`).
4. Mobile's `applyChangesPage()` applies every entity's upserts (forward registration order),
   then every entity's deletes (reverse order), then advances the cursor — all in one transaction
   (`engine/apply-changes.ts:47-67`).

### 4.3 Local mutation creation → queue → push → server apply → response → reconciliation

Using `enqueueCreateProduct()` as the concrete example (`mutations/enqueue-create-product.ts`):

1. Client generates a `guuid` (`Crypto.randomUUID()`) used as the **temp local `id`** (no server
   id exists yet) and a `mutationId` (custom `ulid()`).
2. One transaction does both: `productRepository.upsertAll()` (optimistic local insert, `id ===
   guuid`, `row_version: 0` placeholder) and `mutationQueueRepository.enqueue()` (status
   `pending`, snake_case wire-shaped `payload`) (`enqueue-create-product.ts:37-79`).
3. `requestImmediateSync()` fires a best-effort push+pull cycle right away
   (`enqueue-create-product.ts:81`, `scheduler-instance.ts:89-91`).
4. `drainMutationQueueOnce()` takes up to `MAX_BATCH = 100` pending rows (priority DESC, then
   FIFO by `createdAt`), marks them `inflight` **before** the network call, and posts
   `POST /sync/delta` with the current cursor + `supported_entity_types` + the batch
   (`engine/drain-queue.ts:42-53`).
5. Server-side, `SyncDeltaService.process()` validates the cursor up front, dependency-sorts
   mutations by `parent_guuid` (topo sort, so parents in the same batch apply before children
   regardless of client order), and processes each sequentially through `processOne()`
   (`push/delta.service.ts:121-209`). Section 6 documents the full preflight chain.
6. For an entity handler (e.g. `ProductMutationHandler`), `create` validates via Zod, resolves
   FKs by guuid, and inserts scoped to `ctx.storeId`. Unique-violations bubble up and are mapped
   to `rejected DUPLICATE_ENTRY` by the pipeline's savepoint wrapper
   (`push/master-data.handler.ts:127-151`, `push/delta.service.ts:588-606`).
7. The idempotency row commits **in the same transaction** as the business write via
   `claim()` (`onConflictDoNothing`) — "the idempotency row commits with the business write or
   not at all" (`push/delta.service.ts:364-427`).
8. Response comes back with a `mutation_results[]` entry (`status: 'applied'`, `row_version`,
   `data`). Mobile's `reconcileMutationResult()` (pure function) maps this to `{ kind:
   'commit-applied', ... }` (`engine/reconcile-mutation-result.ts:37-44`).
9. `drainMutationQueueOnce()`, inside its own transaction per mutation (INV-10, push's INV-9
   analogue), handles `commit-applied` by: if the original action was `create`, first deleting
   the **temp** local row by its old guuid-as-id (`applier.applyDeletes`), then upserting the
   **authoritative** server row (real server `id`), then marking the queue row `applied`
   (`engine/drain-queue.ts:69-87`).
10. Any piggybacked delta page in the same response (`result.sync_cursor` present) is applied
    through the same `applyChangesPage()` used by steady-state pull
    (`engine/drain-queue.ts:113-115`).

### 4.4 Conflict detection and resolution

- Conflicts only arise from `action: 'update'` against `MasterDataSyncHandler`'s optimistic lock
  (`mutations/resolve-conflict.ts:9-14`). The update is a single atomic
  `UPDATE ... WHERE guuid=? AND storeFk=? AND alive AND rowVersion=expected` — no
  read-then-compare race window (`push/master-data.handler.ts:155-207`). Zero rows affected is
  disambiguated by a follow-up read: row missing → `rejected NOT_FOUND`; row soft-deleted →
  `rejected NOT_FOUND`; row alive but version mismatched → `conflict` with the live server row
  and a message like `"stale row_version: expected 3, server has 5"`.
- The conflict is recorded server-side in `sync_conflicts` inside the same transaction
  (`push/delta.service.ts:364-427`, `repositories/sync-conflict.repository.ts:37-52`) and, on the
  wire, surfaces as `MutationResultWire.status === 'conflict'` with `server_row` +
  `message`. Mobile's `reconcileMutationResult()` returns `{ kind: 'mark-conflict', serverRow,
  message }`, and `drainMutationQueueOnce()` calls `mutationQueueRepository.markConflict()` —
  the local queue row transitions to `status: 'conflict'` and stores `serverRow` (no separate
  local "conflicts" table — the mutation_queue row itself carries the conflict data)
  (`engine/reconcile-mutation-result.ts:47-52`, `engine/drain-queue.ts:93-94`).
- **`ConflictsScreen.tsx`** live-queries `mutationQueue WHERE storeId=? AND status='conflict'`
  and renders two actions per row:
  - **Keep server** → `takeServerVersion(storeId, row)` — parses `row.serverRow`, upserts it into
    the local table via the entity's applier, then `mutationQueueRepository.remove()` (the queue
    row is deleted, not status-flagged), all in one transaction
    (`mutations/resolve-conflict.ts:23-34`).
  - **Keep mine** → `resubmitMine(storeId, row)` — removes the old conflict row and enqueues a
    **fresh** mutation with a **new** `ulid()` `mutationId`, re-using the **original stored**
    `mutation_queue.payload` JSON, but with `expectedRowVersion` rebased to the server's new
    `row_version` from `serverRow`; no per-entity update-mutation-builder is needed because the
    payload is simply replayed verbatim (`mutations/resolve-conflict.ts:44-67`).
- Server-side `PATCH /sync/conflicts/:mutationId` is bookkeeping only — it flips
  `sync_conflicts.status` to `resolved`/`discarded` and never merges data; the actual fix is the
  client's `resubmitMine()` resubmission under the corrected row_version
  (`services/sync-conflict.service.ts`, `sync.controller.ts:124`). **Mobile's transport layer
  exposes `listConflicts`/`resolveConflict` calls (`transport/sync-transport.ts:93-118`) but
  `ConflictsScreen.tsx` does not call them** — it resolves purely against the local
  `mutation_queue` conflict rows. See §12 for this gap.

### 4.5 Push-side rejection and dead-lettering

- A **rejected** result (`status: 'rejected'`, e.g. `NOT_FOUND`, `VALIDATION_FAILED`,
  `DUPLICATE_ENTRY`, `SUBSCRIPTION_LAPSED_AT_WRITE`) is terminal: `reconcileMutationResult()`
  returns `{ kind: 'rollback', code, message }`, and `drainMutationQueueOnce()` calls
  `mutationQueueRepository.markRejected()` — **inflight → rejected**. The engine explicitly does
  not attempt to revert the optimistic local write itself: "the optimistic local write must be
  reverted by the feature code that made it... this only updates queue bookkeeping"
  (`engine/drain-queue.ts:97-103`).
- **`retry_later`** (e.g. `SUBSCRIPTION_RECONCILIATION_REQUIRED`, `SUBSCRIPTION_SUSPENDED`,
  `SUBSCRIPTION_NOT_FOUND`) is deliberately distinct: `reconcileMutationResult()` returns `{
  kind: 'keep-queued' }`, and `mutationQueueRepository.recordRetryLater()` sets `status` back to
  `pending` (**inflight → pending**) without touching the failure/attempt counters — a paused
  subscription can legitimately persist indefinitely and must not be confused with a rejection
  (both the mobile and backend code carry an explicit "must never be treated like rejected"
  comment; tested directly in `reconcile-mutation-result.test.ts`).
- Separately, `mutationQueueRepository.recordTransientFailure()` implements a **client-local**
  dead-letter path: increments `attempts`; once `attempts >= MAX_ATTEMPTS_BEFORE_DEAD` (7),
  status becomes `dead` instead of `pending`
  (`repositories/mutation-queue.repository.ts:23, 125-147`). This path is not exercised inside
  `drain-queue.ts` itself for the 429/normal-error cases observed in this codebase — see §12.
- Server-side, `SyncMutationFailureRepository.bump()` tracks a parallel **poison-mutation**
  counter keyed `(mutationId, userFk)`, written on the root connection **after** any rollback
  (so the count itself survives the failed handler's rollback). Once
  `count >= POISON_MUTATION_MAX_FAILURES` (7), the mutation is terminally rejected with
  `SERVER_ERROR` and that result is cached in the idempotency table; below the threshold it's
  rejected **uncached** so a retry can still succeed
  (`push/delta.service.ts:453-467`, `repositories/sync-mutation-failure.repository.ts`).
- `ConflictsScreen.tsx`'s "Couldn't be sent" section lists `mutationQueue WHERE status IN
  ('rejected','dead')` as **visibility only** — no resubmit action, because a rejection means the
  server refused the payload itself (resubmitting unchanged would just be rejected again) and a
  generic rollback would need entity-specific knowledge the screen doesn't have
  (`ConflictsScreen.tsx`, citing the same reasoning as `reconcile-mutation-result.ts`).

### 4.6 Pull-side apply failure and DLQ

- `upsertWithIsolation()`/`deleteWithIsolation()` try a whole page as one batch call first; on
  any throw, they fall back to one row (or one guuid) at a time. Only rows that **also** fail
  individually are recorded into `failedApplies` via `failedAppliesRepository.record()` — every
  other row in the page still applies (`engine/apply-with-isolation.ts:17-57`).
- This isolation happens **inside** the same transaction as the rest of the page, so the cursor
  still advances past the poison row — re-fetching the same bad row forever would otherwise wedge
  that store's sync permanently (proven directly in `apply-changes.test.ts`'s "isolates a poison
  row to the DLQ instead of blocking the whole page" test).
- `ConflictsScreen.tsx`'s "Couldn't apply" section lists all `failedApplies` rows for the store —
  visibility only; no client action can force an apply that depends on data (e.g. a missing FK)
  not yet synced. **No repository method exists to clear/retry a `failedApplies` row** — see §12.

### 4.7 Rate-limit backoff

- Backend's `@nestjs/throttler` returns 429 with a `Retry-After` header (seconds). Mobile's
  `rethrowIfRateLimited()` classifies any axios 429 into `RateLimitedError(retryAfterMs)`,
  converting seconds→ms, falling back to `DEFAULT_RETRY_AFTER_MS = 30_000` if the header is
  missing/unparseable (`transport/rate-limit-error.ts`).
- `SyncScheduler.runExclusive()` catches `RateLimitedError` specially: `consecutiveRateLimits`
  increments; once it exceeds `MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 3`, the scheduler gives up on
  immediate retry and falls back to the normal heartbeat. Otherwise it schedules a one-shot
  `setTimeout` retry at `min(err.retryAfterMs, MAX_RATE_LIMIT_RETRY_DELAY_MS)` where
  `MAX_RATE_LIMIT_RETRY_DELAY_MS = 2 * 60_000` (2 minutes) (`engine/sync-scheduler.ts:15-20,
  155-176`). Any non-rate-limit success resets `consecutiveRateLimits` to 0; any non-rate-limit
  **error** also resets the counter (treated as unrelated) but is only logged, never rethrown —
  every entry point runs unawaited, so an uncaught rejection here would crash the app with no
  catch to land in (`engine/sync-scheduler.ts:125-140`). Logged at `warn`, not `error` ("a 429
  means stop hammering the server, not something is broken").
- All four behaviors (fires at the server-specified delay; gives up after 3; a non-429 error
  resets the counter; `stop()` clears a pending retry timer) are directly unit-tested with fake
  timers in `engine/sync-scheduler.test.ts`.

### 4.8 Reconnect / foreground / background triggers

- `scheduler-instance.ts`'s `initSyncListeners()` (registered once, globally, not per-store) wires
  two real listeners:
  - `NetInfo.addEventListener` — fires `scheduler.onNetworkRestored()` only on the **edge**
    (previously disconnected → now connected; `isInternetReachable !== false` treats
    null/undefined/true all as connected) (`scheduler-instance.ts:67-73`).
  - `AppState.addEventListener('change', ...)` — a transition **to** `'active'` from a
    non-active state triggers `onNetworkRestored()` (full push+pull cycle, same handler as
    reconnect); a transition **to** `'background'` triggers `onBackground()` (push-only flush)
    (`scheduler-instance.ts:75-82`).
- Both `onNetworkRestored()` and `onBackground()` route through `SyncScheduler.runExclusive()`'s
  reentrancy mutex — this specifically prevents a background event firing concurrently with an
  in-flight `runSyncCycle()`'s drain, which could otherwise let two concurrent drains both read
  the same `pending` rows before either marks them `inflight`, double-submitting the same
  mutation (`engine/sync-scheduler.ts:94-104`).
- Confirmed: `@react-native-community/netinfo` + React Native's built-in `AppState`, **not**
  `expo-network` — the earlier plan assumption was superseded (`scheduler-instance.ts:1-4`).

### 4.9 Store switching (multi-store device)

- `use-sync-store-binding.ts` subscribes to `useActiveStoreStore((s) => s.storeId)`. On every
  change: if the new `storeId` is falsy, `stopSync()`; otherwise `startSyncForStore(storeId)`. The
  effect's cleanup (`stopSync()`) fires **before** the next effect run whenever `storeId` changes
  again, so a store switch always stops the old scheduler (clearing its timers and resetting
  `useStoreOpenStatus`) before a brand-new `SyncScheduler` instance is constructed and bound to
  the new store (`use-sync-store-binding.ts`).
- `startSyncForStore()` is idempotent on a no-op re-entry with the same `storeId`
  (`current?.storeId === storeId` short-circuit) and, on `openStoreOnce()` failure, deliberately
  leaves `current` unset (`null`) so a later retry re-enters fully rather than short-circuiting
  (`scheduler-instance.ts:24-42`).
- No cursor/progress reset happens at the store-switch layer — `sync_cursor` and
  `sync_init_progress` rows are per-store, so switching back to a previously-opened store resumes
  from its own preserved cursor rather than re-running cold start.
- `(store)/_layout.tsx` redirects to `/(app)/store-picker` when `storeId` is null at all, and
  renders a `StoreOpenGate` instead of the real `<Stack>` until `useStoreOpenStatus` reports
  `ready` for the **current** `storeId` — both `setReady`/`setError` no-op if the store id they're
  called with doesn't match current state, specifically to prevent a stale async callback from a
  superseded switch overwriting the new store's status.

---

## 5. Business Rules (Invariants)

| ID (as used in code comments) | Rule | Enforced in |
|---|---|---|
| INV-9 | Cursor/watermark advances only in the same transaction as the rows it claims are durable. | `engine/apply-changes.ts`, `engine/cold-start.ts`, `repositories/sync-cursor.repository.ts:set()`, `repositories/sync-init-progress.repository.ts:savePage()` |
| INV-5 | Migrate-before-sync — DB migrations resolve before any cold start/pull/drain touches the schema. | `db/client.ts:runMigrations()`, `engine/sync-engine.ts:openStore()` |
| (unlabeled, "push-before-pull") | Every sync cycle drains the queue before pulling, to avoid clobbering/mis-conflicting not-yet-pushed edits. | `engine/sync-engine.ts:runSyncCycle()` |
| BR-SYNC-021 | Within one applied page, an entity's upserts land before that entity's deletes — and, per `apply-changes.ts`'s comment, this now holds **across** entities too (all upserts before any deletes), not just within one entity. | `engine/apply-changes.ts:44-46` |
| S-8 | Watermarks must be read via `microIso()` (µs precision); a plain `Date` round-trip can truncate to ms and collapse the keyset tiebreaker. | `apps/backend/src/sync/us-timestamp.ts`, `apps/mobile/src/core/sync/db/schema.ts:19-22` |
| S-5 | An RBAC-denied entity gets an empty page **without** advancing its watermark, so a later permission re-grant back-fills the gap instead of permanently skipping it. | `pull/changes.service.ts:77-90`, `pull/initial-sync.service.ts:111-113` |
| S-11 | Delta pull fair-share: `perEntityLimit = max(floor(DELTA_PAGE_SIZE / entityCount), PER_ENTITY_FLOOR)` = `max(floor(200/n), 20)`. | `pull/changes.service.ts:68-71` |
| S-31 | The cursor horizon (410 `SYNC_HORIZON_EXCEEDED`) is keyed only on cursor issue-time (`ia`), never a per-entity watermark — a low-churn entity can legitimately carry an ancient watermark. | `cursor/sync-cursor.service.ts:111-118` |
| S-3a / S-3b | Push mutations are topo-sorted by `parent_guuid` within a batch (parents before children regardless of client order); a rejected/conflicted/cached-rejected parent guuid cascades a terminal `PARENT_FAILED` rejection to its children in the same batch. | `push/delta.service.ts:166, 178-181, 246-249` |
| §10/§20 (unlabeled) | The idempotency row commits with the business write in the same transaction, or not at all. | `push/delta.service.ts:364-427` |
| §12 | Authorization for a mutation is checked both at current time and, within a grace window, at the mutation's original `client_modified_at` (skew-clamped) — see `checkGrace()`. | `push/delta.service.ts:290-322` |
| §20/F2 | `retry_later` is not cached and not a rollback — a sale queued during a lapsed-then-renewed subscription must not be silently lost. | `push/delta.service.ts:39-44, 327-360`; mobile `engine/reconcile-mutation-result.ts:9-19` |
| S-7 | Poison-mutation failure counts are written on the root connection after rollback, or a permanently-failing mutation would re-run its handler every sync cycle forever. | `repositories/sync-mutation-failure.repository.ts:6-11` |
| (tombstone atomicity, unlabeled) | A tombstone write requires the caller's transaction (no default) — writing it outside the delete's own tx risks either losing the tombstone on rollback or, worse, resurrecting the row on the next pull. | `repositories/tombstone.repository.ts:33-39` |
| (retention, unlabeled) | `TOMBSTONE_RETENTION_DAYS` (195) > `SYNC_HORIZON_DAYS` (180) so that no cursor still within the valid horizon can reference a tombstone that's already been purged. | `sync.constants.ts:14-23` |
| (unique constraint) | `products` has a partial unique index on `(storeFk, sku) WHERE sku IS NOT NULL AND deletedAt IS NULL` — backstops the app-level SKU-exists check against offline-sync races, scoped to live rows so a deleted product frees its SKU. | `db/schema.ts` (products table) |
| (composite PK, mobile) | `lookups` composite `(storeId, id)` PK prevents one store's sync from clobbering another store's local stamp on a shared global lookup row. | `db/migrations/0001_tidy_goliath.sql`, `repositories/lookup.repository.ts` |
| MAX_ATTEMPTS_BEFORE_DEAD = 7 (mobile) | A locally-recorded transient failure moves a queue row to `dead` after 7 attempts (via `recordTransientFailure`, distinct from the server's `POISON_MUTATION_MAX_FAILURES` = 7). | `repositories/mutation-queue.repository.ts:23` |

---

## 6. Business Logic (Per-Component)

### 6.1 `MasterDataSyncHandler` (backend, shared write primitive)

Used by all 6 concrete handlers (`lookup, product, product_case, customer, supplier,
paymentaccount`); explicitly **not** meant for transactional/event-sourced data (orders, stock,
shifts, cash) — "a concurrent sale is not a row_version conflict"
(`push/master-data.handler.ts:79-87`).

- **Create**: Zod-validate via `createSchema`, resolve FKs by guuid (scope `store` /
  `globalOrStore` / `global`; unresolved → `rejected VALIDATION_FAILED`), insert scoped to
  `ctx.storeId`; unique violations bubble to the pipeline's constraint mapper.
- **Update**: single atomic `UPDATE ... WHERE guuid=? AND storeFk=? AND alive AND
  rowVersion=expected`, setting `rowVersion = expected + 1` directly in the patch. Zero rows
  affected → distinguish NOT_FOUND (missing) vs NOT_FOUND (soft-deleted) vs `conflict` (version
  mismatch, live row and diff message returned).
- **Delete**: same WHERE-scoped soft-delete update, tombstone written in the same tx. Zero rows:
  if the row doesn't exist at all → `rejected NOT_FOUND`; if already deleted → idempotent
  `applied` no-op that **still rewrites the tombstone** (so a late-polling device doesn't miss the
  delete).
- **`guardRow()`**: pre-update/delete business-rule veto, e.g. `lookup`'s
  `isSystem === true → rejected LOOKUP_VALUE_PROTECTED`.
- **Store scoping**: enforced once, centrally, via `storeFkColumn` in the shared WHERE clauses —
  not repeated per handler.

Per-handler specifics (all from `push/handlers/*.ts`):

| Handler | entityType | permissionEntity | FK resolvers | Delete mode | Notes |
|---|---|---|---|---|---|
| `CustomerMutationHandler` | `customer` | `Customer` | `customer_type_lookup_guuid → lookup` (globalOrStore) | `deletedAt` | credit_limit via `money` helper |
| `LookupMutationHandler` | `lookup` | `Lookup` | none | `isActive` (not timestamp) | `code`/lookup type immutable after create; global rows (`storeFk` null) unreachable via store-scoped WHERE → `NOT_FOUND`; `guardRow` blocks edits to `isSystem` rows |
| `PaymentAccountMutationHandler` | `paymentaccount` | `Payment` | `payment_method_guuid → paymentMethods` (store) | `deletedAt` | `details` is a JSON record |
| `ProductMutationHandler` | `product` | `Product` | `unit_guuid→units`, `taxrate_guuid→taxRates` (store), `category_lookup_guuid→lookup` (globalOrStore) | `deletedAt` | `selling_price` required on create |
| `ProductCaseMutationHandler` | `product_case` | `Product` (shared with product) | `product_guuid → products` (store) | `deletedAt` | `quantity` via custom Zod schema (up to 3dp) |
| `SupplierMutationHandler` | `supplier` | `Supplier` | none | `deletedAt` | no FK resolvers |

All handlers stamp `createdBy`/`updatedBy` = `ctx.userId` conditional on `action`.

### 6.2 `SyncDeltaService.processOne()` preflight chain (exact order)

1. **Idempotency check** — `find(mutationId, userId)`; if a **live** row exists (TTL: 5 min for
   `conflict`, 45 days for `applied`/`rejected`), return the cached result as `status:
   'duplicate'` (sanitizing `server_row` out of cached conflicts); if stale, `remove()` it first.
2. **Payload size cap** — `> MAX_MUTATION_PAYLOAD_BYTES` (64 KB) → terminal reject
   `MUTATION_PAYLOAD_TOO_LARGE`.
3. **Poison cap** — failure count `>= POISON_MUTATION_MAX_FAILURES` (7) → terminal reject
   `SERVER_ERROR`.
4. **Parent cascade** — `parent_guuid` in this batch's `failedGuuids` → terminal reject
   `PARENT_FAILED`.
5. **Skew clamp** — `effectiveAsOf = client_modified_at if valid and < now, else now`.
6. **Handler dispatch** — unknown `entity_type` → terminal reject `UNKNOWN_MUTATION`.
7. **Row-version-required** — `action === 'update' && expected_row_version == null` → terminal
   reject `SYNC_MISSING_ROW_VERSION`.
8. **Authorization + grace window** — `checkGrace()`: reject if `clientAt` is too far in the
   future (`> now + FUTURE_SKEW_TOLERANCE_MS` = 5 min) even inside grace; reject if `clientAt <
   sessionCreatedAt`; else check authorization as of `max(effectiveAsOf, now -
   REVOCATION_GRACE_WINDOW_MS)` (30 min grace).
9. **Subscription gate** — `checkSubscription()`: no subscription / `paused` /
   `reconciliationStatus === 'pending'` (unless already past its effective date) →
   **uncached** `retry_later`; `accessValidUntil` passed both at now AND at `effectiveAsOf` →
   **cached** terminal `SUBSCRIPTION_LAPSED_AT_WRITE` rejection.
10. **Execute** — per-mutation transaction (§6.3).

### 6.3 Per-mutation transaction (`SyncDeltaService.execute()`)

A savepoint-style nested transaction (`tx.transaction(inner => handler.apply(...))`) wraps just
the handler call, inside the outer per-batch-call transaction. A constraint violation (guuid
replay, SKU race) rolls back only the handler's savepoint; the outer transaction — which then
writes the idempotency claim — stays healthy. `RaceLostSignal` (idempotency insert lost a
concurrent race) triggers `pollRaceWinner()`: polls every `IDEMPOTENCY_RACE_POLL_INTERVAL_MS`
(200 ms) up to `IDEMPOTENCY_RACE_POLL_TIMEOUT_MS` (3000 ms); on exhaustion the whole
`/sync/delta` call aborts with `ServiceUnavailableError` and the client retries the batch.
Postgres `23505` (unique violation) maps to `rejected DUPLICATE_ENTRY`; `23503` (FK violation)
maps to `rejected FOREIGN_KEY_VIOLATION` (`push/delta.service.ts:588-606`). An unmapped handler
crash bumps the poison counter outside the rolled-back tx and returns an **uncached** rejected
`SERVER_ERROR` below the poison threshold (so retries can still succeed), or a **cached** one at
the threshold.

### 6.4 Mobile mutation-queue state machine

```
pending --[takeDrainable + markInflight]--> inflight
inflight --[commit-applied / commit-duplicate]--> applied        (terminal)
inflight --[mark-conflict]--> conflict                            (terminal until resolved)
inflight --[rollback]--> rejected                                 (terminal)
inflight --[keep-queued / retry_later]--> pending                  (loops back, not dead-lettered)
conflict --[takeServerVersion]--> (row removed from queue)
conflict --[resubmitMine]--> (row removed; a NEW pending row enqueued with a new mutationId)
pending --[recordTransientFailure, attempts >= 7]--> dead          (client-local dead-letter path; distinct trigger from the reconcile pipeline above)
```
(`repositories/mutation-queue.repository.ts`, `engine/drain-queue.ts`,
`engine/reconcile-mutation-result.ts`, `mutations/resolve-conflict.ts`)

---

## 7. API Contract

All 5 endpoints are mounted under `@Controller('stores/:storeId/sync')` — i.e. the actual base
path is `stores/:storeId/sync/...`, not a bare `/sync/...` prefix
(`apps/backend/src/sync/sync.controller.ts:57`). Guards on the whole controller: `MobileJwtGuard,
TenantGuard, PermissionsGuard, SubscriptionStatusGuard`, plus `@StoreContext('param.storeId')` and
`@SkipTransform()` (raw response body, no `{success,data}` envelope). No blanket
`@RequirePermissions` — per-entity `view` checks happen inside `SyncFilterRegistry`/handlers so a
single permission wouldn't lock out partial-access staff roles.

| Method & Path | Query / Body | Response | Notes |
|---|---|---|---|
| `GET stores/:storeId/sync/initial` | `entity_type?, cursor?, reset? ('true'\|'false'), supported_entity_types? (csv), sync_cursor?` | `InitialResult` | Cold-start dump, one entity type per call, resumable. |
| `GET stores/:storeId/sync/changes` | `cursor (required), supported_entity_types? (csv)` | `ChangesResult` | Delta pull — upserts + tombstones since cursor. |
| `POST stores/:storeId/sync/delta` | body: `{ sync_cursor?, permissions_version?, supported_entity_types?, mutations: SyncMutationInput[] }` (`SyncDeltaSchema`) | `SyncDeltaResult` | Always HTTP 200 (`@HttpCode(200)`) — outcomes are per-mutation. `@AllowExpiredSubscription()` overrides the hard write-block so offline sales stamped before lapse still apply. |
| `GET stores/:storeId/sync/conflicts` | `status? ('open'\|'resolved'\|'discarded'), conflict_type? ('MASTER_DATA'\|'VALIDATION'\|'BUSINESS_RULE')` | `ConflictListResponse` | |
| `PATCH stores/:storeId/sync/conflicts/:mutationId` | body: `{ status: 'resolved'\|'discarded', note?: string (max 500) }` (`ConflictResolveSchema`) | `ConflictResponse` | `@AllowExpiredSubscription()`; bookkeeping only — "the client rebases and resubmits under the new row_version." |

Additionally, outside the `stores/:storeId/sync` prefix:

| Method & Path | Auth | Response | Notes |
|---|---|---|---|
| `GET time` | `@Public()` (unauthenticated), `@SkipTransform()` | `{ server_time: string (ISO), epoch_ms: number }` | Bootstrap escape hatch — a clock-fast device must learn its offset before it can authenticate, since `MobileJwtGuard`'s replay protection rejects requests whose `X-Timestamp` drifts more than ±30s. |

### Request/response field detail

`MutationSchema` (`dto/sync-delta.schema.ts`): `mutation_id` (ULID regex), `entity_type`
(1-40 chars), `action` (`create|update|delete`), `payload` (free-form record), `expected_row_version`
(positive int, optional at schema level but enforced for `update` in preflight step 7),
`client_modified_at` (ISO datetime with offset, optional), `parent_guuid` (uuid, optional).
`SyncDeltaSchema.mutations` capped at `MAX_MUTATIONS_PER_BATCH` = 100.

`ConflictResponse` DTO field mapping (`mappers/response/conflict.response-mapper.ts`) is a
straight camelCase→snake_case rename plus `Date → toISOString()` for `created_at`/`resolved_at`.

**Idempotency guarantee**: keyed on `(mutation_id, user_fk)`. A live cached result (TTL depends on
outcome type — 5 min for conflict, 45 days for applied/rejected) short-circuits re-execution and
returns `status: 'duplicate'` with the original cached payload
(`repositories/sync-idempotency.repository.ts`). This guarantees a client retry of an already-
applied batch never double-executes the business write.

**Error shapes**: sync-specific error codes seen across the pipeline include
`INVALID_CURSOR` (400), `SYNC_HORIZON_EXCEEDED` (410, `GoneError`), `VALIDATION_FAILED`,
`UNKNOWN_MUTATION`, `SYNC_MISSING_ROW_VERSION`, `NOT_FOUND`, `DUPLICATE_ENTRY`,
`FOREIGN_KEY_VIOLATION`, `MUTATION_PAYLOAD_TOO_LARGE`, `PARENT_FAILED`, `SERVER_ERROR`,
`LOOKUP_VALUE_PROTECTED`, `SUBSCRIPTION_NOT_FOUND`/`SUBSCRIPTION_SUSPENDED`/
`SUBSCRIPTION_RECONCILIATION_REQUIRED` (all `retry_later`), `SUBSCRIPTION_LAPSED_AT_WRITE`
(terminal), `SYNC_CONFLICT_NOT_FOUND` (404, on `PATCH .../conflicts/:mutationId` for an unknown
mutation id).

---

## 8. Mobile Implementation Details

### 8.1 DI seams for testability

- **`ApplierLookup`** (`engine/apply-changes.ts:11-18`) — minimal `{ get(entityType),
  entityTypes() }` interface so tests can inject a fake registry without mocking the real
  `appliersRegistry` singleton.
- **`SyncEngineLike`** (`engine/sync-scheduler.ts:26-30`) — `{ openStore(), runSyncCycle(),
  runPush() }`; notably **excludes** `runPull()` (the concrete `SyncEngine` has 4 public methods,
  the scheduler only needs 3). Lets tests inject a fake engine whose `runSyncCycle` rejects with
  `RateLimitedError` without touching the real DB.
- `SyncScheduler`'s constructor lazily `require()`s the concrete `SyncEngine` only if none is
  injected — this keeps importing `sync-scheduler.ts` in tests from transitively pulling in
  `db/client.ts` → `expo-sqlite` (an ESM-only native module Jest can't parse)
  (`engine/sync-scheduler.ts`, top-of-file comment).

### 8.2 `SyncDb` cross-driver abstraction

`SyncDb = BaseSQLiteDatabase<'sync', unknown, SyncSchema>` (`db/types.ts`) — both `expo-sqlite`
and `better-sqlite3` are synchronous-result-kind (`'sync'`) drivers under Drizzle's typing, so
both concrete driver types structurally satisfy this widened type, forcing an `as unknown as
SyncDb` cast at the boundary in both `client.ts` and `create-test-db.ts`. Repository/engine code
is written entirely against `SyncDb` and never imports either concrete driver, so the exact same
logic runs against a real on-device DB and a real in-memory DB in Jest — no mocking of the SQL
layer anywhere in this module's test suite.

`getSyncDb()` returns the widened `SyncDb` (what every repository/engine function takes).
`getSyncDbForQueries()` returns the **concrete** `ExpoSQLiteDatabase<SyncSchema>` type instead,
because `useLiveQuery` (from `drizzle-orm/expo-sqlite/query`) requires the exact concrete type —
this is a read-only call site; writes still go through the repositories (`db/client.ts:20-28`).

### 8.3 Jest project split

`apps/mobile/jest.config.js` defines two projects:
- **`sync-engine`** — `testEnvironment: 'node'`, `testMatch` covering
  `src/core/sync/**/*.test.ts` **and** `src/features/sync/utils/**/*.test.ts`. Pure logic + real
  SQLite (via `createTestDb()`), zero React Native imports — jest-expo's setup would crash
  outright outside a real RN runtime and isn't needed here. Uses `babel-jest` +
  `babel-preset-expo` with a `transformIgnorePatterns` override for `expo/virtual/env.js`.
- **`app`** — `preset: 'jest-expo'`, matches all other `src/**/*.test.ts?(x)`, explicitly
  `testPathIgnorePatterns` excluding `core/sync/` and `features/sync/utils/` so the two projects'
  test sets are mutually exclusive.

`features/sync/utils/format-sync-row.test.ts` runs under `sync-engine` despite living outside
`core/sync/` — it's organized by feature folder but deliberately extracted to stay RN-free/pure,
so it's carved into the Node project by its own explicit `testMatch` glob entry.

### 8.4 Root-level wiring

`apps/mobile/src/app/_layout.tsx`'s `RootNavigator` calls `initSyncListeners()` and
`useSyncStoreBinding()` unconditionally at the top of its render body — above every
auth-readiness/bootstrap check. The actual gating to "does this device have an authenticated user
with an active store" happens **inside** those two calls (a no-op `storeId` short-circuits
`use-sync-store-binding.ts`'s effect; `initSyncListeners()`'s listeners read the live `current`
module variable at fire time, which is `null` until a store is opened).

---

## 9. Sync & Offline Mechanics

### 9.1 `withTransaction()` — manual transaction control + cross-call-site mutex

`apps/mobile/src/core/sync/db/transaction.ts` deliberately does **not** use Drizzle's
`db.transaction()`. Both SQLite drivers used here (`better-sqlite3` in tests, `expo-sqlite` on
device — both `BaseSQLiteDatabase<'sync', ...>`) reject a transaction callback that returns a
Promise **at runtime**: `better-sqlite3`'s native wrapper throws `TypeError('Transaction function
cannot return a promise')` the instant the callback resolves to a thenable, even though
`db.transaction(async (tx) => ...)` typechecks cleanly (a known TS gotcha around
void-returning-callback inference). Every repository in this module is async by design (so a
future async-kind driver needs no rewrite), so the module sequences raw SQL itself:

```ts
let tail: Promise<void> = Promise.resolve();

export function withTransaction<T>(db: SyncDb, fn: (tx: SyncDb) => Promise<T>): Promise<T> {
  const result = tail.then(() => runTransaction(db, fn));
  tail = result.then(() => undefined, () => undefined);
  return result;
}

async function runTransaction<T>(db: SyncDb, fn: (tx: SyncDb) => Promise<T>): Promise<T> {
  await db.run(sql`BEGIN`);
  try {
    const result = await fn(db);
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch {
      // Best-effort — if ROLLBACK itself fails, the connection is already
      // broken; surface the ORIGINAL error, not this secondary one.
    }
    throw err;
  }
}
```

Both drivers are single-connection/single-writer, but only correctly so if this module itself
never lets two `BEGIN`/`COMMIT` pairs interleave. Since `fn` is async and typically awaits I/O
(network for push, other DB calls), it yields the event loop — a second, unrelated
`withTransaction` call (e.g. a background push overlapping a foreground pull) could otherwise
start its own `BEGIN` before the first `COMMIT`s. The module-level `tail` variable is a
promise-chain queue: every call chains its actual work onto whatever `tail` currently is, then
immediately reassigns `tail` to a **settled-either-way** derivative of its own result (so one
transaction's failure can never wedge later callers), while still returning the real
(possibly-rejecting) result to its own caller. Because JS runs the `.then()` call and the `tail`
reassignment synchronously before any `await` yields control, calls issued on the same tick are
strictly ordered by call order.

This is directly tested in `db/transaction.test.ts` against the exact real-world scenario a
UI-triggered `enqueueCreateProduct()` write racing a scheduler-triggered `drainQueueFully`/
`pullDeltaToCompletion` on the same single connection — the test file's header comment states
that reverting to a bare (unqueued) `BEGIN`/`COMMIT`/`ROLLBACK` was verified to reproduce a real
`SqliteError: cannot start a transaction within a transaction` against this test. Two tests:
one proves neither call's body interleaves with the other's (strict start→end, start→end
ordering, never `start,start,end,end`); the other proves two racing writers to different stores
both land correctly with no lost/cross-contaminated rows.

### 9.2 Migrations

- `db/migrations/0000_noisy_guardian.sql` creates all 11 original tables.
- `db/migrations/0001_tidy_goliath.sql` rebuilds `lookups` via SQLite's standard "new
  table + copy + drop + rename" pattern (SQLite can't `ALTER ... ADD PRIMARY KEY`) to add the
  composite `(store_id, id)` PK and make `store_id NOT NULL`.
- `migrations-data.ts` is auto-generated by `scripts/generate-mobile-migrations.mjs` (per its own
  header comment: "do not hand-edit; regenerate via `pnpm db:generate`") — it inlines the raw SQL
  text and journal as JS string literals so Metro doesn't need filesystem access at runtime.
  `client.ts` imports from **this** file, not from `migrations.js`.
- `migrations.js` is Drizzle's own default-generated migrator shape (imports `.sql` files
  directly via Metro's SQL-as-string transform) — present per Drizzle's own Expo docs, but
  superseded in practice by the project's custom `migrations-data.ts` generator.
- `db/__testing__/create-test-db.ts` runs the **same** migration SQL directly off disk (Node has
  filesystem access) against an in-memory `better-sqlite3` DB — so tests exercise real migration
  SQL, not a hand-maintained parallel schema.
- `runMigrations()` (`db/client.ts`) is idempotent (Drizzle's migrator tracks applied migrations
  internally) and is called on every `SyncEngine.openStore()`, not just app boot — "opening a
  store is correct regardless of what else has or hasn't run yet at launch."

### 9.3 ULID generation fix

`mutations/ulid.ts` wraps `ulid`'s `factory()` with a custom PRNG backed by
`expo-crypto.getRandomValues`. The stock `ulid` package auto-detects `window.crypto` (absent in
RN) and falls back to `require('crypto')`, expecting Node's `crypto.randomBytes` — Metro resolves
that to something without `randomBytes`, crashing with `"nodeCrypto.randomBytes is not a
function"`. The fix mirrors `ulid`'s own browser-crypto branch but skips the broken
auto-detection path entirely.

### 9.4 Rate-limit constants (exact values)

`DEFAULT_RETRY_AFTER_MS = 30_000` (`transport/rate-limit-error.ts`);
`MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 3`, `MAX_RATE_LIMIT_RETRY_DELAY_MS = 2 * 60_000`
(`engine/sync-scheduler.ts`).

---

## 10. Seed & Reference Data

`lookup`/`lookupType` (backend) and `lookups` (mobile) hold reference/master data (e.g. business
categories) that can be **global** (`storeFk IS NULL`, server) or store-custom. No dedicated seed
script or fixture file was found within the file set read for this document — `country` and
`currency` (`apps/backend/src/db/schema.ts:717-735`) are separate, non-store-scoped, non-synced
reference tables with no `syncColumns()`, and are out of scope for this module (they aren't in
`SYNC_ENTITY_TYPES` and have no filter/handler registered). **Not found** — no seed/migration file
populating default `lookupType`/global `lookup` rows was located in the files read for this
document; if one exists it is outside `apps/backend/src/sync/` and `apps/backend/src/db/schema.ts`
and was not searched for further.

---

## 11. Dependencies & Coupling

### 11.1 Entity-type coverage matrix — the mobile/backend gap

| entityType | Backend pull filter (`sync-filter.registry.ts`) | Backend push handler (`sync.module.ts`) | Mobile applier (`appliers.registry.ts`) |
|---|---|---|---|
| `store` | yes (dependencyOrder 0) | no (pull-only) | yes |
| `unit` | yes (2) | no (pull-only) | yes |
| `store_device_access` | yes (2) | no | **no** |
| `location` | yes (3) | no (pull-only, "no mutation handler yet") | **no** |
| `lookup` | yes (5) | yes | yes |
| `payment_method` | yes (5) | no (pull-only) | yes |
| `taxrate` | yes (6) | no (pull-only) | yes |
| `staff` | yes (8, custom `StaffSyncFilter`) | no | **no** |
| `product` | yes (10) | yes | yes |
| `product_case` | yes (10) | yes | yes |
| `paymentaccount` | yes (15) | yes | **no** |
| `customer` | yes (20) | yes | yes |
| `supplier` | yes (21) | yes | **no** |

Mobile sends `appliersRegistry.entityTypes()` (its 8-type list) as `supported_entity_types` on
every pull, and `SyncFilterRegistry.supported()` intersects the server's 13 against exactly what
the client declares (`registry/sync-filter.registry.ts:422-436`) — so today this mobile build
never receives `store_device_access`, `location`, `staff`, `paymentaccount`, or `supplier` rows at
all, regardless of what the backend is capable of syncing. Adding a new entity to mobile is,
per the registry's own doc comment, "registration here + a repository, never a change to the
pull/push pipeline" (`appliers.registry.ts:21-23`) — the same "registration, not surgery" framing
used on the backend side for future handlers.

### 11.2 Cross-module coupling

- Mobile's `use-sync-store-binding.ts` depends on `apps/mobile/src/store/activeStore.ts`
  (`useActiveStoreStore`, aliased `@store`) as the single source of truth for "which store is
  currently open." `(store)/_layout.tsx` reads the same `storeId` selector for its redirect/gate
  logic, and `store-open-status.ts`'s Zustand store is keyed by the same id — three independent
  consumers of one id, no shared subscription beyond Zustand's own mechanism.
- `apps/backend/src/sync/sync.module.ts` exports only `TombstoneRepository` for use by other
  backend modules; `SyncFilterRegistry`/`MutationHandlerRegistry` registration is fully closed —
  a repo-wide grep found zero other backend modules referencing `SyncFilterRegistry`,
  `SyncEntityFilter`, `GenericSyncFilter`, `MutationHandlerRegistry`, or `SyncMutationHandler`.
- Mobile's `transport/sync-transport.ts` deliberately bypasses the app's normal TanStack
  Query/`api-manager` convention (`APIData`/`queryOptions`) because it's driven by
  `SyncScheduler` on a timer/event, not component render — there is no query cache to key
  against.
- `GET /time` exists specifically because `MobileJwtGuard`'s request-replay protection rejects
  any request whose `X-Timestamp` drifts more than ±30s — a clock-skewed device must call this
  unauthenticated endpoint before it can successfully authenticate at all.

### 11.3 Menu / navigation coupling

`ITEM_ROUTES['sync-issues'] = '/(store)/sync-issues'` (`menu-utils.ts`) is the only link between
the "More" menu and this module; the menu entry itself carries no permission gating (this app has
no per-item permission matrix yet, per `menu-config.ts`'s file-level comment) — every user who can
reach the "More" menu can reach `ConflictsScreen`, subject only to the `(store)/_layout.tsx` store-
open gate.

---

## 12. Open Questions / Not Found

- **`ConflictsScreen.tsx` never calls the backend conflicts endpoints.** Mobile's
  `transport/sync-transport.ts` implements `listConflicts()`/`resolveConflict()` against
  `GET/PATCH stores/:storeId/sync/conflicts...`, but the screen resolves conflicts purely by
  reading/writing the local `mutation_queue` table (`takeServerVersion`/`resubmitMine`). It is
  not clear from the code whether the backend conflicts endpoints are dead code on the mobile
  side, reserved for a future admin/web surface, or meant to be wired up later — **not found**:
  no call site for `listConflicts`/`resolveConflict` exists anywhere in the files read for this
  document.
- **`failedApplies` (mobile pull-side DLQ) has no clear/delete/retry method.** `failed-
  applies.repository.ts` only exposes `record()` and `listByStore()` — there is no way, in code,
  to remove a row once the underlying missing dependency (e.g. a not-yet-synced FK) resolves
  itself. Whether the row is expected to age out naturally on a future re-apply, or is a true
  permanent stain until manual DB intervention, is **not found**.
- **`mutationQueueRepository.recordTransientFailure()` (client-local dead-letter, 7-attempt cap)
  has no confirmed call site within `engine/drain-queue.ts`.** The reconciliation pipeline
  documented in §4.5/§6.4 handles `applied/duplicate/conflict/rejected/retry_later` but never
  observably calls `recordTransientFailure()` for, e.g., a network-level failure of the
  `pushDelta()` HTTP call itself (as opposed to a per-mutation server response). Whether that
  path is invoked elsewhere (not in the file list provided for this task) or is currently dead
  code is **not found** — flagged rather than guessed.
- **`SyncEngine.runPull()`** exists as a public method but has no confirmed caller within
  `sync-scheduler.ts` (which only calls `openStore`/`runSyncCycle`/`runPush` via
  `SyncEngineLike`). Likely reserved for a manual/future "pull only" trigger — **not found**
  confirmed usage.
- **Seed/fixture data for `lookupType`/global `lookup` rows** — no seed script was located within
  the files read for this task (see §10). If one exists, it lives outside
  `apps/backend/src/sync/` and `apps/backend/src/db/schema.ts` and was not searched for.
- **Auth/header construction in `transport/sync-transport.ts`** — the file relies on `API` from
  `@ayphen/api-manager` for auth headers/base URL; that module's internals were out of scope for
  this task and were not read, so the exact header/interceptor mechanism is **not found** here
  (noted as "presumably global interceptors" in the research, not confirmed).
- Backend's `entityType` list (`SYNC_ENTITY_TYPES`, 13 entries) and the live
  `SyncFilterRegistry` registration (also 13, matching) agree in count, but their groupings by
  `dependencyOrder` include ties (`unit`/`store_device_access` both order 2; `lookup`/
  `payment_method` both 5; `product`/`product_case` both 10) — registration order within a tie is
  preserved only because `Array.sort` is stable in V8; this is implicit engine behavior, not an
  explicit contract, and is noted here rather than asserted as guaranteed indefinitely.