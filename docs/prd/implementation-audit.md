# Implementation Audit — PRD vs Codebase

> **Date:** 2026-06-29
> **Scope:** every PRD in `docs/prd/` cross-referenced against the backend (`apps/api/`) and
> mobile (`apps/retail-mobile/`) codebases. Each item is marked **✅ BUILT**, **🔧 PARTIAL**,
> or **🔴 MISSING** with file paths and line numbers.
> **Purpose:** single source of truth for what's done, what's partially done, and what remains
> to be built — organized by PRD, then by implementation priority.

---

## Table of contents

1. [Device Management](#1-device-management)
2. [Sync Engine (Backend)](#2-sync-engine-backend)
3. [Subscription & Billing](#3-subscription--billing)
4. [RBAC & Location System](#4-rbac--location-system)
5. [Mobile Sync & Offline (mobile-09 through mobile-12)](#5-mobile-sync--offline)
6. [Mobile Post-Login & Freshness (mobile-01 through mobile-08)](#6-mobile-post-login--freshness)
7. [Priority Implementation Roadmap](#7-priority-implementation-roadmap)
8. [Dependency Graph](#8-dependency-graph)

---

## 1. Device Management

**PRD:** [device-management.md](./device-management.md)
**Verdict: ✅ Fully built. All 22 business rules (BR-DEV-000 through BR-DEV-022) implemented.**

### 1.1 Endpoints & flows

| # | Feature (PRD ref) | Status | File | Line |
|---|---|---|---|---|
| 1 | `store_device_access` table — all columns (status, device_label, revoked_reason, first/last_accessed_at, revoked_at, revoked_by, row_version) | ✅ | `apps/api/src/database/schema/store-device-access.ts` | — |
| 2 | `device.blocked_at` column (F8) | ✅ | `apps/api/src/database/schema/device.ts` | 42 |
| 3 | POST /stores/:storeId/access — slot claim (F2) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 48 |
| 4 | Atomic count-and-insert in transaction + unique index (BR-DEV-018) | ✅ | `apps/api/src/modules/store/services/store-device-access.service.ts` | 91 |
| 5 | Device limit reads from account subscription → plan → max_devices_per_store (§2, D11) | ✅ | `apps/api/src/modules/store/repositories/store-device-access.repository.ts` | 295 |
| 6 | F5 — Remove device from store (POST /stores/:id/devices/:id/revoke) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 172 |
| 7 | Self-lockout prevention — cannot remove own current device (BR-DEV-005) | ✅ | Controller checks `auth.device.guuid !== deviceGuuid` | — |
| 8 | F8 — Block stolen device (PATCH /devices/:guuid/block) — revokes ALL sessions + ALL store access atomically, nullifies push token, blacklists JWTs | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 286 |
| 9 | F9 — Unblock device (PATCH /devices/:guuid/unblock) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 300 |
| 10 | F10 — Auto-expiry cron (daily 2 AM, 30-day inactivity) | ✅ | `apps/api/src/modules/store/jobs/device-expiry.job.ts` | — |
| 11 | F10B.1 — Explicit release on logout (event-driven via `device.logout` event) | ✅ | `apps/api/src/modules/store/jobs/device-logout.handler.ts` | — |
| 12 | F7 — GET /devices/my (user-level, all devices across all stores) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 229 |
| 13 | F4 — GET /stores/:storeId/devices (store-level management list) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 140 |
| 14 | F12 — Push token management (PATCH /devices/:guuid/push-token) | ✅ | `apps/api/src/modules/store/controllers/store-device.controller.ts` | 314 |
| 15 | POST /stores/:id/open — merged access + context + subscription endpoint (§8.3) | ✅ | `apps/api/src/modules/store/controllers/store.controller.ts` | 102 |
| 16 | Sync cleanup on device revocation — sync_init_progress deletion (F13) | ✅ | `apps/api/src/modules/store/services/store-device-access.service.ts` | — |
| 17 | F0 — Store creation gate (max_stores) | ✅ | `apps/api/src/modules/store/services/store.service.ts` | 205–214 |
| 18 | Heartbeat endpoint for lease renewal | ✅ | — | — |
| 19 | Device label editing (per-store) + user device rename (account-level) | ✅ | — | — |
| 20 | Permission version bump on device revocation | ✅ | — | — |
| 21 | All revocation reasons: `owner_removed`, `stolen`, `auto_expired`, `plan_downgrade`, `self_released` | ✅ | — | — |

### 1.2 What's deferred (Phase 2 per PRD §29)

These are explicitly deferred in the PRD and are NOT missing — they are out of scope for Phase 1:

- Device trust gating (`is_trusted` enforcement)
- Configurable expiry window (7/14/30/60/90 days)
- Geofencing, remote wipe, device groups, multi-user device login
- Device analytics, per-store push preferences, device transfer
- Attestation enforcement (optional per-store strict mode)
- Real push sender (FCM/APNs — tokens stored but never sent)

---

## 2. Sync Engine (Backend)

**PRD:** [sync-engine.md](./sync-engine.md)
**Verdict: 🔧 Mostly built. Core engine is production-grade; POS handler gaps remain.**

### 2.1 Mutation handlers — what exists

| Entity | Create | Update | Delete | File |
|---|---|---|---|---|
| product | ✅ | ✅ | ✅ | `apps/api/src/modules/product/handlers/product-*.handler.ts` |
| product_case | ✅ | ✅ | ✅ | `apps/api/src/modules/product/handlers/product-case-*.handler.ts` |
| customer | ✅ | ✅ | ✅ | `apps/api/src/modules/customer/sync/customer-*.handler.ts` |
| supplier | ✅ | ✅ | ✅ | `apps/api/src/modules/supplier/sync/supplier-*.handler.ts` |
| paymentaccount | ✅ | ✅ | ✅ | `apps/api/src/modules/payment-account/sync/payment-account-*.handler.ts` |
| lookup | ✅ | ✅ | ✅ | `apps/api/src/modules/product/handlers/lookup-*.handler.ts` |
| order | ✅ | — | — | `apps/api/src/modules/order/sync/order-create.handler.ts` |
| shift_session | ✅ | ✅ | — | `apps/api/src/modules/shift-session/sync/shift-session-{create,update}.handler.ts` |
| cash_movement | ✅ | — | — | `apps/api/src/modules/shift-session/sync/cash-movement-create.handler.ts` |
| **order_item** | 🔴 | 🔴 | 🔴 | Items are embedded inline in order-create; no standalone handler |
| **order_payment** | 🔴 | 🔴 | 🔴 | No dedicated handler |
| **stock_adjustment** | 🔴 | 🔴 | 🔴 | No sync handler for manual stock adjustments |
| **stock_take** | 🔴 | 🔴 | 🔴 | No sync handler for stock counts |
| **shift_event** | 🔴 | — | — | Events appended inline by shift handlers; no standalone handler |
| **denomination_count** | 🔴 | 🔴 | — | No sync handler |
| **audit_log** | 🔴 | — | — | No sync handler for financial audit trail |

### 2.2 Sync filters (pull-side)

All 21+ entity types have registered sync filters for the pull path (`/sync/initial` and
`/sync/changes`). The filter registry is at
`apps/api/src/modules/sync/services/sync-filter-registry.service.ts`.

Filters verified: `store`, `unit`, `store_device_access`, `lookup`, `payment_method`, `taxrate`,
`staff`, `product` (+`product_case`), `paymentaccount`, `customer` (+`customer_contact`),
`supplier` (+`supplier_contact`), `order`, `order_item`, `shift`, `stock_take`(+line),
`stock_adjustment`(+line), `fifo_cost_layer`, `stock_history`, `stock_event`.

### 2.3 Engine infrastructure

| Feature (PRD ref) | Status | File | Line | Detail |
|---|---|---|---|---|
| Cursor design — HMAC-signed, user+store bound, µs precision, 180d horizon (§4) | ✅ | `apps/api/src/modules/sync/services/cursor-codec.service.ts` | — | — |
| 180-day horizon — single shared constant (S-10 fix) | ✅ | `apps/api/src/modules/sync/services/sync-constants.service.ts` | 11–13 | `SYNC_HORIZON_DAYS = 180`, imported everywhere |
| Cold start `/sync/initial` — resumable, 200 rows/page, sessionStartedAt anchor (§5) | ✅ | `apps/api/src/modules/sync/services/sync-initial.service.ts` | — | — |
| GET /sync/manifest — entity counts + cursors for parallel cold start (§6) | ✅ | `apps/api/src/modules/sync/controllers/sync.controller.ts` | 72–81 | — |
| Delta pull `/sync/changes` — no-gap watermark advance, per-entity limit (§7) | ✅ | `apps/api/src/modules/sync/services/sync-changes.service.ts` | — | — |
| Tombstones — same-tx write, shared stream, ~~179d~~ **195d retention** (§8) | ⚠️ | `apps/api/src/modules/sync/repositories/tombstone.repository.ts` | — | 🔧 spec changed: 179d was **inverted** (retention must *exceed* the 180d horizon, see [sync-engine §8/S-22](./sync-engine.md)) — code must move to 195d |
| Mutation push `/sync/delta` — per-mutation tx, batch ≤100, preflight guards (§9) | ✅ | `apps/api/src/modules/sync/services/sync-delta.service.ts` | — | — |
| Idempotency — mutation_id ULID, same-tx write, race→503, duplicate replay (§10) | ✅ | `apps/api/src/modules/sync/repositories/mutation-idempotency.repository.ts` | — | — |
| Conflict resolution — optimistic lock, server_row returned, conflict_type field (§11) | ✅ | `apps/api/src/modules/sync/dto/sync-delta.dto.ts` | 65 | `MASTER_DATA \| VALIDATION \| BUSINESS_RULE` |
| Point-in-time entitlement — wasCrudAuthorizedAt, 3-layer backdate defense (§12) | ✅ | `apps/api/src/modules/sync/services/sync-delta.service.ts` | — | — |
| SUBSCRIPTION_LAPSED_AT_WRITE gate (§12/§20) | ✅ | `apps/api/src/modules/sync/services/sync-delta.service.ts` | 448–459 | Rejects if `client_modified_at > accessValidUntil` |
| StockEventService.recordDelta — wired from order-create handler (§14) | ✅ | `apps/api/src/modules/order/sync/order-create.handler.ts` | 109–120 | — |
| Parent-cascade — failedGuuids set, PARENT_FAILED rejection (§9) | ✅ | `apps/api/src/modules/sync/services/sync-delta.service.ts` | 269–281 | — |
| Cached-rejected-as-failed fix (S-3) | ✅ | `apps/api/src/modules/sync/services/sync-delta.service.ts` | 345–361 | Duplicates with rejected/conflict cached result → added to failedGuuids |
| Rate limiting — per-(user, store, endpoint), fail-open on Redis error (§16) | ✅ | `apps/api/src/modules/sync/guards/sync-rate-limit.guard.ts` | 137–167 | — |
| Outbox — transactional, 5s poll, at-least-once, backoff + DLQ (§17) | ✅ | `apps/api/src/modules/sync/jobs/outbox-publisher.service.ts` | — | — |
| device_sync_health — written on every sync call | ✅ | `apps/api/src/modules/sync/controllers/sync.controller.ts` | 130, 214, 303 | — |
| Conflict types on DTO (`MASTER_DATA \| VALIDATION \| BUSINESS_RULE`) | ✅ | `apps/api/src/modules/sync/dto/sync-delta.dto.ts` | 65, 86, 93 | Mapped in sync.mapper.ts:137,147 |
| Cleanup jobs — tombstone (3 AM, ~~179d~~ **195d** — see §8 fix above), idempotency (3 AM, 30d), outbox (4 AM, 7d) | ⚠️ | `apps/api/src/modules/sync/jobs/` | — | All use cronLock, staggered; tombstone retention constant must change to `HORIZON + BUFFER` |

### 2.4 Gaps

| Feature (PRD ref) | Status | Detail | Priority |
|---|---|---|---|
| order_item handlers (§3, §24 #1) | 🔴 | Items embedded in order-create, no standalone handler for the client to push `order_item` mutations separately | P2 |
| order_payment handlers (§3, §24 #1) | 🔴 | No handler — tender split can't be pushed via sync | P2 |
| stock_adjustment / stock_take handlers (§3, §24 #1) | 🔴 | Manual stock operations can't push via sync | P2 |
| shift_event / denomination_count / audit_log handlers (§3) | 🔴 | Shift lifecycle events can't push standalone | P2 |
| Manifest checksum + entity_version (§6.1, S-16) | 🔴 | Always `null` / `1` — skip-unchanged cold starts don't work | P3 |
| minimum_client_version enforcement (§6.2, S-17) | 🟡 | Field in manifest response but always `null`; no `410 UPGRADE_REQUIRED` on `/changes` or `/delta` | P3 |
| Server-side poison mutation DLQ cap (S-7) | 🟡 | 5-minute TTL cache prevents infinite retries short-term; no permanent dead-letter | P3 |
| device_sync_health consumers (S-14) | 🟡 | Written but never read — no stale-device alerts | P4 |
| Topological sort in delta submit (S-3) | 🟡 | Relies on client sending parent-before-child; no server-side sort | P4 |
| Open-shift enforcement on order handler (§24 #4) | ✅ | Already implemented at `order-create.handler.ts:37-62` | — |

---

## 3. Subscription & Billing

**PRD:** [subscription.md](./subscription.md)
**Verdict: 🔴 Major structural gaps. The Account entity (§27 Phase 0) is the foundational
blocker — everything else depends on it.**

### 3.1 What's built

| Feature (PRD §27 ref) | Status | File | Line | Detail |
|---|---|---|---|---|
| `user_subscription` table | ✅ | `apps/api/src/database/schema/user-subscription.ts` | — | Per-user (not per-account); will be replaced |
| GET /me/subscription endpoint (#10) | ✅ | `apps/api/src/modules/subscription/controllers/account-subscription.controller.ts` | 69–83 | Returns full payload with `access_valid_until`, `banner_severity`, `subscription_version` |
| GET /me/subscription/sv — ETag poll (#10) | ✅ | `apps/api/src/modules/subscription/controllers/account-subscription.controller.ts` | 90–110 | Cheap version check |
| X-Subscription-Version header (#9) | ✅ | `apps/api/src/modules/subscription/controllers/account-subscription.controller.ts` | 81 | Set on every `/me/subscription` response |
| subscription_version bumping (#8) | ✅ | Reconciliation cron + service `bumpVersionById()` | — | — |
| Reconciliation cron — 5-min (#11) | ✅ | `apps/api/src/modules/subscription/jobs/account-reconciliation.job.ts` | 30 | Transitions `active→past_due`, `past_due→cancelled`; bumps version |
| POST /me/subscription/cancel (#15) | ✅ | Built and verified | — | Sets `cancel_at_period_end = true`; owner/co_owner only |
| POST /me/subscription/reactivate (#16) | ✅ | Built and verified | — | Clears `cancel_at_period_end` or re-bills |
| max_stores gate at POST /stores (#18) | ✅ | `apps/api/src/modules/store/services/store.service.ts` | 205–214 | Throws `STORE_LIMIT_REACHED { limit, active }` |
| store.lockedAt / lockedReason / lockedBy (#21) | ✅ | `apps/api/src/database/schema/store.ts` | 94–96 | Fields exist for downgrade locking |
| Plan seed — 8 plans, idempotent, onConflictDoUpdate (#30) | ✅ | `apps/api/src/database/seeds/13-subscription-plans.ts` | 290 | free, basic×2, premium×2, professional×2, enterprise×2 |
| SubscriptionStatusGuard — account-level check | 🔧 | `apps/api/src/common/guards/subscription-status.guard.ts` | 58–69 | Has `checkAccountAccess(userId)` BUT still reads `user_subscription`, not `account_subscription` |
| SubscriptionStatusGuard — store-level check | 🔧 | `apps/api/src/common/guards/subscription-status.guard.ts` | 80 | Still reads `store_subscription`, not `account_subscription` |
| X-Subscription-Warning header (grace) | ✅ | `apps/api/src/common/guards/subscription-status.guard.ts` | 113–115 | — |

### 3.2 What's missing — Phase 0 (Account Entity, foundational)

**Everything in Phase 1/2/3 depends on Phase 0 being built first.**

| Feature (PRD §27 ref) | Status | Detail |
|---|---|---|
| `accounts` (or `business_account`) table (#1) | 🔴 | No tenant/organization entity exists. The existing `account.ts` is the Better Auth credential table (OAuth tokens, password hashes) — NOT the business account. |
| `account_users` table — M:M with roles (#2) | 🔴 | No mapping of users to accounts with roles (owner, co_owner, manager, cashier, accountant). Current RBAC uses store-level `user_role_mapping` only. |
| `account_subscription` table (#3) | 🔴 | Subscription is still per-user (`user_subscription.userFk`), not per-account (`account_subscription.account_fk UNIQUE`). |
| `stores.account_fk` column (#4) | 🔴 | Stores still have `ownerUserFk: text('owner_user_fk')`. No `account_fk` FK to the business account. |
| Drop `store_subscription` (#5) | 🔴 | Table and all code references remain. `subscription.service.ts` and `subscription-status.guard.ts` still read from it. |
| Atomic signup transaction (#6) | 🔴 | Signup creates only the user. No atomic creation of `accounts` + `account_users(role=owner)` + `account_subscription(status=trialing, has_used_trial=true)`. |

### 3.3 What's missing — Phase 1 (Enforcement)

| Feature (PRD §27 ref) | Status | Detail |
|---|---|---|
| Guard reads `account_subscription` (#7) | 🔴 | Still reads `store_subscription` and `user_subscription` |
| `plan_entitlements` table — integer limits (#31) | 🔴 | Single `plan_feature` table with mixed `valueBoolean` / `valueInteger` (type union anti-pattern). PRD requires two separate tables. |
| `plan_features` table — boolean capabilities (#31) | 🔴 | Same — not split |
| `access_valid_until` in sync delta (#12) | ✅ | Already enforced — `SUBSCRIPTION_LAPSED_AT_WRITE` |
| Trial cron at `trial_ends_at` (#11) | ✅ | Reconciliation cron handles `trialing→cancelled` |

### 3.4 What's missing — Phase 2 (Billing + Limits + Members)

| Feature (PRD §27 ref) | Status | Detail |
|---|---|---|
| Account-scoped checkout (#13) | 🔴 | Checkout still store-scoped (`POST /stores/:id/subscription/checkout`) |
| Account-scoped verify (#14) | 🔴 | Verify still store-scoped |
| PATCH payment method (#17) | 🔴 | No endpoint |
| max_locations_per_store gate (#19) | 🔴 | No `location` entity exists at all |
| max_users_per_store gate at invitations (#20) | 🔴 | No count check at invite/accept |
| max_products gate (#22) | 🔴 | No product count enforcement at create |
| location.locked state (#21) | 🔴 | No location table |
| GET /me/account/members (#23) | 🔴 | No endpoint |
| POST /me/account/members/invite (#24) | 🔴 | No endpoint |
| PATCH /me/account/members/:userId/role (#25) | 🔴 | No endpoint |
| DELETE /me/account/members/:userId (#26) | 🔴 | No endpoint |
| PATCH /me/account (settings) (#27) | 🔴 | No endpoint |

### 3.5 What's missing — Phase 3 (History)

| Feature (PRD §27 ref) | Status | Detail |
|---|---|---|
| GET /me/account/subscription/events (#28) | 🔴 | No subscription event log |
| GET /me/account/subscription/invoices (#29) | 🔴 | No invoice endpoints / GST split |

### 3.6 Seed corrections needed (§3.1)

| Rule | Status | Detail |
|---|---|---|
| Per-frequency upgrade/downgrade ladder complete (§3.1 rule 1) | 🔴 | `basic_annual.upgradeToCode` points to `professional_annual` (should be `premium_annual`); `professional_monthly.downgradeToCode` points to `basic_monthly` (should be `premium_monthly`) |
| Enterprise Annual plan (§3.1 rule 2) | 🔧 | `enterprise_annual` exists in seed but verify the upgrade chain |
| `trialDays` decoupled from catalog (§3.1 rule 3) | 🔴 | Plans still carry `trialDays`; should be `0` with a service constant `TRIAL_DAYS` + `has_used_trial` flag |
| Entitlement reader contract (§3.1 rule 4) | 🔴 | No `plan_entitlements` table to read from |
| Feature reader contract (§3.1 rule 5) | 🔴 | No `plan_features` table to read from |
| Seed assertions (§3.1 rule 7) | 🔴 | No assertion that `max_locations_per_store >= 1` or that `multi_location` matches |
| Premium vs Professional DECISION (§3) | 🟡 | Both tiers exist; overlap not resolved |

---

## 4. RBAC & Location System

**PRD:** [rbac.md](./rbac.md) (§26.1–26.14)
**Verdict: 🔴 Mostly unbuilt. The entire location system (§26.2–26.11) is missing.
Core RBAC (PermissionsGuard) is fully built.**

### 4.1 What's built

| Feature (PRD ref) | Status | File | Detail |
|---|---|---|---|
| PermissionsGuard — full CRUD + special + H-6 cache invalidation + audit logging (§26.10) | ✅ | `apps/api/src/common/guards/permissions.guard.ts` | Complete with `permissionsVersion` comparison, critical-operation 30s TTL, and denial audit |
| Entity type registry with `is_offline_safe` (§26.11) | ✅ | `apps/api/src/modules/sync/services/entity-type-registry.service.ts` | `getOfflineSafeCodes()` method at line 76–82 |
| `@RequiresFeature` decorator (§26.6) | 🔧 | `apps/api/src/common/decorators/requires-feature.decorator.ts` | Decorator exists, sets metadata `REQUIRES_FEATURE_METADATA`. Guard reads it. BUT: does NOT actually enforce from `plan_features` table (table doesn't exist). |
| `permissions_version` signal | ✅ | `apps/api/src/modules/rbac/repositories/rbac-permissions.repository.ts` | Bumped on RBAC changes, store add/archive, ownership transfer |
| `subscription_version` signal | ✅ | `apps/api/src/modules/subscription/` | Independent from `permissions_version` |
| TenantGuard — store resolution | ✅ | `apps/api/src/common/guards/tenant.guard.ts` | Resolves `storeId`, sets `request.context = { storeId, storeGuuid }` |

### 4.2 What's missing — the location system

| Feature (PRD ref) | Status | Detail | Priority |
|---|---|---|---|
| `location` table with `is_primary`, `display_order`, `archived_at` (§26.2) | 🔴 | No schema file. Only text `locationId` in inventory tables (e.g. `stock_take.ts` has `locationId: text('location_id').notNull().default('default')`) | P0 |
| Head Office auto-provision at store-create (§26.2) | 🔴 | No location creation in the store-create flow. Should be `is_primary=true, display_order=0` in the same transaction | P0 |
| `user_location_mapping` table (§26.3) | 🔴 | No way to restrict which locations within a store a user can work at. Users mapped to stores only via `user_role_mapping` | P1 |
| `@LocationContext` decorator on TenantGuard (§26.3) | 🔴 | TenantGuard resolves `storeId` only. No location parameter resolution, no `request.context.locationId` | P1 |
| Location assignment check in dual gate — `userLocationMapping.isAssigned(userId, locationId)` (§26.3) | 🔴 | — | P1 |
| Bypass rule — STORE_OWNER and CO_OWNER access all locations (§26.3) | 🔴 | — | P1 |
| `location_fk` FK on `order` table (§26.7) | 🔴 | `order.ts` has `storeFk` only | P1 |
| `location_fk` FK on `shift` / `shift_session` table (§26.7) | 🔴 | `shift.ts` has `storeFk` only | P1 |
| `location_fk` FK on `register` table (§26.7) | 🔴 | `register.ts` has `storeFk` only | P1 |
| `location_fk` FK on `store_device_access` table (§26.7) | 🔴 | `store-device-access.ts` has `storeFk` only | P0 |
| Replace text `locationId` strings in inventory tables with `location_fk` FK (§26.7) | 🔴 | `stock_take.ts`, `stock_adjustment.ts`, `stock_history.ts`, `fifo_cost_layer.ts` all use text `locationId` | P1 |
| Bootstrap snapshot `locations[]` per store — `LocationEntry { location_id, location_guuid, name, is_primary, is_locked }` (§26.8) | 🔴 | `SnapshotStoreEntry` in `crypto.service.ts:55-67` has no `locations` field | P1 |
| `default_location_id` in bootstrap (§26.8) | 🔴 | — | P1 |
| Sync filters with `ctx.locationId` scope (§26.11) | 🔴 | All filters use `ctx.storeId` only. PRD target: `and(eq(order.storeFk, ctx.storeId), ctx.locationId ? eq(order.locationFk, ctx.locationId) : undefined)` | P3 |
| Location-scoped routes — `/stores/:id/locations/:id/orders`, `/stores/:id/locations/:id/inventory`, etc. (§26.2) | 🔴 | All routes are store-scoped only | P3 |
| `location_version` signal — bumped on location assignment changes (§26.8) | 🔴 | Not in user table, not part of the cache key | P1 |
| Cache key update to `rbac:{userId}:{storeId}:{pv}:{lv}:{sv}` | 🔴 | Currently `perm:{userId}:{storeId}` only | P1 |

### 4.3 What's missing — entitlements & features

| Feature (PRD ref) | Status | Detail | Priority |
|---|---|---|---|
| `EntitlementService` for count checks (§26.6) | 🔴 | No service to check `max_stores`, `max_locations_per_store`, `max_devices_per_store`, `max_users_per_store`, `max_products` limits | P2 |
| `@RequiresFeature` wired to `plan_features` table (§26.6) | 🔴 | Decorator exists but enforcement incomplete — no `plan_features` table exists | P2 |
| Report scoping — account/store/location level endpoints (§26.9) | 🔴 | No report endpoints at all. PRD specifies `GET /me/account/reports/summary`, `GET /stores/:id/reports/summary`, `GET /stores/:id/locations/:id/reports/summary` | P3 |

### 4.4 What's missing — Account-level (§26.4)

These overlap with Subscription §27 Phase 0 — listed here for completeness:

| Feature (PRD ref) | Status | Detail |
|---|---|---|
| `business_account` table (§26.4) | 🔴 | See Subscription §3.2 above |
| `account_subscription` table (§26.4) | 🔴 | See Subscription §3.2 above |
| `account_users` M:M join table (§26.4) | 🔴 | See Subscription §3.2 above |
| `stores.account_fk` replaces `owner_user_fk` (§26.4) | 🔴 | See Subscription §3.2 above |

---

## 5. Mobile Sync & Offline

**PRDs:** [mobile-09](./mobile-09-client-services-and-invariants.md),
[mobile-10](./mobile-10-local-database-schema.md),
[mobile-11](./mobile-11-sync-engine-client.md),
[mobile-12](./mobile-12-sync-implementation-audit.md)
**Verdict: ✅ Production-grade. All 5 load-bearing invariants implemented. 15/16 items built.**

### 5.1 Invariant conformance

| Invariant | Status | File | Line | Evidence |
|---|---|---|---|---|
| **INV-9** — Cursor advances only after rows commit (same tx) | ✅ | `apps/retail-mobile/src/sync/sync-engine.ts` | 347–352 | `db.transaction()` atomically applies changes + sets cursor |
| **INV-10** — Mark mutation applied only after effect commits (same tx) | ✅ | `apps/retail-mobile/src/sync/sync-engine.ts` | 240–242 | Per-result reconciliation in separate tx; mark-after-apply |
| **INV-5** — Migrate SQLite before sync | ✅ | `apps/retail-mobile/src/database/provider.tsx` | 149–153 | `DatabaseProvider` blocks render until `migrate()` completes |
| **Push-before-pull** | ✅ | `apps/retail-mobile/src/sync/sync-scheduler.ts` | 78–83 | `runPush()` then `runPull()` sequentially |
| **POS additive, not optimistic-lock** | ✅ | `apps/retail-mobile/src/sync/` | — | Sale appends signed-delta `stock_event`; no `expected_row_version` on stock writes |

### 5.2 Gap fixes from mobile-12 §5

| Gap | Status | File | Line | Detail |
|---|---|---|---|---|
| #1 — 410 SYNC_HORIZON_EXCEEDED handling | ✅ | `apps/retail-mobile/src/sync/sync-engine.ts` | 198–205 | Checks for 410, calls `handleHorizon()`. Cold start also handles 410 at `cold-start.ts:374-382` |
| #2 — Early POS unlock (G1–G3 unlock, G4–G5 background) | ✅ | `apps/retail-mobile/src/sync/cold-start.ts` | 48–93, 216–224 | 5 entity groups defined, `POS_GROUP_COUNT = 3`, emits `pos_unlocked` phase after G1–G3 |
| #3 — Monotonic snapshot version guard | ✅ | `apps/retail-mobile/src/store/authThunks.ts` | 325–336 | Explicit `if incomingVer <= currentVer → IGNORE` with comment "Monotonic guard (INV-1)" |
| #4 — Retry-After header parsing | ✅ | `apps/retail-mobile/src/sync/sync-engine.ts` | 496–507 | Parses `retry-after`, `Retry-After`, and `x-retry-after` headers; handles numeric + HTTP-date |
| #5 — parent_guuid enforcement in drain | ✅ | `apps/retail-mobile/src/sync/mutation-queue.ts` | 129–148 | `topoSort()` walks parent_guuid chain before visiting current mutation |

### 5.3 Local DB findings from mobile-12 §8

| Finding | Status | File | Detail |
|---|---|---|---|
| L-1 — `expected_row_version` on product/customer updates | ✅ | `apps/retail-mobile/src/database/schema/drizzle-schema.ts:652` | Field exists in schema. Correctly omitted for POS appends (additive), included for master-data updates |
| L-2 — List refresh on optimistic write | 🔧 | `apps/retail-mobile/src/features/products/hooks/use-products.ts:88` | Reload depends on Redux `syncStatus` selector. No explicit "tick" for immediate optimistic list refresh — relies on sync state changes |
| L-4 — Dead abstractions (createOfflineRepository, useEntityMutation) | ✅ | — | Not found in codebase — clean |

### 5.4 Client services (mobile-09)

| Service | Status | File | Detail |
|---|---|---|---|
| Single-flight refresh (INV-3) | ✅ | `apps/retail-mobile/src/store/authThunks.ts:249-315` | Module-level `refreshInFlight` promise; concurrent 401s await the same promise |
| Active-store-removed teardown (INV-4) | ✅ | `apps/retail-mobile/src/sync/hooks/useSyncEngine.ts:33-98` | Effect cleanup on storeId change; `clearActiveStore()` on logout |
| Subscription write gate (`access_valid_until`) | ✅ | `apps/retail-mobile/src/sync/write-gate.ts:25-56` | Checks status + `access_valid_until` window against server-aligned time |

### 5.5 Local SQLite tables

All required tables present in `apps/retail-mobile/src/database/schema/drizzle-schema.ts`:

**Domain (~35 tables):** stores, units, tax_rates, payment_methods, lookups, registers,
shift_definitions, service_areas, staff, store_device_access, products, product_cases, customers,
customer_contacts, suppliers, supplier_contacts, payment_accounts, orders, order_items,
order_payments, shift_sessions, shift_events, cash_movements, denomination_counts, audit_logs,
stock_events, stock_takes, stock_take_lines, stock_adjustments, stock_adjustment_lines,
fifo_cost_layers, stock_history, shift_assignments, rota_entries.

**Bookkeeping (~7 tables):** sync_cursors, sync_init_progress, local_store_state, mutation_queue,
failed_applies, sync_metrics, schema_meta (via Drizzle migrations).

### 5.6 Entity appliers

All 23+ appliers registered in `apps/retail-mobile/src/sync/appliers/`:
G1 (reference), G2 (parties), G3 (catalog), G4 (inventory), G5 (transactions).

---

## 6. Mobile Post-Login & Freshness

**PRDs:** [mobile-01](./mobile-01-auth-and-snapshot.md) through
[mobile-08](./mobile-08-loading-ux-states.md)
**Verdict: ✅ Mostly built. 14/17 items fully implemented.**

### 6.1 Auth & tokens (mobile-01)

| Feature | Status | File | Detail |
|---|---|---|---|
| Ed25519 snapshot signature verification | ✅ | `apps/retail-mobile/src/core/permissions/snapshot-verify.ts` | Full verification with canonical JSON stringification; public key bundled via `EXPO_PUBLIC_SNAPSHOT_PUBLIC_KEY` |
| x-nonce + x-timestamp headers on every request | ✅ | `apps/retail-mobile/src/infrastructure/http/interceptors.ts:193-195` | Auth-excluded paths correctly bypass |
| Server clock offset from x-server-time | ✅ | `apps/retail-mobile/src/infrastructure/http/clock.ts` | ±5min skew guard, persists to AsyncStorage, provides `getServerNow()` |

### 6.2 Response contracts (mobile-02)

| Feature | Status | File | Detail |
|---|---|---|---|
| Bootstrap still returns store_logos, store_hours, pending_invitations inline | 🔧 | `libs-common/api-manager/src/lib/me/types.ts:80-91` | PRD mobile-02 §3c says remove these (store_logos → lazy, store_hours → /stores/:id/context, pending_invitations → /me/invitations). Still present. |

### 6.3 Post-login flow (mobile-03)

| Feature | Status | File | Detail |
|---|---|---|---|
| Post-login routing — profile_status, account_mode, store resolution | ✅ | `apps/retail-mobile/src/core/routing/computeDestination.ts:39-74` | All branching per PRD §4 |
| POST /stores/:id/access on store open | ✅ | `apps/retail-mobile/src/features/store/hooks/use-claim-device-slot.ts:47-50` | Handles 403 device_limit_reached / device_revoked |
| Subscription gate after store open | ✅ | `apps/retail-mobile/src/core/subscription/FeatureGate.tsx:21-38` + `useCanMutate.ts:13-27` | — |
| Empty state routing — invitations vs create store (§8D) | ✅ | `apps/retail-mobile/src/core/routing/computeDestination.ts:58-62` | Invitations screen offers "Set up my own store instead" fallback |

### 6.4 Freshness (mobile-05)

| Feature | Status | File | Detail |
|---|---|---|---|
| X-Permission-Snapshot header consumption | ✅ | `apps/retail-mobile/src/infrastructure/http/interceptors.ts:112-122` | Piggybacked snapshot verified via `trustSnapshot()` before applying |
| X-Subscription-Version header consumption | ✅ | `apps/retail-mobile/src/infrastructure/http/interceptors.ts:130-134` | Triggers `pullSubscription()` on version bump |
| **GET /me/pv foreground polling** | 🔴 | — | **No independent pv heartbeat.** Relies only on piggybacked headers from sync (which runs every 30s). PRD §6 requires `GET /me/pv` (ETag→304) on: app→foreground, every 5–10 min while active, focus of privileged screens, and reconnect. |

### 6.5 Multi-store offline (mobile-06)

| Feature | Status | File | Detail |
|---|---|---|---|
| Per-store SQLite partitioning | ✅ | `apps/retail-mobile/src/sync/store-partition.ts:59-93` | All domain tables partitioned by `store_fk` |
| Store switching with zero-network permission swap | ✅ | `apps/retail-mobile/src/store/authThunks.ts:133-136` | Single snapshot covers all stores |
| LRU eviction policy (MAX_CACHED_STORES=3) | ✅ | `apps/retail-mobile/src/sync/store-partition.ts:138-158` | Tracks `last_used_at`, evicts oldest; never evicts active/syncing/pending stores |

### 6.6 Loading & UX states (mobile-08)

| Feature | Status | File | Detail |
|---|---|---|---|
| Optimistic writes pattern | ✅ | `apps/retail-mobile/src/sync/mutation-queue.ts:37-91` | `enqueueMutation()` in same tx as local write; commits instantly, queue drains async |
| Anti-flash spinner delay (400ms) | ✅ | `apps/retail-mobile/src/hooks/use-deferred-loading.ts:3` | `ANTI_FLASH_MS = 400`, `minVisibleMs = 500` |
| **Persistent sync status chip (all screens)** | 🔧 | `apps/retail-mobile/src/store/sync-slice.ts:5-12` | SyncStatus enum defined (`idle \| pulling \| pushing \| cold-starting \| catching-up \| offline \| error`) but only shown on Dashboard. Should be elevated to persistent chrome element (header/footer). |

---

## 7. Priority Implementation Roadmap

### P0 — Foundation (everything else depends on these)

| # | Task | PRD Source | Dependencies |
|---|---|---|---|
| 1 | **Create `accounts` (business_account) table** | subscription §27 #1, rbac §26.4 | None |
| 2 | **Create `account_users` table** with roles (owner/co_owner/accountant/manager/cashier) | subscription §27 #2, rbac §26.4 | #1 |
| 3 | **Create `account_subscription` table** | subscription §27 #3 | #1 |
| 4 | **Add `stores.account_fk`**, migrate from `owner_user_fk` | subscription §27 #4 | #1 |
| 5 | **Split `plan_feature` into `plan_entitlements` + `plan_features`** | subscription §27 #31, §3.1 | None |
| 6 | **Drop `store_subscription`** — all reads via `account_subscription` | subscription §27 #5 | #3, #4 |
| 7 | **Atomic signup** — account + account_users(owner) + account_subscription(trialing) | subscription §27 #6 | #1, #2, #3 |
| 8 | **Create `location` table** with Head Office auto-provision at store-create | rbac §26.2 | None |
| 9 | **Add `location_fk` to `store_device_access`** | rbac §26.7, device §26.13 P0 | #8 |

### P1 — Core Enforcement

| # | Task | PRD Source | Dependencies |
|---|---|---|---|
| 10 | **SubscriptionStatusGuard reads `account_subscription`** | subscription §27 #7 | P0 #3, #4 |
| 11 | **Add `location_fk`** to order, shift, shift_session, register | rbac §26.7 | P0 #8 |
| 12 | **Create `user_location_mapping` table** | rbac §26.3 | P0 #8 |
| 13 | **TenantGuard — add `@LocationContext` resolver** + location assignment check | rbac §26.3 | #12 |
| 14 | **Bootstrap snapshot — include `locations[]`** per store | rbac §26.8 | #12 |
| 15 | **Replace text `locationId`** in inventory tables with `location_fk` FK | rbac §26.7 | P0 #8 |
| 16 | **Entitlement gates** — max_locations at POST /stores/:id/locations, max_users at invite, max_products at create | subscription §27 #19–22, rbac §26.6 | P0 #5 |
| 17 | **`@RequiresFeature` wired to `plan_features` table** | rbac §26.6 | P0 #5 |
| 18 | **GET /me/pv foreground polling** on mobile | mobile-05 §6 | None |

### P2 — Sync Handlers + Billing

| # | Task | PRD Source | Dependencies |
|---|---|---|---|
| 19 | **order_item / order_payment sync handlers** | sync-engine §3, §24 #1 | None |
| 20 | **stock_adjustment / stock_take sync handlers** | sync-engine §3, §24 #1 | None |
| 21 | **shift_event / denomination_count / audit_log handlers** | sync-engine §3 | None |
| 22 | **Account member management** — /me/account/members/* CRUD | subscription §27 #23–27 | P0 #1, #2 |
| 23 | **Account-scoped checkout/verify** | subscription §27 #13–14 | P0 #3 |
| 24 | **Lean bootstrap** — remove store_logos, store_hours, pending_invitations inline | mobile-02 §3c | None |
| 25 | **Persistent sync chip** — elevate from Dashboard to global chrome | mobile-08 §13 | None |

### P3 — Polish + Advanced

| # | Task | PRD Source | Dependencies |
|---|---|---|---|
| 26 | **Manifest checksum + entity_version** for skip-unchanged cold starts | sync-engine §6.1 | None |
| 27 | **minimum_client_version enforcement** — 410 UPGRADE_REQUIRED | sync-engine §6.2 | None |
| 28 | **Sync filters with `ctx.locationId`** scope | rbac §26.11 | P1 #11, #13 |
| 29 | **Location-scoped routes** — /stores/:id/locations/:id/* | rbac §26.2 | P0 #8, P1 #13 |
| 30 | **Report scoping** — account/store/location level endpoints | rbac §26.9 | P0 #1, #8 |
| 31 | **Seed corrections** — fix upgrade/downgrade ladder, trialDays decoupled, assertions | subscription §3.1 | P0 #5 |
| 32 | **List refresh on optimistic write** — explicit tick mechanism | mobile-12 §8 L-2 | None |

### P4 — Deferred / Low Priority

| # | Task | PRD Source |
|---|---|---|
| 33 | Server-side poison mutation DLQ cap | sync-engine S-7 |
| 34 | device_sync_health consumers (stale-device alerts) | sync-engine S-14 |
| 35 | Invoice/GST endpoints | subscription §27 #28–29 |
| 36 | Subscription event history | subscription §27 #28 |
| 37 | Account settings screen | subscription §27 #27 |
| 38 | Topological sort in delta submit (server-side) | sync-engine S-3 |
| 39 | Premium vs Professional tier DECISION | subscription §3 |

---

## 8. Dependency Graph

```
┌─────────────────────────────────────────────────────────────┐
│                    P0 — FOUNDATION                          │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │ Account Entity   │    │ Location Entity  │               │
│  │ ─────────────    │    │ ───────────────  │               │
│  │ accounts table   │    │ location table   │               │
│  │ account_users    │    │ Head Office auto │               │
│  │ account_sub      │    │ location_fk on   │               │
│  │ stores.account_fk│    │ device_access    │               │
│  │ drop store_sub   │    └────────┬─────────┘               │
│  │ atomic signup    │             │                          │
│  │ split plan tables│             │                          │
│  └────────┬─────────┘             │                          │
│           │                       │                          │
└───────────┼───────────────────────┼──────────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────────┐  ┌────────────────────────┐
│ P1 — ENFORCEMENT      │  │ P1 — LOCATION SCOPING  │
│ Guard → account_sub   │  │ location_fk on tables  │
│ Entitlement gates     │  │ user_location_mapping  │
│ @RequiresFeature wire │  │ @LocationContext guard │
│ /me/pv polling        │  │ snapshot locations[]   │
└───────────┬───────────┘  └────────┬───────────────┘
            │                       │
            ▼                       ▼
┌───────────────────────┐  ┌────────────────────────┐
│ P2 — SYNC + BILLING   │  │ P3 — POLISH            │
│ order_item handlers   │  │ location-scoped routes │
│ stock handlers        │  │ sync location filters  │
│ account members CRUD  │  │ report scoping         │
│ account checkout      │  │ manifest checksums     │
│ lean bootstrap        │  │ min client version     │
│ persistent sync chip  │  │ seed corrections       │
└───────────────────────┘  └────────────────────────┘
```

**The two structural pillars are Account Entity and Location Entity.** They can be built in
parallel (no dependency between them). Everything in P1+ depends on at least one of them.

---

## What MUST NOT change (from the PRDs)

These are explicit architectural decisions that must be preserved:

| Decision | PRD Source | Rationale |
|---|---|---|
| Roles remain **store-scoped**, not location-scoped | rbac §26.14 | One role per store, multiple location assignments. Prevents N duplicate roles for multi-location staff. |
| Permission union across roles remains OR logic | rbac §26.14 | Already correct |
| Reads are **never** subscription-blocked | subscription §7, device §20 | Only writes are gated |
| Point-in-time authorization for offline sync | sync-engine §12 | Must extend to include location assignment check |
| Critical operations use 30s cache TTL | rbac §26.14 | Already implemented in PermissionsGuard |
| System roles (STORE_OWNER, USER, SUPER_ADMIN) remain immutable | rbac §26.14 | Already correct |
| Invitations assign custom roles only | rbac §26.14 | Already correct |
| Master data = optimistic lock; POS data = additive/event-sourced | sync-engine §13 | Never conflict-reject a sale |
| Cursor advances only after rows commit (INV-9) | mobile-09 §4 | Single most important durability rule |
| Push before pull on reconnect | mobile-11 §10 | Flush local writes first to reduce conflicts |
| One snapshot, all stores — never split into per-store tables | mobile-06 §8.7 | Zero-network store switch |
| Subscription is its own domain — independent `subscriptionVersion`, never collapsed into a single global `stateVersion` | mobile-07 §11 Phase 2 | Decouples permission and subscription freshness |
