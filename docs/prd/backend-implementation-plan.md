# Backend Implementation Plan — Ayphen Retail (Mobile v2 + Hybrid Subscription + Offline POS)

> **Audience:** backend engineers. **Source:** reconciled from the mobile-architecture series
> ([MOBILE_POST_LOGIN_AND_FRESHNESS.md](./MOBILE_POST_LOGIN_AND_FRESHNESS.md)),
> [device-management.md](./device-management.md), [subscription.md](./subscription.md) — and a
> code audit of `apps/api/src` on branch `saran-dev`. Every "current state" line is cited.
> **Status legend:** ✅ already built · 🔧 modify existing · 🆕 new file/table/endpoint · ⚠️ gotcha.
>
> **Golden rule:** additive-first. Add new column/field/endpoint/header, keep the old one, gate by
> app-version, remove deprecated only after client adoption. Feature-flag each workstream in
> `system_config`.

---

## 0. Audit summary — what already exists vs. what's missing

| Area | Already built (✅) | Missing (🆕/🔧) |
|---|---|---|
| Subscription | per-store `store_subscription` + **`subscription_version` col** (`store-subscription.ts:67`); bump at every transition; `plan_feature` junction; `checkAccess()` 60s cache; 3 crons (trial-expiry, reconciliation, abandoned-checkout); webhook activation; `GET /stores/:id/subscription` + `/sv` (`billing.controller.ts:58,78`) | **`user_subscription`** (account plan); **`max_stores`**; **`access_valid_until`**; account-level grace/expiry; cancel/reactivate/update-payment endpoints; account-scoped `/me/subscription` |
| Bootstrap | `has_pending_invitations` (`bootstrap.service.ts:350,456`); active-store cascade `lastOpened ?? pinned ?? stores[0]` (`:369-381`); signs **only active** store logo (`:408-424`); no hours/sync_config/app_config in bootstrap | full `active_store {id,guuid}` object (returns guuid only `:459`); locked-store-aware resolution; ETag already in controller (`me.controller.ts:45`) |
| Freshness | `permissionsVersion` + `snapshot-refresh.interceptor` pushes `X-Permission-Snapshot` when pv stale; per-store `/sv` | **`x-permission-version`/`x-subscription-version` headers** (constants absent in `http-headers.ts`); `GET /me/snapshot`; account-level `/me/subscription`+`/me/sv`; stop inlining snapshot |
| Refresh response | `store_access_changed = result.storeAccessChanged` (real signal, `mapper:82`) | **`force_bootstrap` hard-coded `false`** (`mapper:79`) — wire or delete |
| POS writes | mutation handlers for product/customer/supplier/paymentaccount/lookup only | **🔴 order/order_item/shift_session/payment/cash_drawer/stock_* handlers** — no `modules/order` exists at all |
| Sync entitlement | point-in-time **RBAC** grace at write (`sync-delta.service.ts:475-541`) | **subscription** point-in-time (`SUBSCRIPTION_LAPSED_AT_WRITE`); `SubscriptionService` not injected into `SyncDeltaService` |
| Rate limit | `/sync/initial` exempt, changes 60/min, delta 20/min; per-(user,store) key intended | **`/sync/pull` dead path-match**; `storeId` falls back to `'unknown'` (`sync-rate-limit.guard.ts:97`) → collapses to per-user bucket |
| Store lifecycle | archive (`store.service.ts:645`); `max_devices` gate precedent (`store-device-access.service.ts:49-88`) | **`store.locked` column**; lock/unlock ops; account-expiry flip job; `max_users` gate; `max_stores` gate at create + ownership-transfer |
| Shift | `shift_session` schema with one-open-per-register partial index (`shift-session.ts:89`); `SHIFT_NOT_OPEN` code defined (`error-codes.ts:202`) | **never thrown**; `order.shiftSessionFk` nullable (`order.ts:27`); no shift_session REST/sync |

---

## WORKSTREAM 0 — Prerequisite bug fixes (no flag; ship first)

### 0.1 🔧 Sync rate limiter — dead path + storeId fallback
**Files:** `modules/sync/guards/sync-rate-limit.guard.ts`, `modules/sync/controllers/sync.controller.ts`.
**Current:** `/sync/pull`/`/sync/push` referenced in docblock (`:21-28`) but real routes are
`initial|changes|delta`. `storeId` read as `request.params?.storeId ?? 'unknown'` (`:96-97`); when
guard runs before param binding it degrades the Redis key (`:177`
`sync_rate_limit:${userId}:${storeId}:${endpoint}`) to a per-user-global bucket.
**Do:**
1. Read `storeId` reliably — from `request.context?.storeId` (set by `TenantGuard`) or a path regex
   `/stores/([^/]+)/sync/`, never `'unknown'`. Assert non-`unknown` or fail-closed-to-per-user only
   as a logged fallback.
2. Path matcher (`:106-122`): keep the real `initial(exempt) / changes(60) / delta(20)` branches;
   delete `/sync/pull`/`/sync/push` references; **add a `/sync/manifest` branch** (WS-5) at the same
   quota tier as `changes`.
3. The separate per-user mutation cap `sync_mutations:${userId}` (`sync.controller.ts:282-303`,
   100/5min) — consider keying per-`(user,store)` too.
**Test:** two stores sync concurrently → independent budgets; cold start (21 entities) → no 429.

### 0.2 🔧 `force_bootstrap` hard-coded false
**File:** `auth/mobile/mappers/mobile-auth.mapper.ts:79` (`toRefreshResponse`).
**Current:** `force_bootstrap: false` static; `store_access_changed: result.storeAccessChanged`
already a real signal (`:82`); snapshot fully inlined (`:72-74`).
**Do:** either (a) compute `force_bootstrap` from a real trigger (schema_version bump / recovery
flag on `AuthTokenResult`), or (b) **delete the field** from `refresh-response.dto.ts:3-19` and the
mapper (cleanest — the inline snapshot + `store_access_changed` cover the real cases). Recommend (b).

### 0.3 🔧 Active-store resolution — return full object + locked-aware + picker semantics
**File:** `modules/me/services/bootstrap.service.ts:369-381` (`findInSnapshot` + cascade),
return `:459` (guuid only).
**Current:** cascade already does `lastOpenedStoreFk ?? pinnedStoreFk ?? stores[0]` — **good**, but
returns only `active_store_id` (guuid). No locked-store distinction.
**Do:**
1. Return a full **`active_store: { id, guuid } | null`** (subscription.md / mobile §3c). Keep
   `active_store_id` for old clients (additive).
2. Make `findInSnapshot` **revoked-aware**: a `last_opened` that's no longer in `snapshot.stores[]`
   → fall through; a **locked** store (WS-3) stays selectable (return it, client opens read-only).
3. The picker decision (no pointer & >1 store) is **client-side** — server may keep `stores[0]` for
   scoping; just don't auto-persist it as `last_opened`.
**Note:** ⚠️ slot-claim side-effect (`:386-405`) auto-persists `lastOpenedStoreFk` on GET bootstrap —
keep, but don't let it persist an arbitrary `stores[0]`.

---

## WORKSTREAM A — 🔴 POS mutation handlers (highest priority; unblocks offline checkout)

**Why #1:** only product/customer/supplier/paymentaccount/lookup have handlers
(`*.module.ts onModuleInit → mutationHandlers.register`). **No `modules/order`/`modules/shift`
exists.** Pushing a sale via `/sync/delta` → `rejected: UNKNOWN_MUTATION`
(`sync-delta.service.ts:419-427`). Until this ships, the offline POS cannot push anything.

### A.1 🆕 New modules + handlers
Create `modules/order`, `modules/shift` (sessions), and extend stock/payment write paths. For each
write entity register `(entity_type, action)` handlers in the module's `onModuleInit` via
`MutationHandlerRegistry.register()` (`mutation-handler-registry.service.ts:25`). Entities:

| entity_type | actions | notes |
|---|---|---|
| `order` | create, (update for void/refund?) | open-shift check (A.3); links `order_item` via `parentGuuid` |
| `order_item` | create | child of order; cascade-fails if parent fails (`sync-delta.service.ts:256-269`) |
| `order_payment` | create | tender lines |
| `shift_session` | create (open), update (close) | enforces one-open-per-register (`shift-session.ts:89`) |
| `cash_drawer_entry` | create | cash movements |
| `cash_denomination_count` | create | |
| `stock_take`/`stock_take_line` | create/update | |
| `stock_adjustment`/`stock_adjustment_line` | create | |
| `stock_event` | create | |

### A.2 Handler pattern (copy `modules/customer/sync/customer-create.handler.ts`)
- `@Injectable() implements MutationHandler`; `readonly entityType='order'`, `readonly action='create' as const`.
- `apply(ctx)` (`MutationHandlerContext`, `handlers/mutation-handler.types.ts:16-44`): use **`ctx.tx`**;
  `filterPayloadToMutableFields(ctx.payload, MUTABLE_ORDER_FIELDS)`; validate; `guuid = p.guuid ?? uuidv7()`;
  dup-guuid check `repo.findByGuuid(ctx.storeId, guuid, ctx.tx)`; insert; return
  `{kind:'applied', entityId, entityGuuid, rowVersion, data: mapper.toSyncShape(row)}`.
- **Stamp times from `ctx.clientModifiedAt`** (`:43`), not `new Date()`.
- Update handlers require `ctx.expectedRowVersion`; version-gated update → `{kind:'conflict', serverRow, message}`.
- Each module registers handlers in `onModuleInit`.

### A.3 🔧 Open-shift enforcement (resolve dead `SHIFT_NOT_OPEN`)
**Current:** `SHIFT_NOT_OPEN` defined (`error-codes.ts:202,1016`) but **never thrown**;
`order.shiftSessionFk` nullable (`order.ts:27`).
**Do (inside the `order.create` handler `apply`, within `ctx.tx`):** query
`shift_session WHERE store_fk=ctx.storeId AND status='open' AND deleted_at IS NULL`; none →
`{kind:'rejected', code: ErrorCode.SHIFT_NOT_OPEN, message}`; else set
`order.shiftSessionFk = openSession.id`. Make `order.shiftSessionFk` `NOT NULL` for sale orders
(migration; keep nullable for non-sale order types if any). This is **domain logic in the handler**,
not in `sync-delta` preflight (engine doesn't know what an order is).

### A.4 🆕 `SUBSCRIPTION_LAPSED_AT_WRITE` — offline-expiry entitlement (device §30 Half B)
**Model:** mirror the existing **point-in-time RBAC grace** `wasAuthorizedAtQueueTime`
(`sync-delta.service.ts:475-541`).
**Do:**
1. Add `ErrorCode.SUBSCRIPTION_LAPSED_AT_WRITE = 'subscription_lapsed_at_write'` to
   `common/constants/error-codes.ts` (~`:243` const block + metadata map, httpStatus 422, domain `subscription`).
2. Inject `SubscriptionService` into `SyncDeltaService` (constructor `:202-212`); resolve the store's
   `access_valid_until` **once per batch** in `submit()` (alongside `permissions` at `:233`); thread
   through `ApplyContext` (`:152-172`).
3. New preflight guard in `runPreflightGuards` (`:388-456`), **after clock-skew (`:400`)**, gated on
   write/sale `entityType`: if `mutation.clientModifiedAt > access_valid_until + CLOCK_SKEW` →
   `{kind:'rejected', code:'SUBSCRIPTION_LAPSED_AT_WRITE'}`. (`access_valid_until` from WS-1; today
   approximate as `checkAccess().gracePeriodEndsAt ?? currentPeriodEnd`.)
**Constants:** `MAX_CLIENT_CLOCK_SKEW_MS` (`sync-constants.service.ts:37`, 5min);
`REVOCATION_GRACE_WINDOW_MS` (`:29`, 30min) is the analogue precedent.

---

## WORKSTREAM 1 — Account-level Hybrid subscription

**Design change:** introduce one **`user_subscription`** per owner-user that governs `max_stores`
+ account-level status/grace/expiry, while **device/user limits stay per-store** (device §2). The
per-store `store_subscription` + `subscription_version` stays (each store reflects **its owner's**
account plan; invited stores read their owner's status via the snapshot).

### 1.1 🆕 Schema
- **`user_subscription`** table (model on `store-subscription.ts`): `id, guuid, user_fk → user.id`,
  `plan_fk → subscription_plan.id`, `status` (same enum), `trial_ends_at`, `current_period_start/end`,
  `access_valid_until` (computed = `max(current_period_end, past_due_grace_until)`),
  `subscription_version int default 1`, razorpay ids, `cancelled_at/by`, `paused_at/resumes_at`,
  `cancel_at_period_end bool`, audit fields. Partial-unique on `user_fk WHERE deleted_at IS NULL`.
- **`subscription_plan.max_stores int|null`** (`subscription-plan.ts:~61`) + a `plan_feature` row
  (`feature_key='max_stores'`) — mirror how `max_devices`/`max_users` are stored.
- ⚠️ `store.ownerUserFk` (`store.ts:82`) exists but is **NOT written in `create`**
  (`store.service.ts:194-215` insert omits it) — ownership is via `user_role_mapping role='STORE_OWNER'`.
  **Decide & fix:** either backfill+populate `ownerUserFk` (simpler single-table account queries) or
  use the role-mapping join everywhere. Recommend populating `ownerUserFk` at create.

### 1.2 🔧 `access_valid_until` + account-level grace in `checkAccess`
**File:** `modules/subscription/services/subscription.service.ts:310-363`.
**Do:** after resolving the per-store row, also resolve the owner's `user_subscription`; fold
`access_valid_until` into the returned shape (add to the cached result object `:352-358` **and** the
parse block `:322-335`). `GRACE_DAYS=7` (`constants/subscription.constants.ts:25`). The store guard's
`past_due`/`cancelled` branches should honor the **account** boundary.

### 1.3 🔧 Extend `SubscriptionStatusGuard` for account scope
**File:** `common/guards/subscription-status.guard.ts:87-150`. Keep store-scoped enforcement, but the
window comes from account `access_valid_until`. (Runs after `PermissionsGuard` in
`guards.module.ts:38`.) `@SkipSubscriptionCheck`/`@RequiresFeature` decorators unchanged.

### 1.4 🆕 Account-scoped endpoints (cancel/reactivate/update-payment absent today)
New controller `@Controller('me/subscription')` (or `account/subscription`) — billing today is
store-scoped only (`billing.controller.ts @Controller('stores/:storeId/subscription')`):
- `GET /me/subscription` → account payload + `subscription_version` + `access_valid_until`.
- `GET /me/sv` → version-only, ETag (mirror `billing.controller.ts:78-99` `W/"sv-${v}"` + 304).
- `POST /me/subscription/checkout` + `/verify` (account-scoped; reuse `billing.service` create/verify).
- `POST /me/subscription/cancel` (3-step; `cancel_at_period_end=true`), `/reactivate`,
  `/update-payment` — **all new** (confirmed absent).
- Owner-only + **step-up auth** (`@StepUpAuth`).

### 1.5 🔧/🆕 Version bumps + reconciliation cron (account-level)
- Bump `user_subscription.subscription_version` in the **same tx** as every account status change
  (model: existing per-store bump sites — `billing.service.ts:438-450`, `subscription.service.ts:187-199,245-257`,
  cron jobs).
- 🆕 **Account reconciliation cron** (model `subscription-reconciliation.job.ts` `*/5 * * * *`):
  flip account `past_due→cancelled` at `period_end + grace`; bump version; **fan out**
  `invalidateAccessCache` to all the owner's stores; trigger the store-lock/read-only flip (WS-3).
  Covers **time-based** transitions (events alone miss them).

### 1.6 🔧 Snapshot subscription payload (two builders)
`SnapshotSubscriptionPayload` (`crypto.service.ts:33-53`) already has the display fields. ⚠️ **two
builders** compute it — `snapshot.service.ts:buildSubscriptionPayload (:203-249)` (live snapshot,
synthesizes `expired`) and `subscription.mapper.ts:toSnapshotPayload (:37)` (used by
`getSubscriptionWithVersion`). Add `access_valid_until` to **both** so own-store + invited-store
reads agree. Each store entry keeps reflecting **its owner's** account plan.

---

## WORKSTREAM 2 — Version-header freshness (push version, pull doc)

**Goal:** every authenticated response carries tiny `x-permission-version` + `x-subscription-version`;
client pulls the document only when a version advances. Stop pushing multi-KB snapshots in
headers/bodies. **Two independent versions, one protocol — never a single `stateVersion`.**

### 2.1 🆕 Header constants
`common/constants/http-headers.ts` — add `PERMISSION_VERSION='x-permission-version'`,
`SUBSCRIPTION_VERSION='x-subscription-version'` (absent today).

### 2.2 🔧 Emit version headers on every response
**File:** `auth/mobile/interceptors/snapshot-refresh.interceptor.ts` (global `APP_INTERCEPTOR`,
`mobile-auth.module.ts:67`). Today it only fires when `auth.jwt.pv < currentVersion` (`:28-29`).
**Do:** restructure so it **always** sets `x-permission-version = auth.user.permissionsVersion` and
`x-subscription-version` (account version) **before** the pv-stale gate; keep the
`X-Permission-Snapshot` piggyback only behind the stale gate (and deprecate it once clients move to
pull-on-change). Alternatively register a thin sibling interceptor next to `ServerTimeInterceptor`
(`common.module.ts:133-136`). Guard against `headersSent`.

### 2.3 🆕 Pull endpoints
- `GET /me/snapshot` on `MeController` (after `pv`, `me.controller.ts:~64`): inject `SnapshotService`,
  return `buildAndSign(auth.user.id)` (snapshot + sig). ETag `W/"${permissionsVersion}-..."`.
- `GET /me/subscription` + `/me/sv` — WS-1.4 (account-level).

### 2.4 🔧 Stop inlining the snapshot in bodies
`/auth/refresh` (`mapper:72-74`) and `/sync/delta` piggyback — keep behind app-version gate for old
clients; new clients use the header + `GET /me/snapshot`. Unify the snapshot type (`PermissionSnapshot`
in refresh vs `Record<string,unknown>` in `sync-delta.dto.ts`).

### 2.5 🔧 `server_time` body fields
⚠️ Audit: auth/me mappers **do not** emit a `server_time` body field — only the **sync** module does
(`modules/sync/dto/time-response.dto.ts:8-9`, `time.controller.ts:26-27`). `x-server-time` is on every
response (`server-time.interceptor.ts`). So "remove server_time from bodies" applies to the sync
`time` response only (or leave `/time` as-is since it's the dedicated clock endpoint). No action
needed for auth/me.

---

## WORKSTREAM 3 — Store-lock (read-only) state + account-expiry flip

**Design change:** a store can be **locked** (read-only, reversible) on downgrade/account-expiry —
distinct from **archived** (soft-deleted). Never delete on downgrade.

### 3.1 🆕 Schema
`database/schema/store.ts` (after `archivedBy` `:87`, before `auditFields`): `locked_at timestamptz`
(NULL=unlocked), `locked_reason text` (`'downgrade'|'account_expired'`), optional `locked_by`.
Index `store_locked_idx on (locked_at)` (after `:96`). Mirror in
`modules/store/domain/store.domain.ts:31-32`.

### 3.2 🆕 `lock()`/`unlock()` ops (model archive `store.service.ts:645-751`)
Clone archive's structure but set `locked_at`/`locked_reason` instead of `archived_at`; **do NOT**
cancel subscription or run polymorphic cleanup (lock is reversible). Keep the member **pv bump**
(`bumpPermissionsVersionForStoreMembers`, `store.repository.ts:845-859`) + post-commit RBAC cache
invalidation so clients see read-only immediately. Add `assertNotLocked` in
`store.validator.ts:~58` and call it on write paths (`store.service.ts:489` update, etc.). New error
`STORE_LOCKED`.

### 3.3 🆕 Account-expiry flip job
No account-expiry job exists. Add `lockExpiredAccountStores()` (model bulk `expireStaleInvitations`
`store.repository.ts:581-593`): for owners whose `user_subscription.access_valid_until` + grace has
passed, `UPDATE store SET locked_at=NOW(), locked_reason='account_expired' WHERE owner...`; bump pv +
invalidate caches per store. On re-payment, `unlock` all and bump.

### 3.4 🔧 Downgrade store-selection (owner picks which to keep)
`max_stores` downgrade with excess → owner chooses keepers; the rest `lock()`. **Drain offline queue
first** (force final `/sync/delta` flush) before locking — see subscription.md §14B. Locked stores
**don't count** against `max_stores` (F0).

### 3.5 🔧 Bootstrap + preferences locked-awareness
`setPreferences` (`bootstrap.service.ts:231-256`) — add `assertNotLocked` parallel to the
archived guard (`:248-253`) (error `CANNOT_SET_LOCKED_DEFAULT`). Active-store cascade (`:369-381`)
keeps locked stores selectable (open read-only); only **revoked/missing** fall through (WS-0.3).

---

## WORKSTREAM 4 — Limit gates (max_users, max_stores)

### 4.1 🆕 `max_users_per_store` gate (invite + accept)
**Precedent to copy:** device `getMaxDevicesForStore`
(`store-device-access.repository.ts:266-294`) + `checkAndGrantAccess`
(`store-device-access.service.ts:49-88`) — swap `feature_key='max_users'`.
**Files:** `invitation.service.ts`.
- Soft check in `send` (~after rate-limit `:75`): active members + pending invites < `max_users` else
  `403 USER_LIMIT_REACHED {limit, active}`.
- **Authoritative** check in `doAccept` **inside tx, after the already-member guard (`:246`), before
  `insertRoleMapping (:255)`**. Add a `count()` repo helper (today only `findActiveMemberUserIds`
  `:185-196` returns ids). New error `USER_LIMIT_REACHED`.
**Endpoints:** `invitation.controller.ts` send `:49`, accept `:138/172`.

### 4.2 🆕 `max_stores` gate (create + ownership-transfer)
- **Create:** `store.service.ts create` — authoritative check **inside tx after
  `countAllOwnedByUserForUpdate (:191)`**, before insert `:194`; `403 STORE_LIMIT_REACHED {limit, active}`.
  ⚠️ `countAllOwnedByUser` (`store.repository.ts:141`) counts **incl. archived** — add an
  **active+unlocked-only** count for the cap (locked/archived shouldn't consume a slot).
- **Ownership transfer recipient:** `ownership-transfer.service.ts` — pre-check recipient's
  `max_stores` in `initiate` after the membership check (`:75`); **re-check inside `finalizeByOwner`
  tx before assigning STORE_OWNER (`:233`)** (count can change in the 7-day window). Block by default
  with an "upgrade & accept" path (subscription.md S9). pv bumps already at `:257-258`.

---

## WORKSTREAM 5 — Sync manifest + parallel cold-start

### 5.1 🆕 `GET /stores/:id/sync/manifest`
**File:** `modules/sync/controllers/sync.controller.ts` (after `initial` `:199`). Carry
`@StoreContext('param.storeId')` + guards; add `/sync/manifest` branch to the rate-limit guard
(WS-0.1). Return `{ schema_version, entities: [{entity_type, dependency_order, estimated_count, initial_cursor}] }`.
**Counts:** from each filter's `estimatedTotal` (`sync-initial.service.ts:264-266`); iterate
`SyncFilterRegistry.getAll()` (`sync-filter-registry.service.ts:48-52`, dependency-ordered).

### 5.2 Dependency groups (from the audited order list)
```
G1 reference  store(0) unit(2) store_device_access(2) lookup(5) payment_method(5) tax_rate(6) staff(8)
G2 parties    customer(20) supplier(21)
G3 catalog    product(10) paymentaccount(15)        (product before order; may overlap G2)
G4 inventory  stock_take(70..) stock_adjustment(72..) fifo_cost_layer(74) stock_history(75) stock_event(76)
G5 txn        order(30) order_item(31) shift(40)
```
Client downloads parallel within a group, gates between groups on FKs; server allows parallel
`/sync/initial` across entities under the per-(user,store) budget (WS-0.1). Apply-in-dependency-order
on the client.

---

## WORKSTREAM 6 — Cross-cutting / common infra

| # | Change | File |
|---|---|---|
| 6.1 🆕 Error codes | `subscription_lapsed_at_write` (422), `store_limit_reached` (403), `user_limit_reached` (403), `store_locked` (403), `cannot_set_locked_default` (403) | `common/constants/error-codes.ts` const block + metadata map |
| 6.2 🆕 Header constants | `x-permission-version`, `x-subscription-version` | `common/constants/http-headers.ts` |
| 6.3 🔧 Wire shapes | add `access_valid_until`, `active_store`, version headers, new gate codes to the shared lib so client/server can't drift | `libs-common/shared-types` |
| 6.4 🔧 Snapshot type unify | `PermissionSnapshot` (not `Record<string,unknown>`) in delta | `modules/sync/dto/sync-delta.dto.ts` |
| 6.5 🔧 Tombstone trim | drop `deleted_by_user_fk`/`deleted_by_display_name` from `/sync/changes` deletes (move to activity endpoint) | `modules/sync/mappers/sync.mapper.ts` |
| 6.6 🔧 `sync_config` correctness | bootstrap no longer emits it (already removed); ensure client bakes the **21-entity** registry, not a stale 12-list | client + `shared-types` |
| 6.7 🔧 Push sender (optional) | device PRD assumes push but **no sender exists** (token stored, never sent). Either build FCM/APNs/Expo sender or keep next-call/sync propagation | new `modules/notification` |
| 6.8 🔧 `x-device-id`/`x-device-sig` headers | defined in `http-headers.ts` but never read — wire or delete | mobile-jwt guard |
| 6.9 🆕 Device-slot **release on logout** | `DELETE /stores/:id/access` (or cascade from `/auth/logout`) → `store_device_access.status='revoked', revoked_reason='released'` → frees the slot immediately (don't wait 30 days). Best-effort + offline-queued; 30-day expiry stays the backstop. ([device-management F10B](./device-management.md#15b-f10b--device-slot-lease-heartbeat--explicit-release)) | `store-device-access.service.ts` + controller |
| 6.10 ✅ Sync-delta already supports client **queue priority / backoff / DLQ** | No backend change — `/sync/delta` already returns **per-mutation results** (applied/duplicate/rejected/conflict) + idempotency (`mutation_id`). Priority (sales-first), exponential backoff, and dead-lettering are **client-side** ([mobile-04 §8C.2a](./mobile-04-storage-and-state.md)). Backend must keep: per-mutation (not all-or-nothing) results, honor `Retry-After` on 429, and keep `4xx` business rejects non-retryable vs `5xx` transient. | (verify, no new code) |

---

## New endpoints (summary)

| Method | Path | WS | Status |
|---|---|---|---|
| GET | `/me/snapshot` | 2.3 | 🆕 |
| GET | `/me/subscription` · `/me/sv` | 1.4 | 🆕 (account) |
| POST | `/me/subscription/checkout` · `/verify` | 1.4 | 🆕 (account; reuse billing.service) |
| POST | `/me/subscription/cancel` · `/reactivate` · `/update-payment` | 1.4 | 🆕 |
| GET | `/stores/:id/sync/manifest` | 5.1 | 🆕 |
| DELETE | `/stores/:id/access` (release slot on logout) | 6.9 | 🆕 |
| (handlers) | order/order_item/order_payment/shift_session/cash_*/stock_* via `/sync/delta` | A | 🆕 |

## New tables / columns

- 🆕 `user_subscription` (account plan + `access_valid_until` + `subscription_version`).
- 🆕 `subscription_plan.max_stores` + `plan_feature` row `feature_key='max_stores'`.
- 🆕 `store.locked_at` / `locked_reason` / `locked_by` + `store_locked_idx`.
- 🔧 `order.shift_session_fk` → `NOT NULL` for sale orders.
- 🔧 populate `store.owner_user_fk` at create (or commit to role-mapping joins).

## New cron jobs

- 🆕 Account-subscription reconciliation (`*/5`): time-based account `past_due→cancelled`, version bump, fan-out cache invalidation.
- 🆕 Account-expiry store-lock flip (daily): lock owners' stores past `access_valid_until + grace`.

---

## Sequencing & dependencies

```
WS-A (POS handlers + open-shift + SUBSCRIPTION_LAPSED_AT_WRITE)  ── start now, parallel; unblocks offline POS
WS-0 (bug fixes: rate limiter, force_bootstrap, active-store)    ── now, no flag
   │
WS-1 (account user_subscription + max_stores + access_valid_until + account endpoints/cron)
   │        └─ feeds A.4 (real access_valid_until) and WS-3
WS-2 (version headers + /me/snapshot + stop inlining)            ── after WS-1 (needs subscription version)
WS-3 (store-lock + account-expiry flip)                          ── after WS-1
WS-4 (max_users + max_stores gates)                              ── after WS-1 (max_stores needs account plan)
WS-5 (manifest + parallel cold-start)                            ── after WS-0.1 (rate limiter)
WS-6 (cross-cutting)                                             ── threaded throughout
```
**Critical path for offline POS:** WS-A. **Critical path for the architecture:** WS-1 → WS-2.

---

## Acceptance tests (must pass)

1. **Offline checkout:** open shift → ring sale offline → reconnect → `/sync/delta` accepts order +
   items + payment; no `UNKNOWN_MUTATION` (WS-A).
2. **Open-shift:** sale with no open `shift_session` → `rejected: shift_not_open` (A.3).
3. **Offline-expiry:** account lapses mid-day; sales stamped before `access_valid_until` accepted,
   later ones `rejected: subscription_lapsed_at_write`; reads never blocked (A.4, §30).
4. **Subscription freshness:** pay on phone A → phone B's next response carries advanced
   `x-subscription-version` → pulls `/me/subscription`, banner clears (WS-2, R7).
5. **max_stores:** create over cap → `403 store_limit_reached`; ownership-transfer to a full
   recipient → blocked (WS-4).
6. **max_users:** invite/accept over cap → `403 user_limit_reached` (WS-4).
7. **Downgrade lock:** 5→2 stores → owner picks 2; other 3 `locked` read-only, data retained;
   re-upgrade reactivates (WS-3).
8. **Multi-store rate limit:** two stores cold-sync concurrently → independent budgets, no 429 (WS-0.1).
9. **Active-store:** revoked `last_opened` → falls to `default`; locked `last_opened` → opens
   read-only (WS-0.3).
10. **Version monotonicity:** out-of-order responses never downgrade the client's cached version
    (client guard; server just emits current).
```
