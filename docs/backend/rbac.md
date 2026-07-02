# RBAC — Role-Based Access Control (Backend PRD)

> **App:** Ayphen Retail (NestJS · Drizzle ORM · Redis · offline-first POS)
> **Codebase root:** `apps/backend/src/` (this is the only app directory — there is no `apps/api/`).
> **Auth surface:** mobile-only today — `Authorization: Bearer <jwt>` (custom OTP + JWT flow, **no Better Auth, no web cookie session**). Web dashboard auth is a target, not built.
> **Scope:** every guard, decorator, permission model, cache layer, audit trail,
> sync integration, and security defence — each flow detailed, each marked built or target.
> **Companion docs:**
> - [subscription.md](./subscription.md) — subscription status guard, plan limits
> - [device-management.md](./device-management.md) — device slot + store access guards

---

## Implementation-status legend

This is a PRD: it mixes shipped code with target design. Every guard, table, service,
and cache key below carries one of these markers. When a marker is absent, assume **📋 target**.

| Marker | Meaning |
|---|---|
| ✅ **Built** | Exists in `apps/backend/src` today, matches this description. |
| 🟡 **Partial** | Exists but simpler/different than the full design here; the delta is called out inline. |
| 📋 **Target** | Not built yet. The contract below is the spec to build against. |

### Current reality snapshot (verified against source)

**Guards that exist today** (all under `apps/backend/src/auth/mobile/guards/`):

| Guard | File | Status |
|---|---|---|
| `MobileJwtGuard` | `auth/mobile/guards/mobile-jwt.guard.ts` | ✅ Built |
| `StoreGuard` | `auth/mobile/guards/store.guard.ts` | 🟡 Partial — this is the simplified `TenantGuard` (§10B) |
| `SubscriptionStatusGuard` | `auth/mobile/guards/subscription-status.guard.ts` | 🟡 Partial (§10E, §26.5) |
| `ThrottlerGuard` | NestJS built-in | ✅ Built |

**Guards that are 📋 target (not built):** `WebSessionGuard`, `JwtAuthGuard`, `StepUpAuthGuard`,
`PermissionsGuard`, `SuperAdminGuard`, `SyncRateLimitGuard`, `LocationGuard`.

**Tables that exist today:** `roles`, `rolePermissions` (Drizzle camelCase), `users`,
`deviceSessions`, `devices`, `accounts` (the Ayphen **business-account** tenant entity — *not* an
OAuth/credential table), `accountUsers`, `auditLogs`. **Tables that are 📋 target:**
`role_special_permission`, `user_role_mapping`, `entity_type`, `location`, `user_location_mapping`,
`account_subscription`, `plan_entitlements`, `plan_features`.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Guard execution order](#2-guard-execution-order)
3. [Database schema](#3-database-schema)
4. [System roles](#4-system-roles)
5. [Entity catalogue — 28 entities](#5-entity-catalogue--28-entities)
6. [CRUD permission matrix](#6-crud-permission-matrix)
7. [Special action codes](#7-special-action-codes)
8. [SUPER_ADMIN matrix](#8-super_admin-matrix)
9. [Default custom-role permissions](#9-default-custom-role-permissions)
10. [Guards — detailed](#10-guards--detailed)
    - 10A. MobileJwtGuard
    - 10B. TenantGuard
    - 10C. PermissionsGuard
    - 10D. StepUpAuthGuard
    - 10E. SubscriptionStatusGuard
    - 10F. SuperAdminGuard
    - 10G. SyncRateLimitGuard
11. [Decorators catalogue](#11-decorators-catalogue)
12. [Auth context types](#12-auth-context-types)
13. [Permission resolution flow — step by step](#13-permission-resolution-flow--step-by-step)
14. [Bootstrap permission snapshot](#14-bootstrap-permission-snapshot)
15. [Redis cache layer](#15-redis-cache-layer)
16. [Permissions version (H-6 race mitigation)](#16-permissions-version-h-6-race-mitigation)
17. [Point-in-time authorisation (offline sync)](#17-point-in-time-authorisation-offline-sync)
18. [Sync rate limiting](#18-sync-rate-limiting)
19. [Security defence-in-depth](#19-security-defence-in-depth)
20. [Audit & compliance (SOC2 CC6.3)](#20-audit--compliance-soc2-cc63)
21. [Role lifecycle](#21-role-lifecycle)
22. [Error codes](#22-error-codes)
23. [Adding a new entity or special action](#23-adding-a-new-entity-or-special-action)
24. [Complete flow examples](#24-complete-flow-examples)
25. [Business rules](#25-business-rules)
26. [Architecture gaps & target design](#26-architecture-gaps--target-design)
    - 26.1 [Missing: Location entity layer](#261-missing-location-entity-layer)
    - 26.2 [TenantGuard — resolve locationId](#262-tenantguard--resolve-locationid-alongside-storeid)
    - 26.3 [user_location_mapping](#263-user_location_mapping--location-assignment)
    - 26.4 [Account layer — account_subscription & account_users](#264-account-layer--account_subscription-and-account_users)
    - 26.5 [SubscriptionStatusGuard — Account → Subscription → Stores](#265-subscriptionstatusguard--account--subscription--stores)
    - 26.6 [Subscription entitlement enforcement](#266-subscription-entitlement-enforcement-in-guards)
    - 26.7 [Entity scoping: Orders, Inventory, Devices, Shifts](#267-entity-scoping-orders-inventory-devices-shifts-belong-to-location)
    - 26.8 [Bootstrap snapshot — include locations](#268-bootstrap-snapshot--include-accessible-locations)
    - 26.9 [Reports — store, location, account scopes](#269-reports--store-location-and-account-scopes)
    - 26.10 [Complete target permission flow](#2610-complete-target-permission-flow)
    - 26.11 [Sync filter extension](#2611-sync-filter-extension-for-location-scope)
    - 26.12 [Overall target hierarchy](#2612-overall-target-hierarchy--reference-model)
    - 26.13 [Implementation priority](#2613-implementation-priority)
    - 26.14 [What must NOT change](#2614-what-must-not-change)

---

## 1. Architecture overview

The RBAC system is a **multi-layer, store-scoped, Redis-cached permission model** with offline
protection and SOC2 audit compliance.

> **Implementation status of the guard chain below.** This is the **target architecture**.
> Guards in production today: **`MobileJwtGuard`** (✅), **`StoreGuard`** (🟡 — the partial
> `TenantGuard`), **`SubscriptionStatusGuard`** (🟡), and NestJS **`ThrottlerGuard`** (✅).
> Everything else in the chain (`WebSessionGuard`, `JwtAuthGuard`, `StepUpAuthGuard`,
> `PermissionsGuard`, `SuperAdminGuard`) is 📋 target — see the gap tracker in §26.

```
CLIENT REQUEST
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  GUARD CHAIN (NestJS global guard registration order)               │
│  Status: ✅ built · 🟡 partial · 📋 target                          │
│                                                                     │
│  1. ThrottlerGuard          ✅  Rate limit before crypto            │
│  2. WebSessionGuard         📋  Cookie auth → request.webAuth       │
│  3. MobileJwtGuard          ✅  Bearer auth → request.auth          │
│  4. JwtAuthGuard            📋  Ensures one of the above is set      │
│  5. StoreGuard (→TenantGuard) 🟡  Resolves storeId; verifies access │
│  6. StepUpAuthGuard         📋  MFA recency check (if @StepUpAuth)  │
│  7. PermissionsGuard        📋  CRUD + special action enforcement   │
│  8. SubscriptionStatusGuard 🟡  Plan limits + write-gate            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
CONTROLLER HANDLER
```

Today, a store-scoped mobile route runs only steps 1, 3, 5 (`StoreGuard`), and 8 — the RBAC
permission gate (step 7) and step-up (step 6) are not yet wired.

**Key design decisions:**
- **Store-scoped** — every permission is resolved per-store; a user may be owner in Store A
  and cashier in Store B. The two sets are independent.
- **Redis-backed snapshot** — permission matrix cached at `perm:{userId}:{storeId}` with a
  5-minute TTL (30 seconds for critical operations).
- **permissionsVersion** — a monotonic counter on the user row; every role change bumps it.
  The JWT carries the version at issue time; a mismatch busts the cache before the lookup.
- **Dual auth surface** — mobile uses `Authorization: Bearer <jwt>`; web uses HttpOnly session
  cookie. Both paths produce the same `EffectivePermissions` shape and use the same guards.
- **Offline mutations** — offline-queued mutations use **point-in-time authorization** via
  `wasCrudAuthorizedAt(asOf: Date)` — the user's role at the time the mutation was queued,
  not at the time it syncs.

---

## 2. Guard execution order

```
Pos│ Guard                   │ Status│ Sets / reads                      │ Throws
───┼─────────────────────────┼───────┼───────────────────────────────────┼──────────────────────────
1  │ ThrottlerGuard          │  ✅   │ —                                 │ 429 Too Many Requests
2  │ WebSessionGuard         │  📋   │ → request.webAuth                 │ —  (no-op if no cookie)
3  │ MobileJwtGuard          │  ✅   │ → request.auth                    │ 401 if bad JWT / blocked
4  │ JwtAuthGuard            │  📋   │ reads request.auth OR .webAuth    │ 401 MISSING_AUTH
5  │ StoreGuard (→TenantGuard)│ 🟡   │ → request.storeContext.{storeId,  │ 403 STORE_ACCESS_DENIED
   │                         │       │    accountId, isLocked}           │ 404 STORE_NOT_FOUND
6  │ StepUpAuthGuard         │  📋   │ reads session.lastStepUpAt        │ 403 STEP_UP_AUTH_REQUIRED
7  │ PermissionsGuard        │  📋   │ reads request.storeContext.storeId│ 403 PERMISSION_DENIED
   │                         │       │ → request.auth.permissions        │ 403 SPECIAL_PERMISSION_DENIED
8  │ SubscriptionStatusGuard │  🟡   │ reads account_subscription        │ 402 / 403
```

Guards 2–3 are **additive** (both may run; only one populates the auth context).
Guards 4–8 are **gatekeeping** (fail = request rejected).

> **Context object name.** The current `StoreGuard` writes **`req.storeContext`** of type
> `StoreContext` (`{ storeId, accountId, isLocked }`, defined in
> `apps/backend/src/auth/mobile/types/store-context.ts`) — *not* `request.context` /
> `ResolvedStoreContext`. The `request.context` / `ResolvedStoreContext` naming used in the
> target sections (§10B, §12, §26) is the planned `TenantGuard` shape. Wherever this doc says
> `request.context`, read `req.storeContext` for current behaviour.

The order is fixed at app bootstrap; changing it requires updating this document.

---

## 3. Database schema

> **Schema status.** The actual `apps/backend/src/db/schema.ts` currently defines only
> **`roles`** and **`rolePermissions`** (Drizzle camelCase). The other three tables below are
> 📋 **target — must be created via migration** before `PermissionsGuard` can ship:
> - `role_special_permission` (🔴 missing — special-action grants have nowhere to live)
> - `user_role_mapping` (🔴 missing — there is no user↔role M:M today)
> - `entity_type` (🔴 missing — no entity registry table)
>
> The existing `roles` table is also missing the `guuid`, `description`, and `is_editable`
> columns shown here; add them in the same migration. Table names below use the conceptual
> singular (`role`, `role_permission`); the Drizzle exports are plural camelCase
> (`roles`, `rolePermissions`).

### `role` — ✅ Built as `roles` (missing `guuid`, `description`, `is_editable`)
```sql
role
  id            bigserial PK
  guuid         uuid UNIQUE
  store_fk      bigint → store.id  -- NULL for system roles (USER, STORE_OWNER, SUPER_ADMIN)
  code          text  -- e.g. 'STORE_OWNER', 'CASHIER', 'SUPER_ADMIN'
  name          text  -- human label ("Head Cashier")
  description   text
  is_editable   boolean default true   -- false for system roles (immutable)
  created_at    timestamptz
  deleted_at    timestamptz

-- CHECK constraint enforced by DB:
CONSTRAINT system_role_no_store CHECK (
  store_fk IS NULL OR code NOT IN ('SUPER_ADMIN', 'USER', 'STORE_OWNER')
)
```

### `role_permission` (CRUD grants) — 🟡 Built as `rolePermissions` (no `revoked_at` soft-delete yet)
```sql
role_permission
  id          bigserial PK
  role_fk     bigint → role.id
  entity_code text     -- entity code, PascalCase (e.g. 'Order', 'Product')
  action      text     -- 'view' | 'create' | 'edit' | 'delete'
  granted_by  bigint → user.id
  granted_at  timestamptz default now()
  revoked_at  timestamptz  -- soft-delete; NULL = active grant
  UNIQUE (role_fk, entity_code, action)  -- one grant per (role, entity, action)
```

### `role_special_permission` (special action grants) — 📋 Target (table does not exist)
```sql
role_special_permission
  id           bigserial PK
  role_fk      bigint → role.id
  entity_code  text     -- e.g. 'Order'
  action_code  text     -- SCREAMING_SNAKE_CASE, e.g. 'REFUND', 'VOID'
  granted_by   bigint → user.id
  granted_at   timestamptz default now()
  revoked_at   timestamptz  -- soft-delete
  UNIQUE (role_fk, entity_code, action_code)
```

### `user_role_mapping` (assignments) — 📋 Target (no user↔role M:M table today)
```sql
user_role_mapping
  id          bigserial PK
  user_fk     bigint → user.id
  role_fk     bigint → role.id
  store_fk    bigint → store.id  -- NULL for system-wide roles
  assigned_by bigint → user.id
  assigned_at timestamptz default now()
  revoked_at  timestamptz  -- soft-delete
  expires_at  timestamptz  -- optional expiry (temporary assignments)
  UNIQUE (user_fk, role_fk, store_fk)
```

### `entity_type` — 📋 Target (no entity registry table today)
```sql
entity_type
  id                  bigserial PK
  code                text UNIQUE  -- 'Product', 'Order', ...
  label               text         -- 'Products', 'Orders', ...
  is_offline_safe     boolean      -- included in mobile snapshot offline_allowed_entities
  supports_attachments boolean
```

---

## 4. System roles

Three roles are **immutable system roles** (`is_editable = false`, `store_fk = NULL`):

| Code | Scope | Who has it | Can be modified? |
|---|---|---|---|
| `USER` | System-wide | Every new user automatically | No |
| `STORE_OWNER` | Store-scoped | Created when the store is created | No |
| `SUPER_ADMIN` | System-wide | Platform admin only | No |

A database `CHECK` constraint prevents any store-scoped role from using a system role code.
Custom roles always have `store_fk NOT NULL` and `code` freely chosen by the owner.

**Invitation flow — custom roles only.**
Invitations may assign **only custom roles** (system roles are never assignable via invitation
endpoint). The backend `InvitationService` rejects any `roleCode` matching a system role code
with `403 ROLE_NOT_ASSIGNABLE`.

---

## 5. Entity catalogue — 28 entities

```
Code               Label                  Offline-Safe  Attachments
─────────────────────────────────────────────────────────────────────
Product            Products               ✓             ✓
Order              Orders                 ✓             ✓
Customer           Customers              ✓             ✓
Supplier           Suppliers              ✓             ✓
Inventory          Inventory              ✓             —
Payment            Payments               —             —
Shift              Shifts                 ✓             ✓
CashMovement       Cash Movements         ✓             ✓
Promotion          Promotions             ✓             —
StoreCredit        Store Credit           ✓             —
OverrideToken      Override Tokens        ✓             —
Report             Reports                —             —
Settings           Settings               —             —
User               Users                  —             ✓
Role               Roles                  —             —
Subscription       Subscription           —             —
Device             Devices                —             —
Store              Stores                 ✓             ✓
Invitation         Invitations            —             —
OwnershipTransfer  Ownership Transfers    —             —
UserRoleMapping    Role Assignments       —             —
ShiftAssignment    Shift Assignments      ✓             —
PersonalExpense    Personal Expenses      ✓             ✓
PersonalBudget     Personal Budgets       ✓             —
Attachment         Attachments            —             —
Note               Notes                  —             —
Address            Addresses              —             —
TaxRate            Tax Rates              ✓             —
```

**`isOfflineSafe = true`** → entity is included in the mobile permission snapshot's
`offline_allowed_entities` list if the user has at least `view` permission on it.

**`supportsAttachments = true`** → the entity allows file/image attachments; the
`Attachment` entity controls access to those files.

**Integrity validation** — `validateMatrixIntegrity()` runs once at module load. It throws
(server fails to start) if:
- `STORE_OWNER_CRUD` references an entity not in `ENTITIES`
- `STORE_OWNER_CRUD` is missing any entity from `ENTITIES`
- Any special action code is not `SCREAMING_SNAKE_CASE`
- `STORE_OWNER_SPECIAL` references an entity or action not declared in `SPECIAL_ACTIONS`

---

## 6. CRUD permission matrix

### Action types

```
view    → GET/read; never blocked by subscription
create  → POST; blocked when subscription lapses
edit    → PUT/PATCH; blocked when subscription lapses
delete  → DELETE; critical operation (30s cache TTL); blocked when subscription lapses
```

### STORE_OWNER matrix

| Entity | view | create | edit | delete | Notes |
|---|---|---|---|---|---|
| Product | ✓ | ✓ | ✓ | ✓ | |
| Order | ✓ | ✓ | ✓ | ✓ | |
| Customer | ✓ | ✓ | ✓ | ✓ | |
| Supplier | ✓ | ✓ | ✓ | ✓ | |
| Inventory | ✓ | ✓ | ✓ | ✓ | |
| Payment | ✓ | ✓ | ✓ | ✓ | |
| Shift | ✓ | ✓ | ✓ | ✓ | |
| CashMovement | ✓ | ✓ | ✓ | — | Irreversible financial movements |
| Promotion | ✓ | ✓ | ✓ | ✓ | |
| StoreCredit | ✓ | ✓ | ✓ | — | Audit trail preserved |
| OverrideToken | ✓ | ✓ | ✓ | ✓ | |
| Report | ✓ | — | — | — | View + EXPORT special action only |
| Settings | ✓ | — | ✓ | — | Edit existing settings only |
| User | ✓ | ✓ | — | — | Remove = UserRoleMapping.delete, not User.delete |
| Role | ✓ | ✓ | ✓ | ✓ | System roles (isEditable=false) blocked at validator |
| Subscription | ✓ | — | ✓ | — | Cancel via CANCEL special action |
| Device | ✓ | — | ✓ | ✓ | |
| Store | ✓ | — | ✓ | ✓ | create=false; new stores through store-creation flow |
| Invitation | ✓ | ✓ | ✓ | ✓ | |
| OwnershipTransfer | ✓ | ✓ | ✓ | — | Audit trail preserved |
| UserRoleMapping | ✓ | ✓ | ✓ | ✓ | Assign/revoke roles in this store |
| ShiftAssignment | ✓ | ✓ | ✓ | ✓ | |
| PersonalExpense | ✓ | ✓ | ✓ | ✓ | |
| PersonalBudget | ✓ | ✓ | ✓ | ✓ | |
| Attachment | ✓ | ✓ | ✓ | ✓ | |
| Note | ✓ | ✓ | ✓ | ✓ | |
| Address | ✓ | ✓ | ✓ | ✓ | |
| TaxRate | ✓ | ✓ | ✓ | ✓ | |

---

## 7. Special action codes

Special actions are **beyond CRUD** capabilities that require explicit grant. All codes are
`SCREAMING_SNAKE_CASE`; casing is validated at module load.

| Entity | Action code | Meaning |
|---|---|---|
| Order | `REFUND` | Issue a standard refund |
| Order | `VOID` | Void an order entirely |
| Order | `DISCOUNT_APPLY` | Apply a manual discount to an order |
| Order | `REFUND_HIGH_VALUE` | Refund above a threshold (critical, 30s TTL) |
| Order | `VIEW_HISTORY` | View full order edit/change history |
| Order | `PRICE_OVERRIDE` | Override a product's unit price at checkout |
| Inventory | `TRANSFER` | Transfer stock between locations |
| Inventory | `AUDIT` | Run a full stock count/audit |
| Inventory | `RESERVE` | Reserve inventory for a future order |
| Report | `EXPORT` | Export report data (CSV / PDF) |
| Report | `TAX_REPORT` | Generate GST tax reports |
| Customer | `EXPORT` | Export customer list |
| Customer | `VIEW_ALL` | View all customers (not just own interactions) |
| Shift | `REOPEN` | Reopen a closed shift |
| Shift | `CLOSE_OTHER` | Force-close another user's open shift |
| CashMovement | `LARGE_AMOUNT` | Record a cash movement above the threshold |
| Subscription | `PAY` | Process a subscription payment |
| Subscription | `UPGRADE` | Upgrade to a higher plan |
| Subscription | `DOWNGRADE` | Downgrade to a lower plan |
| Subscription | `CANCEL` | Cancel the subscription |
| Subscription | `ADD_DEVICE_SLOT` | Add an extra device slot |
| Device | `REMOTE_WIPE` | Trigger remote data wipe on a device (critical, 30s TTL) |
| StoreCredit | `ISSUE` | Issue store credit to a customer |
| Store | `TRANSFER_OWNERSHIP` | Transfer store ownership (critical, 30s TTL) |

### Critical operations (30-second cache TTL)

These special actions AND the `delete` CRUD action use a **30-second Redis TTL** instead of
the default 5 minutes:

```
REFUND · VOID · REFUND_HIGH_VALUE · TRANSFER_OWNERSHIP · LARGE_AMOUNT · PAY · REMOTE_WIPE · ISSUE
+ any entity.delete action
```

Rationale: a revoked user could act for up to 20 minutes with a stale cache
(5m TTL + 15m JWT validity). The short TTL for destructive/financial operations reduces that
window to 30 seconds without penalising every routine read with a DB round-trip.

---

## 8. SUPER_ADMIN matrix

`SUPER_ADMIN_CRUD` is **auto-derived** from `ENTITIES` — every entity gets `FULL` (view +
create + edit + delete) unless explicitly placed in `SUPER_ADMIN_EXCLUDED`. The set is
intentionally empty today; add an entity there only with a specific compliance reason.

`SUPER_ADMIN_SPECIAL` is the **union of all** `SPECIAL_ACTIONS` declarations — any new
special action automatically becomes available to super-admins.

`SUPER_ADMIN` is verified in routes by `SuperAdminGuard`, not `PermissionsGuard`. It checks:
```
user_role_mapping.role.code = 'SUPER_ADMIN' AND user_role_mapping.store_fk IS NULL
```

Super-admin routes live under `/admin/*` and are fully isolated from store-scoped routes.

---

## 9. Default custom-role permissions

When a store owner creates a **new custom role**, these CRUD defaults are seeded:

| Entity | view | create | edit | delete | Rationale |
|---|---|---|---|---|---|
| Product | ✓ | — | — | — | Cashiers need to find products |
| Order | ✓ | ✓ | ✓ | — | Core POS workflow |
| Customer | ✓ | — | — | — | View only; edits need explicit grant |
| Supplier | ✓ | — | — | — | View only |
| Inventory | ✓ | — | — | — | View stock levels |
| Payment | ✓ | — | — | — | View only |
| Shift | ✓ | ✓ | — | — | Open/work a shift |
| CashMovement | ✓ | — | — | — | View only |
| Promotion | ✓ | — | — | — | View promotions at checkout |
| StoreCredit | ✓ | — | — | — | View customer credit |
| TaxRate | ✓ | — | — | — | View tax rates at checkout |
| PersonalExpense | ✓ | ✓ | ✓ | — | Personal workspace |
| PersonalBudget | ✓ | ✓ | ✓ | — | Personal workspace |
| Attachment | ✓ | ✓ | — | — | Upload receipts, not delete |
| Note | ✓ | ✓ | ✓ | — | Edit own notes |
| Address | ✓ | ✓ | ✓ | — | Customer address management |

**Intentionally absent** (must be explicitly granted by owner):
`Report, Settings, Role, User, Subscription, Device, Store, Invitation, OwnershipTransfer,
UserRoleMapping, OverrideToken`

---

## 10. Guards — detailed

### 10A. MobileJwtGuard — ✅ Built

**File:** `apps/backend/src/auth/mobile/guards/mobile-jwt.guard.ts`

**Purpose:** Extracts and validates the `Authorization: Bearer <jwt>` token, hydrates
`request.auth` for downstream guards.

**Steps:**
1. Check `@Public()` → skip if present.
2. Extract `Authorization: Bearer <token>` header. If missing → return `true` (no-op; let
   `JwtAuthGuard` handle the absence if the route requires auth).
3. `CryptoService.verifyJwt(token)` → `MobileJwtPayload` or throw:
   - `JWTExpired` → `401 TOKEN_EXPIRED`
   - Any other JOSE error → `401 MISSING_TOKEN`
4. **JTI blacklist check** — two-level cache:
   - **Level 1:** In-process LRU map (`max: 5000 entries`). Hit → return cached result.
     - Blacklisted positive: TTL = 1 hour (matches JWT access token lifetime).
     - Not blacklisted negative: TTL = 30 seconds.
   - **Level 2 (miss):** `BlacklistCacheService.has(jti)` → Redis → DB fallback.
   - If blacklisted → `401 TOKEN_REVOKED`.
5. `AuthSessionRepository.findActiveSession(sessionId)` → fetch `{session, device, user}`.
   - Not found or expired → `401 SESSION_INVALID`.
6. `device.isBlocked` → `401 DEVICE_BLOCKED`.
7. **User revocation cache** (5s TTL):
   - `UserRevocationCacheService.isUserRevoked(userId)` — avoids per-request DB hit.
   - Deleted → `401 USER_DELETED`.
8. `user.status === 'suspended'` → `403 USER_SUSPENDED`.
9. `user.status !== 'active'` → `401 USER_INACTIVE`.
10. Set `request.auth = { user, device, session, jwt }`.
11. **Replay protection** — `@ReplayWindow` decorator may override the default window.
    - Extract `x-nonce` and `x-timestamp` headers; missing → `401 REPLAY_PROTECTION_REQUIRED`.
    - `ReplayProtectionService.validateAndConsume(deviceId, nonce, timestamp, maxDriftMs)`.
12. Fire-and-forget: `sessionRepo.touchLastUsed(sessionId)` (updates `last_used_at` for UX).

---

### 10B. TenantGuard (🟡 shipped as `StoreGuard`)

**Target file:** `apps/backend/src/auth/mobile/guards/tenant.guard.ts` (📋 not built)
**Current file:** `apps/backend/src/auth/mobile/guards/store.guard.ts` (✅ built, simplified)

**Purpose:** Resolves a store identifier from the request and verifies the authenticated user
has access to it, then attaches the resolved store context for downstream guards.

> **Current implementation (`StoreGuard`).** A simplified version ships today. It differs from
> the full `TenantGuard` spec below:
>
> | Behaviour | `StoreGuard` (✅ actual) | `TenantGuard` (📋 target) |
> |---|---|---|
> | Store ID source | Hardcodes `req.params['storeId']` | `@StoreContext(source)` decorator metadata (param/query/body/header) |
> | ID format | Passes the raw `storeId` string straight to the query | Parses numeric vs UUID path explicitly |
> | Access list | Direct `accountUsers` join per request (no cache) | `rbac.userStoreIds()` — Redis-cached, 5m TTL |
> | Missing/denied store | `404 STORE_NOT_FOUND` / `403 STORE_ACCESS_DENIED` (distinct) | `404 STORE_NOT_ACCESSIBLE` for both (timing-oracle safe) |
> | Context written | `req.storeContext: StoreContext = { storeId, accountId, isLocked }` | `request.context: ResolvedStoreContext = { storeId, storeGuuid }` |
>
> The membership check is authorization-correct today; the timing-oracle hardening and Redis
> caching are the deltas to close when `TenantGuard` is built. See §26 for priority.

**Current `StoreGuard` steps (✅):**
1. Read `req.user` (`MobilePrincipal`, set by `MobileJwtGuard`). Missing → `403 UNAUTHENTICATED`.
2. Read `req.params['storeId']`. Missing → `403 MISSING_STORE_ID`.
3. Load the store: `SELECT * FROM stores WHERE id = :storeId AND deleted_at IS NULL`.
   Not found → `404 STORE_NOT_FOUND`.
4. Verify membership: `SELECT 1 FROM account_users WHERE account_fk = store.account_fk AND user_fk = principal.userId`.
   No row → `403 STORE_ACCESS_DENIED`.
5. Set `req.storeContext = { storeId: store.id, accountId: store.accountFk, isLocked: store.locked ?? false }`.

**Target `TenantGuard` steps (📋):**
1. Check `@Public()` → skip.
2. Read `request.auth?.user ?? request.webAuth?.user` → `401 MISSING_AUTH` if neither.
3. Read `@StoreContext(source)` metadata. `source` is a dot-separated `scope.key`:
   ```
   'param.storeId'          → request.params.storeId
   'query.store_id'         → request.query.store_id
   'body.store_id'          → request.body.store_id
   'header.x-store-id'      → request.headers['x-store-id']
   'none'                   → tenant resolution skipped
   ```
   If `@StoreContext` is absent or `'none'` → guard passes without resolving storeId.
4. Extract raw value from the chosen location. Empty/missing → `400 STORE_CONTEXT_MISSING`.
5. **`resolveAndAuthorize(raw, userId)`:**
   a. `rbac.userStoreIds(userId)` — cached list of numeric IDs user can access (Redis, 5m TTL).
   b. Parse `raw`:
      - All digits → numeric ID path; must be `Number.isSafeInteger` and > 0.
      - UUID format → UUID path (regex: `v1–v7`).
      - Other → treat as not accessible (return `null`).
   c. DB query with `AND store.id IN accessibleStoreIds AND store.deleted_at IS NULL`.
   d. Returns `{ id: number, guuid: string }` or `null`.
6. If `null` → `404 STORE_NOT_ACCESSIBLE` (same error for non-existent and inaccessible —
   timing oracle protection).
7. Set `request.context = { storeId: resolved.id, storeGuuid: resolved.guuid }`.

---

### 10C. PermissionsGuard — 📋 Target (not built)

**Target file:** `apps/backend/src/common/guards/permissions.guard.ts`

**Purpose:** Enforces CRUD and special-action permissions. The core RBAC gate. **Depends on**
the `user_role_mapping`, `role_special_permission`, and `entity_type` tables (§3), none of
which exist yet — so this guard cannot be built until that migration lands.

**Steps:**
1. Check `@Public()` → skip.
2. Determine `authKey` (`'auth'` or `'webAuth'`). Neither → `401 MISSING_AUTH`.
3. Check `@OnlineOnly()` metadata. If the request is an offline replay → `403 ONLINE_REQUIRED`.
   The client sets an `X-Client-Mode` header with one of these states:
   - **`online`** — normal online request. The header may be **absent**; absent is treated as `online`.
   - **`offline_replay`** — set **only** when replaying queued offline mutations via
     `POST /sync/delta`. `@OnlineOnly()` routes reject this value.
   - (There is no `offline_write` wire state — mutations queued offline are indistinguishable
     on the wire until they replay, at which point they carry `offline_replay`.)
   `@OnlineOnly()` routes must never be called offline; the client-side `@OnlineOnly()`
   decorator (see [subscription.md](./subscription.md) §37 item 40) blocks the UI action while
   the device is offline, so a well-behaved client never reaches this guard with `offline_replay`.
4. Read `@RequirePermissions({ entity, action })` metadata. None → pass through
   (no RBAC enforcement on routes without the decorator).
5. **`readResolvedStoreId(request)`** — reads the resolved store id from context
   (`req.storeContext.storeId` today; `request.context.storeId` under the target `TenantGuard`).
   - Missing (TenantGuard not run or misconfigured) → log `[SECURITY]` at ERROR level,
     throw `403 STORE_CONTEXT_MISSING` (not 500, to prevent cross-store escalation).
6. **Permissions version check (H-6):**
   - Mobile only: compare `request.auth.jwt.pv` (version at JWT issue) with
     `user.permissionsVersion` (current).
   - Mismatch → `rbac.invalidateUserStoreCache(userId, storeId)` before the lookup.
7. **Determine `isCritical`:**
   ```
   isCritical = permission.action === 'delete'
             || specialAction in [REFUND, VOID, REFUND_HIGH_VALUE,
                                  TRANSFER_OWNERSHIP, LARGE_AMOUNT, PAY,
                                  REMOTE_WIPE, ISSUE]
   ```
8. `rbac.getCachedPermissions(userId, storeId, isCritical)`:
   - TTL = 30s if `isCritical`, 300s otherwise.
   - Cache hit → deserialize (on corrupt entry: log + delete key + re-query DB).
   - Cache miss → fetch from DB, serialize, cache.
9. `rbac.checkCrud(permissions, entity, action)`:
   - `false` → audit log (SOC2 CC6.3) → `403 PERMISSION_DENIED`.
10. If `@RequireSpecial({ entity, actionCode })` present:
    `rbac.checkSpecial(permissions, entity, actionCode)`:
    - `false` → audit log → `403 SPECIAL_PERMISSION_DENIED`.
11. Write back to the same auth key:
    ```
    request.auth.permissions = EffectivePermissions
    request.auth.storeId     = String(storeId)
    // or request.webAuth.permissions / .storeId for web
    ```
    Downstream decorators (`@CurrentAuth()`) can read these without re-resolving.

---

### 10D. StepUpAuthGuard — 📋 Target (not built)

**Target file:** `apps/backend/src/common/guards/step-up-auth.guard.ts`

> A step-up **verification flow** already exists (`StepUpService`, `POST /auth/mobile/step-up/*`),
> and `deviceSessions.lastStepUpAt` is populated. What is missing is the **guard** that gates
> arbitrary routes on step-up recency via `@StepUpAuth({ within })`.

**Purpose:** Requires recent MFA re-authentication for sensitive actions.

**Steps:**
1. Read `@StepUpAuth({ within: '5m' })` metadata. None → skip.
2. Read `session.lastStepUpAt` from the auth context.
3. If `lastStepUpAt` is `null` or older than `within` → `403 STEP_UP_AUTH_REQUIRED`.

---

### 10E. SubscriptionStatusGuard — 🟡 Partial

**File:** `apps/backend/src/auth/mobile/guards/subscription-status.guard.ts`

> **Current implementation.** The guard does a single **inline** Drizzle query against
> `accountSubscriptions` (keyed on `storeContext.accountId`) — no Redis cache, no
> `X-Subscription-Warning` header, no entitlement/feature checks, no versioned cache key. The
> full status/entitlement/feature design here is the target. See §26.5 / §26.6 for the delta.

**Purpose:** Blocks writes when the account's subscription has lapsed. Never blocks reads.

**Steps:**
1. Check `@SkipSubscriptionCheck()` → skip.
2. `GET` / `HEAD` / `OPTIONS` → pass through (reads never blocked).
3. Resolve `account_subscription` via `store.account_fk → account_subscription`.
4. If subscription status blocks writes → `402 SUBSCRIPTION_PAYMENT_REQUIRED`.
5. If plan limit hit (feature/entitlement) → `403 SUBSCRIPTION_FEATURE_LIMIT_REACHED`
   with `{ error: { details: { feature: '<key>' } } }`.

See [subscription.md §7](./subscription.md#7-enforcement--reads-vs-writes) for full write-gate rules.

---

### 10F. SuperAdminGuard — 📋 Target (not built)

**Target file:** `apps/backend/src/admin/guards/super-admin.guard.ts`

> Depends on `user_role_mapping` (§3), which does not exist yet. The `/admin/*` route surface
> is also not built.

**Purpose:** Protects `/admin/*` routes. Verifies the user has the `SUPER_ADMIN` system role.

**Check:**
```sql
EXISTS (
  SELECT 1 FROM user_role_mapping
  INNER JOIN role ON user_role_mapping.role_fk = role.id
  WHERE user_role_mapping.user_fk = :userId
    AND role.code = 'SUPER_ADMIN'
    AND role.store_fk IS NULL   -- must be system-wide, not store-scoped
    AND user_role_mapping.revoked_at IS NULL
)
```

Throws `403 PERMISSION_DENIED` if not met.

---

### 10G. SyncRateLimitGuard — 📋 Target (not built)

**Target file:** `apps/backend/src/modules/sync/guards/sync-rate-limit.guard.ts`

> **Status.** The entire sync module and all three endpoints (`/sync/initial`, `/sync/changes`,
> `/sync/delta`) are 📋 not implemented. This guard, its Redis Lua script, and the rate-limit
> table below are the target design — none of it ships today.

**Purpose:** Per-user-per-store sliding-window rate limit on sync endpoints.

| Endpoint | Limit |
|---|---|
| `POST /sync/initial` | Exempt (cold-start legitimately fetches 21+ entity types) |
| `POST /sync/changes` | 60 req/min |
| `POST /sync/delta` | 20 req/min |

**Redis Lua script (atomic):**
```lua
local key = KEYS[1]                     -- sync_rate_limit:{userId}:{storeId}:{endpoint}
local limit = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
  redis.call('EXPIRE', key, ttl_seconds)
end

local remaining_ttl = redis.call('TTL', key)
return {current, remaining_ttl}
```

Throws `429 RATE_LIMIT_EXCEEDED` when `current > limit`.

---

## 11. Decorators catalogue

| Decorator | File | Usage | Effect |
|---|---|---|---|
| `@Public()` | `decorators/public.decorator.ts` | `@Public()` on handler/class | All guards skip this route |
| `@StoreContext(source)` | `decorators/store-context.decorator.ts` | `@StoreContext('param.storeId')` | Tells TenantGuard where to read the store ID from |
| `@RequirePermissions({ entity, action })` | `decorators/permissions.decorator.ts` | `@RequirePermissions({ entity: 'Order', action: 'create' })` | PermissionsGuard enforces CRUD check |
| `@RequireSpecial({ entity, actionCode })` | `decorators/require-special.decorator.ts` | `@RequireSpecial({ entity: 'Order', actionCode: 'REFUND' })` | PermissionsGuard enforces special action check (stacks with `@RequirePermissions`) |
| `@OnlineOnly()` | `decorators/online-only.decorator.ts` | `@OnlineOnly()` | Rejects requests with `X-Client-Mode: offline_replay` |
| `@StepUpAuth({ within })` | `decorators/step-up-auth.decorator.ts` | `@StepUpAuth({ within: '5m' })` | StepUpAuthGuard requires MFA within the window |
| `@ReplayWindow({ seconds })` | `decorators/replay-window.decorator.ts` | `@ReplayWindow({ seconds: 30 })` | Override replay protection drift window for this route |
| `@SkipSubscriptionCheck()` | `decorators/skip-subscription-check.decorator.ts` | On routes that must work regardless of subscription | Bypasses SubscriptionStatusGuard |
| `@RequiresFeature(key)` | `decorators/requires-feature.decorator.ts` | `@RequiresFeature('offline_mode')` | SubscriptionStatusGuard checks plan_features |
| `@CurrentAuth()` | `decorators/current-auth.decorator.ts` | `@CurrentAuth() auth: MobileAuthContext` | Injects `request.auth` into controller param |
| `@CurrentUser()` | `decorators/current-user.decorator.ts` | `@CurrentUser() user: User` | Injects `request.auth?.user ?? request.webAuth?.user` |
| `@CurrentStoreId()` | `decorators/current-store-id.decorator.ts` | `@CurrentStoreId() storeId: number` | Injects `request.context.storeId` |

> **Decorator status.** The entire decorator catalogue above is 📋 **target**. Today, routes
> apply `MobileJwtGuard`, `StoreGuard`, and `SubscriptionStatusGuard` directly via
> `@UseGuards(...)`; there is no `@RequirePermissions` / `@StoreContext` / `@RequireSpecial`
> metadata system yet. `@Public()` and `@CurrentUser()` are the only patterns partially in
> place. Build the decorators alongside `PermissionsGuard`.

**Startup validation** — 📋 **Not built.** `apps/backend/src/common/validators/store-context.validator.ts`
is a target file to be created **alongside `PermissionsGuard` and the decorator system**. It
runs at bootstrap (after routes are registered, before the server starts listening) and throws
a startup error if:
- A route has `@RequirePermissions()` but no `@StoreContext()`.
- A route has `@StepUpAuth()` but no `@StoreContext()`.

This prevents misconfigured routes — which would otherwise fall through with no store scope —
from shipping silently. It cannot exist until the decorators it inspects exist.

---

## 12. Auth context types

### `MobileJwtPayload`
```typescript
interface MobileJwtPayload {
  iss: string;
  sub: string;      // user.id
  aud: 'mobile';
  exp: number;
  iat: number;
  jti: string;      // for JTI blacklist check
  sid: string;      // device_session.id (bigint serialised as string)
  did: string;      // device.id (bigint serialised as string)
  pv:  number;      // user.permissionsVersion at token issue time
}
```

### `MobileAuthContext` (request.auth)
```typescript
interface MobileAuthContext {
  user:         User;
  device:       Device;
  session:      DeviceSession;
  jwt:          MobileJwtPayload;
  storeId?:     string;                // written by PermissionsGuard
  permissions?: EffectivePermissions;  // written by PermissionsGuard
}
```

### `WebAuthContext` (request.webAuth) — 📋 Target (web auth not built)

> **Status.** Web session auth does not exist. The backend serves only the mobile app via
> `Authorization: Bearer`. `WebAuthContext`, `WebSessionGuard`, and `JwtAuthGuard` (the guard
> that would accept either mobile or web auth) are target additions for the future web
> dashboard. Until then, **all** auth flows through `MobileJwtGuard` and populates
> `request.auth` (`MobileAuthContext`) only — `request.webAuth` is never set.

```typescript
interface WebAuthContext {
  user:         User;
  sessionId:    string;
  session?:     { lastStepUpAt?: Date | null };
  permissions?: EffectivePermissions;  // written by PermissionsGuard
  storeId?:     string;                // written by PermissionsGuard (H-2 fix)
}
```

### `EffectivePermissions`
```typescript
interface CrudPermissions {
  view:   boolean;
  create: boolean;
  edit:   boolean;
  delete: boolean;
}

interface EffectivePermissions {
  crud:    Map<string, CrudPermissions>;  // entity code → CRUD flags
  special: Map<string, Set<string>>;      // entity code → set of special action codes
}
```

### `ResolvedStoreContext` (request.context)
```typescript
interface ResolvedStoreContext {
  storeId:    number;
  storeGuuid: string;
}
```

---

## 13. Permission resolution flow — step by step

### Phase 1 — JWT → request.auth (MobileJwtGuard)

```
Bearer token
  │
  ├─ CryptoService.verifyJwt(token)
  │     → MobileJwtPayload { sub, sid, did, pv, jti }
  │
  ├─ JTI blacklist  (LRU in-process → BlacklistCacheService → Redis → DB)
  │
  ├─ AuthSessionRepository.findActiveSession(sid)
  │     → { session, device, user }
  │
  ├─ device.isBlocked? → 401
  ├─ user deleted?     → 401  (UserRevocationCacheService, 5s TTL)
  ├─ user suspended?   → 403
  ├─ user inactive?    → 401
  │
  ├─ request.auth = { user, device, session, jwt }
  │
  └─ ReplayProtectionService.validateAndConsume(deviceId, nonce, timestamp)
```

### Phase 2 — storeId → request.context (TenantGuard)

```
@StoreContext('param.storeId')
  │
  ├─ Extract raw = request.params.storeId
  │
  ├─ rbac.userStoreIds(userId)          ← Redis: user_stores:{userId}, 5m TTL
  │     → [101, 102, 305, ...]          ← DB if miss
  │
  ├─ Parse raw (numeric or UUID)
  │
  ├─ DB: SELECT id, guuid FROM store
  │       WHERE id = :raw              (or guuid = :raw)
  │         AND id IN (:accessibleIds)
  │         AND deleted_at IS NULL
  │
  └─ request.context = { storeId: 101, storeGuuid: 'abc-...' }
     OR → 404 STORE_NOT_ACCESSIBLE (same for missing + inaccessible)
```

### Phase 3 — permissions check (PermissionsGuard)

```
@RequirePermissions({ entity: 'Order', action: 'create' })
@RequireSpecial({ entity: 'Order', actionCode: 'REFUND' })
  │
  ├─ permissionsVersion check (H-6):
  │     jwt.pv ≠ user.permissionsVersion?
  │     → rbac.invalidateUserStoreCache(userId, storeId)
  │
  ├─ isCritical = (action === 'delete') || (actionCode in criticalSet)
  │
  ├─ rbac.getCachedPermissions(userId, storeId, isCritical)
  │   ├─ Redis key: perm:{userId}:{storeId}
  │   │   hit → deserialise → return
  │   │   corrupt → delete key + fall through
  │   └─ miss → DB:
  │       rbac.findActiveRolesForUser(userId, storeId)
  │       rbac.fetchCrudPermissions(roleIds)      ← union across all roles
  │       rbac.fetchSpecialPermissions(roleIds)   ← union across all roles
  │       rbacMapper.toPermissionMatrix()
  │       Redis.set(key, serialised, EX, ttl)     ← 30s or 300s
  │
  ├─ checkCrud(permissions, 'Order', 'create')
  │     false → auditLog(PERMISSION_DENIED) → 403
  │
  ├─ checkSpecial(permissions, 'Order', 'REFUND')
  │     false → auditLog(SPECIAL_PERMISSION_DENIED) → 403
  │
  └─ request.auth.permissions = EffectivePermissions
     request.auth.storeId     = '101'
```

---

## 14. Bootstrap permission snapshot — ✅ Built (signature algorithm differs)

**File:** `apps/backend/src/auth/mobile/services/snapshot.service.ts`

> **Signature algorithm.** The current implementation signs the canonical snapshot JSON with
> **HMAC-SHA256** (`CryptoService.signSnapshot()` → `createHmac('sha256', jwtAccessSecret)`),
> **not** EdDSA/Ed25519. `CryptoService` *does* hold Ed25519 keys, but those are used for
> **device** signatures, not snapshot signing.
>
> **🔴 Gap to close:** migrate snapshot signing from HMAC-SHA256 to **Ed25519** before the
> signed `access_valid_until` tamper-resistance model ([subscription.md](./subscription.md) §23)
> can be implemented. Ed25519 is required there because the device stores only the **public**
> key — no shared HMAC secret can be safely shipped to a device the user controls.

The permission snapshot is **baked into the bootstrap response** (`GET /me/bootstrap`) for
offline-first mobile clients. It lets the app gate UI without a network call.

### Snapshot structure

```typescript
interface PermissionSnapshot {
  version:     number;     // user.permissionsVersion at snapshot build time
  userId:      string;
  issuedAt:    string;     // ISO
  expiresAt:   string;     // ISO — 7 days from issuedAt

  systemRoles: string[];   // e.g. ['SUPER_ADMIN'] for platform admins; [] for regular users

  stores: StorePermissionEntry[];

  personal: {
    permissions:              { PersonalExpense: CrudMatrix, PersonalBudget: CrudMatrix };
    offline_allowed_entities: string[];
  };
}

interface StorePermissionEntry {
  store_id:                  string;   // numeric bigint as string
  store_guuid:               string;
  roles:                     string[]; // role codes this user holds in this store
  is_owner:                  boolean;  // true if any role code is 'STORE_OWNER'

  crud: Record<EntityCode, CrudMatrix>;
  special: Record<EntityCode, string[]>;  // special action codes granted

  offline_allowed_entities:  string[];  // entity codes with isOfflineSafe=true AND view=true
  offline_constraints: {
    max_refund_amount: number | null;
    // ... other numeric constraints
  };
}
```

### How it is built

```
SnapshotService.buildSnapshot(userId)
  │
  ├─ user.permissionsVersion → snapshot.version
  │
  ├─ findAllActiveAssignments(userId)
  │     SELECT mappings WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)
  │
  ├─ Partition assignments:
  │     systemRoles → store_fk IS NULL
  │     storeAssignments → group by store_id
  │
  ├─ For each storeId (batched):
  │     fetchCrudPermissions(roleIds)     ← union of all roles
  │     fetchSpecialPermissions(roleIds)  ← union of all roles
  │     fetch store metadata (name, guuid, locked_at, subscription)
  │     compute offline_allowed_entities (isOfflineSafe AND view=true)
  │
  └─ CryptoService.signSnapshot(snapshot)
       ← HMAC-SHA256 over canonical JSON  (✅ current implementation)
       ← Ed25519                          (📋 target — see subscription.md §23)
       → snapshot + snapshot_signature

Bootstrap response:
{
  user:                 { id, name, email, phone, ... },
  snapshot:             PermissionSnapshot,
  snapshot_signature:   string,
  permissions_version:  number,
  preferences:          { lastOpenedStoreFk, pinnedStoreFk },
  has_pending_invitations: boolean,
  profile_status:       'complete' | 'incomplete',
  active_store_id:      storeGuuid,
  subscription:         { plan, entitlements, features, status, ... }
}
```

The client **re-bootstraps whenever `permissions_version` advances** (detected via
`x-subscription-version` and `x-permissions-version` response headers). This avoids holding
stale permissions across a role change.

---

## 15. Redis cache layer

### Cache keys

| Key pattern | Content | TTL |
|---|---|---|
| `perm:{userId}:{storeId}` | Serialised `EffectivePermissions` | 300s (5m) / 30s (critical) |
| `user_stores:{userId}` | JSON array of accessible store IDs | 300s (5m) |
| `jti:{jti}` | Blacklist flag (via BlacklistCacheService) | Matches JWT access token TTL |
| `sync_rate_limit:{userId}:{storeId}:{endpoint}` | Sliding window counter | Per-endpoint window |
| `user_revoked:{userId}` | Deletion flag | 5s |
| `snapshot:{userId}` | Signed permission snapshot (✅ **current** — no `signed:` prefix, no version suffix) | 120s (2m) |
| `snapshot:signed:{userId}:v{pv}` | Version-pinned snapshot (📋 **target** — see §26.8) | 120s (2m) |

### Invalidation triggers

| Event | Invalidation |
|---|---|
| Role assignment created | `del perm:{userId}:{storeId}` + `del user_stores:{userId}` |
| Role assignment revoked | `del perm:{userId}:{storeId}` + `del user_stores:{userId}` |
| Role CRUD matrix modified | `del perm:{memberId}:{storeId}` for **all** role members |
| Role deleted | `del perm:{memberId}:{storeId}` for all members + `del user_stores:{memberId}` |
| `permissionsVersion` bumped | PermissionsGuard sees `jwt.pv ≠ user.permissionsVersion` → `del perm:{userId}:{storeId}` for **the store being accessed** on that request (see caveat below) |
| Store assignment changed | `del user_stores:{userId}` |

> **Multi-store race caveat.** A `permissionsVersion` mismatch only busts
> `perm:{userId}:{storeId}` for the **specific store the request targets**. If a user has roles
> in 5 stores and their role changes in store 3, only `perm:{userId}:3` is invalidated on the
> next request to store 3. The caches for stores 1, 2, 4, 5 stay warm until their own TTL
> (5m standard / 30s critical) expires. **Mitigation:** on a role change, also proactively
> `DEL perm:{userId}:*` across every store the user belongs to (fan-out on write), or accept
> the bounded staleness window for the non-targeted stores. For critical operations the window
> is already 30s regardless.

### Cache corruption handling

If `JSON.parse` of the cached permissions fails:
1. Log warning with `userId`, `storeId`, truncated error.
2. Fire-and-forget `Redis.del(key)` — don't block the request.
3. Fall through to DB query (same as a cache miss).

---

## 16. Permissions version (H-6 race mitigation)

**Problem:** JWT is issued at login with `pv = user.permissionsVersion`. If an owner revokes
a role after login, the ex-employee's JWT still carries the old `pv`. With a 5-minute cache
TTL and up to 15-minute JWT validity, the stale permissions could persist for up to 20 minutes.

**Mitigation (H-6):**

```
Every PermissionsGuard execution:
  1. Read jwt.pv (mobile) or skip (web — no pv in cookie session)
  2. Read user.permissionsVersion (loaded by MobileJwtGuard via findActiveSession)
  3. If pv ≠ permissionsVersion:
       rbac.invalidateUserStoreCache(userId, storeId)
       → del Redis key perm:{userId}:{storeId}
  4. getCachedPermissions() will miss → re-read from DB

Result: stale cache is busted on the very first request after a role change,
        regardless of the remaining cache TTL.
```

**Remaining race window:** 30 seconds for critical operations (cache TTL), 5 minutes for
standard operations (between when the key is bust on one storeId vs another storeId the user
may be accessing concurrently).

---

## 17. Point-in-time authorisation (offline sync) — 📋 Target

**Target file:** `apps/backend/src/modules/rbac/repositories/rbac.permissions.repository.ts`

> Depends on `user_role_mapping` + `role_permission.revoked_at` (§3) and the sync module (§18),
> none of which exist yet. This is the target contract for offline-mutation authorization.

When the mobile client syncs offline-queued mutations via `POST /sync/delta`, the server
must authorise each mutation **at the time it was created** (not at sync time). A cashier
fired at 3pm whose mutation was queued at 2:55pm should have their sale accepted.

### Query

```typescript
async wasCrudAuthorizedAt(params: {
  userId:   string;
  storeId:  number;
  entity:   string;
  action:   'view' | 'create' | 'edit' | 'delete';
  asOf:     Date;   // client_modified_at from the mutation
}): Promise<boolean>
```

```sql
SELECT 1
FROM   user_role_mapping  urm
INNER  JOIN role           r  ON r.id  = urm.role_fk
INNER  JOIN role_permission rp ON rp.role_fk = r.id
WHERE  urm.user_fk   = :userId
  AND  (urm.store_fk = :storeId OR urm.store_fk IS NULL)
  AND  (urm.revoked_at IS NULL OR urm.revoked_at > :asOf)   -- assignment active at asOf
  AND  (urm.expires_at IS NULL OR urm.expires_at > :asOf)   -- not expired at asOf
  AND  rp.entity_code = :entity
  AND  rp.action      = :action
  AND  rp.granted_at <= :asOf                               -- grant existed at asOf
  AND  (rp.revoked_at IS NULL OR rp.revoked_at > :asOf)     -- not revoked at asOf
LIMIT  1
```

Result: `true` = mutation was authorised when it was queued → accept. `false` = reject
with `MUTATION_NOT_AUTHORIZED_AT_TIME`.

---

## 18. Sync rate limiting — 📋 Target

**Target file:** `apps/backend/src/modules/sync/guards/sync-rate-limit.guard.ts`

> **Status.** The sync module and all three endpoints are not built (see §10G). Everything in
> this section is target design.

Prevents a single device from flooding the sync endpoints.

| Endpoint | Limit | Window |
|---|---|---|
| `POST /sync/initial` | Exempt | — |
| `POST /sync/changes` | 60 requests | 60 seconds |
| `POST /sync/delta` | 20 requests | 60 seconds |

Redis key: `sync_rate_limit:{userId}:{storeId}:{endpoint}`

The Lua script is **atomic** — `INCR` + `EXPIRE` in a single round-trip. `EXPIRE` is only
called when `current == 1` to avoid resetting the window on every request.

---

## 19. Security defence-in-depth

### Timing oracle protection (TenantGuard)

Accessing a store you don't own and accessing a non-existent store both return `404 STORE_NOT_ACCESSIBLE`. Response time is identical because both paths hit the same DB query (access check + existence check in one query).

### Missing storeId defence (PermissionsGuard)

If `TenantGuard` somehow didn't run (misconfigured guard chain), `PermissionsGuard` detects
`request.context === undefined` and throws `403 STORE_CONTEXT_MISSING` (not `500`).
This prevents cross-store data escalation even if the guard chain is broken by a future
refactor. The server also logs at `ERROR` level server-side.

### System role DB constraint

```sql
CONSTRAINT system_role_no_store CHECK (
  store_fk IS NULL OR code NOT IN ('SUPER_ADMIN', 'USER', 'STORE_OWNER')
)
```

Prevents a store-scoped role from impersonating a system role even via direct DB write.

### JTI in-process LRU cache (MobileJwtGuard)

Each `MobileJwtGuard` instance keeps up to 5,000 JTI entries in an in-process LRU map.
- **Positive** (blacklisted): TTL = 1 hour (matches access token lifetime) — never unnecessarily
  expires a revocation.
- **Negative** (valid): TTL = 30 seconds — a revoked token is blocked within 30 seconds
  even if the Redis round-trip is skipped.

### User revocation 5s cache

`UserRevocationCacheService` caches the "is this user deleted?" result for 5 seconds.
Tradeoff: a deleted user can still make requests for up to 5 seconds. Acceptable vs a DB
hit on every authenticated request.

### Critical operation 30s TTL

Financial and destructive operations (`REFUND`, `VOID`, `delete`, `TRANSFER_OWNERSHIP`, etc.)
use a 30-second cache TTL so a revoked role takes effect within 30 seconds for those actions.

### Replay protection (MobileJwtGuard)

Every mobile request must carry `x-nonce` and `x-timestamp` headers.
`ReplayProtectionService` stores the nonce in Redis with a TTL matching the allowed clock
drift window (configurable per-route via `@ReplayWindow`). A replayed request reuses the
same nonce → rejected.

---

## 20. Audit & compliance (SOC2 CC6.3)

**File:** `apps/backend/src/auth/core/audit.service.ts`

Every permission denial must be written to the audit log **before** throwing the
`ForbiddenException`, so denials are never silently undercounted in compliance reports.

> **Actual implementation.** The table is **`auditLogs`** (Drizzle camelCase mapping) — **not**
> `auth_audit_log`. The write methods are:
> - `AuditService.log(entry)` — `async`, `await this.db.insert(auditLogs)…` (standalone).
> - `AuditService.logInTransaction(entry, tx)` — `async`, `await tx.insert(auditLogs)…` (inside a UoW).
>
> Both are `async`/`await` today, so a DB failure **does** reject and propagate to the caller —
> the synchronous, fail-closed guarantee SOC2 CC6.3 requires. (There is no `logCritical()`
> method; that name in earlier drafts was aspirational.) The remaining gap is that the
> **`PermissionsGuard` caller** which would invoke `logInTransaction()` on a denial does not
> exist yet, because the guard itself is 📋 target (§10C). Wire the denial-audit call when the
> guard is built.

### Audit log entry (PERMISSION_DENIED)

```typescript
{
  action:    'PERMISSION_DENIED',
  userFk:    userId,
  storeFk:   storeId,
  isSuccess: false,
  meta: {
    entity:    'Order',
    action:    'delete',          // or special action code
    errorCode: 'PERMISSION_DENIED',   // thrown code (uppercase); JSON body renders 'permission_denied' — see §22
    route:     'DELETE /stores/101/orders/abc',
  }
}
```

### All audited actions

| Action code | Trigger |
|---|---|
| `PERMISSION_DENIED` | PermissionsGuard rejects CRUD check |
| `SPECIAL_PERMISSION_DENIED` | PermissionsGuard rejects special action check |
| `ROLE_PERMISSION_CHANGED` | CRUD or special permission added/revoked on a role |
| `ROLE_ASSIGNMENT_CREATED` | User assigned to a role |
| `ROLE_ASSIGNMENT_REVOKED` | User removed from a role |
| `PROFILE_UPDATED` | User profile mutation |
| `ACCOUNT_MODE_CHANGED` | Business/personal mode switch |

---

## 21. Role lifecycle — 📋 Target

> **Status.** The role-management surface is not built. There is no `RbacService`, no roles
> controller, and no role endpoints. The service methods referenced below —
> `seedDefaultPermissions()`, `bumpPermissionsVersionForRole()`, `invalidateRoleMembersCache()`,
> `invalidateUserStoreCache()` — are the **target implementation contract** for the roles module,
> and they depend on the `user_role_mapping` / `role_special_permission` tables (§3). The `roles`
> and `rolePermissions` tables exist, but nothing writes to them through a lifecycle service yet.

### Creating a custom role

```
POST /stores/:storeId/roles
  @StoreContext('param.storeId')
  @RequirePermissions({ entity: 'Role', action: 'create' })

Service:
  1. Validate name not already taken in this store (409 ROLE_ALREADY_EXISTS)
  2. INSERT INTO role { store_fk, code, name, is_editable: true }
  3. RbacService.seedDefaultPermissions(roleId, userId, storeId)
     → INSERT DEFAULT_ROLE_CRUD rows into role_permission
  4. bumpPermissionsVersionForRole(roleId)
     → No-op (no members yet)
  5. Return new role
```

### Assigning a role

```
POST /stores/:storeId/roles/:roleId/assign
  @StoreContext('param.storeId')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'create' })

Service:
  1. Validate roleId exists and belongs to this store (or is a system role)
  2. Validate role.code not in SYSTEM_ROLES (403 ROLE_NOT_ASSIGNABLE)
  3. Validate assignment doesn't already exist (409 ASSIGNMENT_ALREADY_EXISTS)
  4. INSERT INTO user_role_mapping { user_fk, role_fk, store_fk, assigned_by }
  5. INCREMENT user.permissionsVersion
  6. invalidateRoleMembersCache(roleId, storeId)
     → del Redis perm:{userId}:{storeId} for all role members
     → del Redis user_stores:{userId} for all role members
  7. Audit log ROLE_ASSIGNMENT_CREATED
```

### Revoking a role

```
DELETE /stores/:storeId/roles/:roleId/members/:userId
  @StoreContext('param.storeId')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'delete' })

Service:
  1. Soft-delete: UPDATE user_role_mapping SET revoked_at = now()
  2. INCREMENT user.permissionsVersion
  3. invalidateUserStoreCache(userId, storeId)
  4. Audit log ROLE_ASSIGNMENT_REVOKED
```

### Deleting a custom role

```
DELETE /stores/:storeId/roles/:roleId
  @RequirePermissions({ entity: 'Role', action: 'delete' })

Service:
  1. Validate role.isEditable = true (403 ROLE_NOT_EDITABLE for system roles)
  2. Check no active assignments (409 ROLE_HAS_ACTIVE_ASSIGNMENTS)
  3. Soft-delete: UPDATE role SET deleted_at = now()
  4. Soft-delete all role_permission rows for this role
  5. Audit log
```

### Modifying role permissions

```
PATCH /stores/:storeId/roles/:roleId/permissions
  @RequirePermissions({ entity: 'Role', action: 'edit' })

Service:
  1. Validate role.isEditable = true
  2. Upsert role_permission rows (granted_at = now, revoked_at = null)
     OR set revoked_at = now() for removed permissions
  3. bumpPermissionsVersionForRole(roleId)
     → UPDATE user SET permissions_version = permissions_version + 1
       WHERE id IN (all active members of roleId)
  4. invalidateRoleMembersCache(roleId, storeId)
  5. Audit log ROLE_PERMISSION_CHANGED
```

---

## 22. Error codes

> **Casing rule (canonical).** Guards **throw** error codes as `SCREAMING_SNAKE_CASE` strings
> inside `ForbiddenException` / `NotFoundException` (verified in source: `StoreGuard` throws
> `'STORE_NOT_FOUND'`, `'STORE_ACCESS_DENIED'`; `SubscriptionStatusGuard` throws
> `'STORE_CONTEXT_MISSING'`). The **JSON error body** rendered by the global exception filter
> uses the `snake_case` (lowercase) form of the same code. So:
> `throw new ForbiddenException('PERMISSION_DENIED')` → `{ error: { code: 'permission_denied' } }`.
> The lowercase codes in the tables below are the **response-body keys**; the uppercase forms
> are what the guard throws. Implement the filter transform (uppercase → lowercase) accordingly.

### RBAC errors

| Code | HTTP | When |
|---|---|---|
| `permission_denied` | 403 | CRUD permission check failed |
| `special_permission_denied` | 403 | Special action check failed |
| `store_context_missing` | 400 / 403 | Store ID missing from request (400 from TenantGuard, 403 from PermissionsGuard) |
| `store_not_accessible` | 404 | Store doesn't exist or user has no access |
| `tenant_scope_violation` | 403 | Multi-tenancy boundary violation |
| `online_required` | 403 | Endpoint requires online mode |
| `step_up_auth_required` | 403 | MFA re-auth required |
| `role_not_found` | 404 | Role doesn't exist |
| `role_not_editable` | 403 | System role cannot be modified |
| `role_already_exists` | 409 | Role name taken in this store |
| `role_not_assignable` | 403 | System role cannot be manually assigned |
| `role_has_active_assignments` | 409 | Cannot delete role with active members |
| `assignment_not_found` | 404 | Role assignment doesn't exist |
| `assignment_already_exists` | 409 | User already has this role in this store |
| `user_not_store_member` | 403 | User is not a member of the store |
| `entity_type_not_found` | 404 | Entity code not in the registry |

### Auth errors

| Code | HTTP | When |
|---|---|---|
| `missing_auth` | 401 | Neither `request.auth` nor `request.webAuth` populated |
| `missing_token` | 401 | `Authorization` header missing or token invalid |
| `token_expired` | 401 | JWT `exp` in the past |
| `token_revoked` | 401 | JTI found in blacklist |
| `session_invalid` | 401 | Session not found or expired |
| `device_blocked` | 401 | `device.is_blocked = true` |
| `user_inactive` | 401 | `user.status ≠ 'active'` |
| `user_suspended` | 403 | `user.status = 'suspended'` (admin action) |
| `user_deleted` | 401 | User account deleted (revocation cache) |
| `replay_protection_required` | 401 | `x-nonce` or `x-timestamp` header missing |

---

## 23. Adding a new entity or special action

### Add a new entity

1. **`permission-matrix.constants.ts`** — add to `ENTITIES`:
   ```typescript
   { code: 'LoyaltyCard', label: 'Loyalty Cards', isOfflineSafe: true, supportsAttachments: false }
   ```
2. **`permission-matrix.constants.ts`** — add to `STORE_OWNER_CRUD`:
   ```typescript
   LoyaltyCard: FULL  // or NO_DELETE / VIEW_EDIT / VIEW_ONLY
   ```
   `validateMatrixIntegrity()` will throw at startup if you forget this.
3. **`SUPER_ADMIN_CRUD`** — auto-derived from `ENTITIES`; no action needed.
4. **Database** — create a migration adding a row to `entity_type`.
5. **Route decorators** — `@RequirePermissions({ entity: 'LoyaltyCard', action: 'create' })`.

### Add a new special action

1. **`permission-matrix.constants.ts`** — add to `SPECIAL_ACTIONS`:
   ```typescript
   LoyaltyCard: ['REDEEM', 'EXPIRE']
   ```
2. **`STORE_OWNER_SPECIAL`** — add if owners should have it:
   ```typescript
   LoyaltyCard: SPECIAL_ACTIONS.LoyaltyCard
   ```
3. **`SUPER_ADMIN_SPECIAL`** — auto-derived; no action needed.
4. **Route decorator** — `@RequireSpecial({ entity: 'LoyaltyCard', actionCode: 'REDEEM' })`.
5. **Critical TTL** — add `'REDEEM'` to the `isCriticalSpecial` list in `PermissionsGuard` if
   it is a financial or destructive operation.

---

## 24. Complete flow examples

### Example A — Cashier creates an order (online)

```
POST /stores/abc-uuid/orders

Guard chain:
  MobileJwtGuard   → request.auth = { user: Priya, device, session, jwt: { pv: 4 } }
  TenantGuard      → store guuid 'abc-uuid' resolves to id=101, in Priya's accessible list
                     request.context = { storeId: 101, storeGuuid: 'abc-uuid' }
  PermissionsGuard → @RequirePermissions({ entity: 'Order', action: 'create' })
                     pv=4 === user.permissionsVersion=4 → no cache bust
                     isCritical = false (create, not delete)
                     getCachedPermissions(Priya.id, 101, false)
                       → Redis hit perm:Priya:101 → EffectivePermissions
                     checkCrud(permissions, 'Order', 'create') → true
                     request.auth.permissions = ...; request.auth.storeId = '101'
  SubscriptionGuard → account active → pass

Controller creates order.
```

### Example B — Owner issues a refund (special action)

```
POST /stores/101/orders/xyz/refund

@RequirePermissions({ entity: 'Order', action: 'edit' })
@RequireSpecial({ entity: 'Order', actionCode: 'REFUND' })

PermissionsGuard:
  isCriticalSpecial = 'REFUND' in criticalSet → true
  getCachedPermissions(userId, 101, isCritical=true)
    → TTL = 30s → may miss even if recently cached
    → DB fetch: owner has Order.edit=true AND Order.REFUND=true
  checkCrud  → true
  checkSpecial → true
  → pass

Audit log: nothing (success). Audit only logs denials.
```

### Example C — Revoking a role, ex-employee's next request

```
Step 1: Owner revokes Raju's cashier role
  DELETE /stores/101/roles/55/members/Raju.id
    → UPDATE user_role_mapping SET revoked_at = now()
    → INCREMENT Raju.permissionsVersion (3 → 4)
    → DEL perm:Raju:101   (Redis)
    → DEL user_stores:Raju (Redis)

Step 2: Raju (JWT has pv=3) makes a request
  MobileJwtGuard   → request.auth = { user: Raju, jwt: { pv: 3 } }
                     findActiveSession → user.permissionsVersion = 4 (freshly loaded)
  TenantGuard      → Raju no longer in user_stores:Raju (key deleted)
                     → Redis miss → DB: Raju has no active roles in store 101
                     → userStoreIds returns [] (or doesn't include 101)
                     → 404 STORE_NOT_ACCESSIBLE

Raju is immediately locked out — not after 5 minutes.
```

> **Why "immediately" holds — and the mechanism differs by implementation.**
> - **Current (`StoreGuard`, ✅):** every request re-checks membership with a **direct DB query**
>   to `account_users` — there is no Redis `user_stores:{userId}` cache. Raju is locked out
>   immediately because that query sees the revoked row on the very next request. The
>   `DEL user_stores:Raju` step is a no-op today (the key doesn't exist).
> - **Target (`TenantGuard`, 📋):** membership is Redis-cached (`user_stores:{userId}`, 5m TTL).
>   There, the `DEL user_stores:Raju` invalidation shown in Step 1 becomes **load-bearing** —
>   without it, Raju could keep hitting store 101 from the warm cache for up to 5 minutes.
> The "immediately" guarantee is free today and must be *preserved* by the invalidation step
> once caching is introduced.

### Example D — Offline mutation sync (fired employee)

```
Raju (fired at 3pm) queued a cash movement at 2:55pm while offline.
Raju comes online at 3:30pm and syncs.

POST /sync/delta
  mutation: { entity: 'CashMovement', action: 'create', client_modified_at: '14:55:00' }

Server:
  rbac.wasCrudAuthorizedAt({
    userId:  Raju.id,
    storeId: 101,
    entity:  'CashMovement',
    action:  'create',
    asOf:    new Date('14:55:00')   ← mutation was queued at 2:55pm
  })

SQL check:
  urm.revoked_at > asOf?  revokedAt=15:00, asOf=14:55 → YES, assignment active at 2:55pm
  rp.granted_at  <= asOf? granted long ago → YES
  rp.revoked_at  > asOf?  not revoked → YES

→ wasCrudAuthorizedAt = true → mutation ACCEPTED

(A mutation queued at 3:05pm, asOf=15:05:
  urm.revoked_at = 15:00 < asOf=15:05 → assignment NOT active → false → REJECTED)
```

### Example E — New entity added (startup validation)

```
Developer adds 'LoyaltyCard' to ENTITIES but forgets STORE_OWNER_CRUD.

Server startup:
  validateMatrixIntegrity()
    → STORE_OWNER_CRUD is missing entity: LoyaltyCard.
       Add an entry (use VIEW_ONLY or NONE-equivalent if owners should not have access).
    → throw Error (server fails to start with clear message)

No silent omission ships to production.
```

---

## 25. Business rules

| ID | Rule |
|---|---|
| BR-RBAC-001 | Every authenticated route must have either `@Public()` (to skip all guards) or `@StoreContext()` + `@RequirePermissions()`. Startup validator throws if a route has `@RequirePermissions()` without `@StoreContext()`. |
| BR-RBAC-002 | Permissions are **store-scoped** — a user's permissions in Store A are independent of Store B. `EffectivePermissions` is always resolved for a specific `(userId, storeId)` pair. |
| BR-RBAC-003 | **Union of all roles.** If a user holds multiple roles in a store, their effective permissions are the union (logical OR) of all roles. One role with `delete` is enough. |
| BR-RBAC-004 | **Reads are never subscription-blocked.** `GET` / `HEAD` / `OPTIONS` pass `SubscriptionStatusGuard` unconditionally. |
| BR-RBAC-005 | **System roles are immutable.** `USER`, `STORE_OWNER`, and `SUPER_ADMIN` have `is_editable=false`. The DB `CHECK` constraint prevents store-scoped roles from masquerading as system roles. |
| BR-RBAC-006 | **Invitations assign custom roles only.** System roles cannot be assigned via the invitation endpoint; rejected with `403 ROLE_NOT_ASSIGNABLE`. |
| BR-RBAC-007 | **SOC2 CC6.3.** Every permission denial (CRUD and special) is written to **`auditLogs`** synchronously — via the `async`/`await` `AuditService.logInTransaction()` — before the `ForbiddenException` is thrown; a failed audit write rejects and propagates to the caller (fail-closed). The audit method already satisfies this; the outstanding work is wiring the call from `PermissionsGuard` (📋 §10C, §20). |
| BR-RBAC-008 | **permissionsVersion mitigates stale cache.** `user.permissionsVersion` is bumped on every role change. The JWT carries the version at issue; PermissionsGuard busts the cache on mismatch before any permission check. |
| BR-RBAC-009 | **Critical operations use 30s cache TTL.** `delete` CRUD + financial/destructive special actions (`REFUND`, `VOID`, `TRANSFER_OWNERSHIP`, etc.) use a 30-second Redis TTL to bound the revocation race window. |
| BR-RBAC-010 | **Point-in-time authorization for offline mutations.** `wasCrudAuthorizedAt(asOf)` checks whether the user held the permission at the time the mutation was queued — not at sync time. |
| BR-RBAC-011 | **Timing oracle protection.** `TenantGuard` returns the same `404 STORE_NOT_ACCESSIBLE` for non-existent stores and stores the user cannot access. Both paths hit the same DB query. |
| BR-RBAC-012 | **JTI blacklist.** Revoked JWTs are blacklisted by JTI. An in-process LRU (5000 entries) fronts the Redis / DB check. A revoked token is blocked within 30 seconds (negative cache TTL). |
| BR-RBAC-013 | **Replay protection is mandatory.** Every mobile request must carry `x-nonce` + `x-timestamp`. Missing → `401 REPLAY_PROTECTION_REQUIRED`. Per-route `@ReplayWindow` can tighten the drift window. |
| BR-RBAC-014 | **`STORE_OWNER_CRUD` must cover every entity.** `validateMatrixIntegrity()` throws at startup if any entity in `ENTITIES` is missing from `STORE_OWNER_CRUD`. No silent omissions allowed. |
| BR-RBAC-015 | **Special action codes are SCREAMING_SNAKE_CASE.** `validateMatrixIntegrity()` throws at startup if any code fails the regex. No lowercase codes. |
| BR-RBAC-016 | **Web and mobile share the same permission model.** `WebAuthContext` and `MobileAuthContext` both produce `EffectivePermissions`; `PermissionsGuard` is auth-source agnostic. |
| BR-RBAC-017 | **User deletion ≠ role removal.** A user is removed from a store by revoking their `user_role_mapping` row (soft-delete), not by deleting the `user` record. `User.delete = false` for `STORE_OWNER`. |
| BR-RBAC-018 | **Cache corruption is safe.** A corrupt Redis entry is deleted and the request falls through to a DB read — no request is blocked, no permissions are silently denied. |

---

## 26. Architecture gaps & target design

> **Status of this section:** audit-verified against the actual codebase (June 2026).
> Items marked 🔴 are confirmed missing. Items marked ✅ already exist.
> This section describes both the gaps and the complete target design to resolve them.

---

### 26.1 Missing: Location entity layer

**Current state (🔴 GAP)**

`locationId` exists only as a plain `text` column defaulting to `'default'` in a handful of
inventory tables (`stock_take`, `stock_adjustment`, `stock_history`, `fifo_cost_layer`). There
is no `location` table, no FK relationship, and no location concept in routing, guards, or
the permission model. The system is architecturally single-location per store today.

```
Current hierarchy:
  Account (tenant, via user_subscription)
    └── Store
          └── Orders / Inventory / Devices / Shifts   ← all store-scoped only
```

**Target hierarchy**

```
Account (tenant)
  └── Store
        └── Location A    ← actual place where POS runs
              ├── Devices  (pos-01, pos-02)
              ├── Inventory (50 Coke, 10 Biscuit)
              ├── Orders
              ├── Shifts / Registers
              └── Staff assignments (who works HERE)
        └── Location B
        └── Location C (Head Office)
```

**Schema additions required**

```sql
-- New table
location
  id              bigserial PK
  guuid           uuid UNIQUE
  store_fk        bigint → store.id  NOT NULL
  name            text               -- 'Anna Nagar', 'Head Office'
  is_primary      boolean default true     -- true = Head Office (auto-provisioned)
  is_active       boolean default true     -- false = archived; historical data stays intact
  display_order   integer default 0
  locked          boolean default false    -- true during subscription downgrade
  archived_at     timestamptz              -- set when is_active → false
  created_at      timestamptz

-- Constraints
UNIQUE INDEX uk_location_primary ON location(store_fk) WHERE is_primary = TRUE  -- one Head Office per store

-- FK additions on existing tables (requires migrations)
order.location_fk            bigint → location.id
inventory_balance.location_fk bigint → location.id
inventory_movement.location_fk bigint → location.id
stock_take.location_fk       bigint → location.id
stock_adjustment.location_fk bigint → location.id
stock_history.location_fk    bigint → location.id
fifo_cost_layer.location_fk  bigint → location.id
shift.location_fk            bigint → location.id
shift_session.location_fk    bigint → location.id
register.location_fk         bigint → location.id
store_device_access.location_fk bigint → location.id   ← devices belong to a location
```

**Head Office auto-provision** (already designed in subscription.md §8)
At store creation, the store-create transaction must atomically insert a `location` row with
`is_primary = true`, `is_active = true`, `display_order = 0`. This is Head Office and counts as
slot 1 against `max_locations_per_store`. The `UNIQUE INDEX uk_location_primary` guarantees
only one primary location exists per store.

**Archiving locations** — never hard-delete a location. Set `is_active = false` + `archived_at = now()`.
Historical orders, inventory, shifts, and reports referencing `location_fk` remain fully intact.
Archived locations are hidden from the UI but still queryable for history.

---

### 26.2 TenantGuard — resolve locationId alongside storeId

**Current state (🔴 GAP)**

`TenantGuard` only resolves `storeId` and writes `request.context = { storeId, storeGuuid }`.
Location is not part of the resolved context.

**Target**

Every request that operates on location-scoped data must carry a `locationId` in the URL.
`TenantGuard` must resolve it **after** resolving `storeId`, verify the location belongs to the
resolved store, and verify the user is assigned to that location (see §26.3).

**New decorator**

```typescript
@LocationContext('param.locationId')    // or 'query.location_id' etc.
```

**New request context shape**

```typescript
interface ResolvedStoreContext {
  storeId:      number;
  storeGuuid:   string;
  locationId?:  number;   // populated when @LocationContext present
  locationGuuid?: string;
}
```

**TenantGuard extended logic (after storeId resolved)**

```
@LocationContext('param.locationId') present?
  │
  ├─ Extract raw locationId from request
  ├─ DB: SELECT id, guuid FROM location
  │       WHERE (id = :raw OR guuid = :raw)
  │         AND store_fk = resolvedStoreId        ← must belong to this store
  │         AND deleted_at IS NULL
  │
  ├─ Not found → 404 LOCATION_NOT_ACCESSIBLE
  │
  ├─ User assigned to this location?
  │   SELECT 1 FROM user_location_mapping
  │   WHERE user_fk = userId AND location_fk = locationId
  │         AND revoked_at IS NULL
  │   OR user is STORE_OWNER / CO_OWNER in this store (bypass)
  │
  ├─ Not assigned → 403 LOCATION_ACCESS_DENIED
  │
  └─ request.context.locationId = resolved.id
     request.context.locationGuuid = resolved.guuid
```

**New route pattern**

```
GET  /stores/:storeId/locations/:locationId/orders
POST /stores/:storeId/locations/:locationId/orders
GET  /stores/:storeId/locations/:locationId/inventory
POST /stores/:storeId/locations/:locationId/inventory/adjustments
GET  /stores/:storeId/locations/:locationId/shifts
GET  /stores/:storeId/locations/:locationId/devices
```

**Route nesting depth rule — max 3 levels**

Never nest beyond `/stores/:id/locations/:id/<resource>`. Deeper paths (e.g.
`/stores/:id/locations/:id/registers/:id/shifts/:id/orders`) are brittle to authorize and
maintain. Resource IDs beyond depth 3 belong in the request body or as query params.

**Recommended guard decomposition (Single Responsibility)**

Instead of folding all logic into `TenantGuard`, prefer three focused guards:

```
StoreGuard      → resolves storeId; verifies store membership via user_role_mapping
LocationGuard   → resolves locationId (only when @LocationContext present); verifies user_location_mapping
PermissionGuard → checks RBAC: entity × action × role matrix
```

Each guard has exactly one job. Routes without `@LocationContext` skip `LocationGuard` entirely.

---

### 26.3 user_location_mapping — location assignment

**Current state (🔴 GAP — table does not exist)**

Users are mapped to stores via `user_role_mapping`. There is no way to restrict which locations
within a store a user can work at.

**Why not role-scoped per location?**

Do NOT make roles location-scoped. A cashier working at 3 branches should have ONE Cashier role
in the store. Location access is a separate dimension — *where* they work, not *what* they can do.

```
WRONG model:
  Cashier-AnnaGuru role  ← 3 duplicate roles
  Cashier-Velachery role
  Cashier-Tambaram role

CORRECT model:
  Role: Cashier (store-scoped)          ← what they can do
  Locations: [Anna Nagar, Velachery]    ← where they can do it
```

**New schema**

```sql
user_location_mapping
  id            bigserial PK
  user_fk       text → user.id
  location_fk   bigint → location.id   -- store is derived: location.store_fk
  assigned_by   text → user.id
  assigned_at   timestamptz default now()
  revoked_at    timestamptz
  UNIQUE (user_fk, location_fk)
```

> **No `store_fk` on this table.** Store is always derivable via `location.store_fk` join.
> Storing it here would create a denormalization risk (location.store_fk and
> user_location_mapping.store_fk could diverge). The join cost is negligible at our scale.

**Authorization check (dual gate)**

Every location-scoped operation requires BOTH checks to pass:

```
1. rbac.checkCrud(permissions, entity, action)   ← Role grants the WHAT
        AND
2. userLocationMapping.isAssigned(userId, locationId)  ← Assignment grants the WHERE
```

```
Example: John has Cashier role (Order.create = true) in Chennai Store.
John's location assignments: [Anna Nagar, Velachery]

POST /stores/chennai/locations/anna-nagar/orders  → ✅ (role ✓, location ✓)
POST /stores/chennai/locations/tambaram/orders    → ❌ 403 LOCATION_ACCESS_DENIED
                                                     (role ✓, but location ✗)
```

**Bypass rule — STORE_OWNER and CO_OWNER access all locations**

Users with `STORE_OWNER` or a co-owner equivalent role in the store are implicitly assigned to
ALL locations. They do not need explicit rows in `user_location_mapping`.

```typescript
const isStoreOwner = userRoles.some(r => r.code === 'STORE_OWNER' || r.code === 'CO_OWNER')
if (isStoreOwner) return true   // bypass location check

return userLocationRepo.isAssigned(userId, locationId)
```

---

### 26.4 Account layer — account_subscription and account_users

**Current state (🟡 partially built)**

> **Correction.** The existing `accounts` table in `schema.ts` **is** the Ayphen **business-account
> tenant entity** — it is **not** a Better Auth credential table. The project uses a custom
> **OTP + JWT** auth flow and does **not** use Better Auth at all. Auth credentials live on
> `users` + `deviceSessions`. So there is no OAuth-table name collision to design around; the
> real gap is that `accounts` is **missing fields** (`gst_number`, `billing_address`,
> `razorpay_customer_id`) and its **companion tables** are incomplete.

What exists today: `accounts` (tenant) and `accountUsers` (M:M) are built. What's missing:
- `account_subscription` — the one-per-account subscription row (📋 not built; subscription
  data does not yet have an account-scoped home).
- The extra `accounts` columns listed above.

**Required additions** (already specified in subscription.md §2B, pending implementation):

> **Table naming — decided.** The existing tenant table is already named **`accounts`**. Since
> there is no Better Auth table to collide with (see correction above), **keep `accounts`** —
> renaming to `business_account` is unnecessary churn. All SQL and diagrams in this doc use
> `accounts` for the tenant entity.
> The important work is the **missing columns and the `account_subscription` table**, not a rename.

```sql
-- Organization / Tenant entity — ✅ exists as `accounts`; ADD the missing columns
accounts
  id                   uuid PK
  account_number       text UNIQUE       -- 'ACC-XXXXXX' (existing)
  name                 text              -- 'ABC Super Market Pvt Ltd' (INTERNAL ONLY)
  gst_number           text              -- 🔴 ADD
  billing_address      jsonb             -- 🔴 ADD
  razorpay_customer_id text              -- 🔴 ADD
  created_at           timestamptz

-- One subscription per account — 📋 Target (does not exist)
account_subscription
  id                   uuid PK
  account_fk           uuid → accounts.id   UNIQUE
  plan_fk              uuid → subscription_plan.id
  status               text
  trial_ends_at        timestamptz
  current_period_start timestamptz
  current_period_end   timestamptz
  past_due_grace_until timestamptz
  access_valid_until   timestamptz
  cancel_at_period_end boolean default false
  subscription_version integer default 0
  has_used_trial       boolean default false

-- M:M users ↔ accounts — ✅ exists as `accountUsers`
account_users
  id           uuid PK
  account_fk   uuid → accounts.id
  user_fk      text → user.id
  is_owner     boolean default false    -- account owner (can transfer ownership)
  is_co_owner  boolean default false    -- elevated account access; can manage billing
  UNIQUE (account_fk, user_fk)

> **No `role` column on `account_users`.** Roles like manager/cashier/accountant live in
> `user_role_mapping` (store-scoped). Having a `role` column here too creates a synchronization
> hazard — two tables would independently describe the same person's role and could diverge.
> The only account-level distinction is ownership: `is_owner` and `is_co_owner`.

-- stores.account_fk → accounts.id  (✅ already how stores link to the tenant)
stores.account_fk  uuid → accounts.id
```

**Migration path** (from subscription.md §2B — `accounts` and `account_users` already exist,
so the remaining steps are):
1. Add the missing columns to `accounts` (`gst_number`, `billing_address`, `razorpay_customer_id`).
2. Create `account_subscription` — copy rows from the legacy `user_subscription` (one per account).
3. Drop `store_subscription` and `user_subscription` once all reads move to `account_subscription`.

---

### 26.5 SubscriptionStatusGuard — Account → Subscription → Stores

**Current state (🟡 partial — single inline query)**

The actual `SubscriptionStatusGuard`
(`apps/backend/src/auth/mobile/guards/subscription-status.guard.ts`) does a **single direct
inline Drizzle query** — there is no `accountSubscriptionService`, no two-tier check, and no
`store_subscription` read:

```ts
const [sub] = await this.db
  .select({
    status:           accountSubscriptions.status,
    accessValidUntil: accountSubscriptions.accessValidUntil,
  })
  .from(accountSubscriptions)
  .where(eq(accountSubscriptions.accountFk, storeContext.accountId));
```

Gaps in the current implementation vs the target below:
- **No Redis cache** — every write request hits the DB.
- **No `X-Subscription-Warning` header** on past-due-in-grace.
- **No entitlement or feature-flag checks** (§26.6).
- **No versioned cache key** and **no `subscription_version` bump** wiring.

The target is this same single `account_subscription` row governing all stores, but cached,
versioned, and extended with the full status/entitlement/feature gate.

**Target resolution path**

```
SubscriptionStatusGuard:

  1. Resolve account:
     store.account_fk → accounts.id

  2. Load subscription:
     account_subscription WHERE account_fk = accountId

  3. Apply status gate (writes only):
     - status in (trialing, active, free)  → allow
     - past_due AND now < access_valid_until → allow + X-Subscription-Warning header
     - past_due AND now >= access_valid_until → 402 SUBSCRIPTION_PAYMENT_REQUIRED
     - cancelled AND now < current_period_end → allow + notice
     - cancelled AND now >= current_period_end → 402
     - paused → 403 SUBSCRIPTION_SUSPENDED (reads still pass)

  4. Get/HEAD/OPTIONS → always skip gate (reads never blocked)
```

**Drop `store_subscription`** — after migration, delete the table. All subscription data
lives on `account_subscription`. No more per-store billing.

---

### 26.6 Subscription entitlement enforcement in guards

**Current state (🔴 GAP)**

`SubscriptionStatusGuard` currently only gates writes on subscription status (active/lapsed).
It does NOT enforce plan entitlements (`max_stores`, `max_locations_per_store`,
`max_devices_per_store`, `max_users_per_store`, `max_products`) or feature flags.
Entitlement checks are scattered or missing entirely.

**Target — inline count checks at resource-create endpoints**

**Preferred: decorator-driven enforcement**

```typescript
@EnforceLimit('max_stores')          // reads accountId from request.context
@Post()
async createStore() { ... }

@EnforceLimit('max_locations_per_store')
@Post(':storeId/locations')
async createLocation() { ... }

@EnforceLimit('max_devices_per_store')
@Post(':storeId/devices/access')
async registerDevice() { ... }

@EnforceLimit('max_users_per_store')
@Post(':storeId/invitations')
async invite() { ... }

@EnforceLimit('max_products')
@Post(':storeId/products')
async createProduct() { ... }
```

The `@EnforceLimit(key)` decorator wraps `EntitlementService.canCreate()` and throws
`403 {key}_LIMIT_REACHED` if over plan. Controllers stay clean — no inline count checks.

**Imperative fallback** (for complex pre-checks or mid-flow gates):

```typescript
// POST /stores  (create a new store)
const limit = await entitlements.get(accountId, 'max_stores')
const current = await storeRepo.countActive(accountId)
if (!canCreate(limit, current)) throw new ForbiddenException('STORE_LIMIT_REACHED', ...)

// POST /stores/:id/locations  (create branch location)
const limit = await entitlements.get(accountId, 'max_locations_per_store')
const current = await locationRepo.countForStore(storeId)
if (!canCreate(limit, current)) throw new ForbiddenException('LOCATION_LIMIT_REACHED', ...)

// POST /stores/:id/devices/access  (register device)
const limit = await entitlements.get(accountId, 'max_devices_per_store')
const current = await deviceRepo.countActiveForStore(storeId)
if (!canCreate(limit, current)) throw new ForbiddenException('DEVICE_LIMIT_REACHED', ...)

// POST /stores/:id/invitations  (invite staff)
const limit = await entitlements.get(accountId, 'max_users_per_store')
const current = await staffRepo.countActive(storeId)
if (!canCreate(limit, current)) throw new ForbiddenException('USER_LIMIT_REACHED', ...)

// POST /stores/:id/products  (create product)
const limit = await entitlements.get(accountId, 'max_products')
const current = await productRepo.countNonArchived(storeId)
if (!canCreate(limit, current)) throw new ForbiddenException('PRODUCT_LIMIT_REACHED', ...)
```

`canCreate(limit, current)`:
```typescript
function canCreate(limit: number | null, current: number): boolean {
  return limit === null || current < limit   // null = unlimited
}
```

**Feature flag enforcement** (`plan_features` table):

```typescript
// @RequiresFeature('offline_mode') on controller
const enabled = await features.get(accountId, 'offline_mode')
if (!enabled) throw new ForbiddenException('FEATURE_NOT_AVAILABLE', ...)
```

The `@RequiresFeature(key)` decorator already exists but is not wired to the new two-table
design. It must read from `plan_features(plan_fk, key, enabled)` via the account's plan.

---

### 26.7 Entity scoping: Orders, Inventory, Devices, Shifts belong to Location

**Current state (🔴 GAP — all store-scoped only)**

| Entity | Current scope | Target scope |
|---|---|---|
| `order` | `store_fk` only | + `location_fk` |
| `inventory_balance` | `store_fk` only | + `location_fk` |
| `inventory_movement` | `store_fk` only | + `location_fk` |
| `stock_take` | `store_fk` + text `locationId` | replace text with `location_fk` FK |
| `stock_adjustment` | `store_fk` + text `locationId` | replace text with `location_fk` FK |
| `stock_history` | `store_fk` + text `locationId` | replace text with `location_fk` FK |
| `fifo_cost_layer` | `store_fk` + text `locationId` | replace text with `location_fk` FK |
| `shift` | `store_fk` only | + `location_fk` |
| `shift_session` | `store_fk` + `register_fk` | + `location_fk` |
| `register` | `store_fk` + text `locationId` | `location_fk` ONLY — no `store_fk` (derive store via location join) |
| `store_device_access` | `store_fk` only | + `location_fk`; add `UNIQUE (device_fk) WHERE released_at IS NULL` — one active location per device |

**Inventory per location (example)**

```
Anna Nagar Branch:
  inventory_balance WHERE location_fk = anna_nagar AND product_fk = coke → 50 units

Velachery Branch:
  inventory_balance WHERE location_fk = velachery AND product_fk = coke → 20 units

Store-level aggregate (for reports):
  SUM(units) WHERE store_fk = chennai AND product_fk = coke → 70 units
```

**Device per location — one active location at a time**

```sql
-- Constraint: a device can only be active at one location at a time
UNIQUE INDEX uk_device_active_location ON store_device_access(device_fk)
  WHERE released_at IS NULL
```

```
store_device_access
  device_fk = tablet-01
  location_fk = anna_nagar   → active slot at Anna Nagar
  released_at = NULL         → currently active
```

A device cannot be simultaneously registered at Anna Nagar AND Velachery. The cashier
physically brings the tablet to whichever location they're working at; the app calls `/open`
to release the previous slot and claim the new one. This matches physical POS reality.

`max_devices_per_store` counts all active slots across all locations in the store (SUM across locations ≤ plan limit).

---

### 26.8 Bootstrap snapshot — include accessible locations

**Current state (🔴 GAP)**

`StorePermissionEntry` has no location data. The mobile app cannot know offline which
locations exist or which the user is assigned to.

**Target `StorePermissionEntry`**

```typescript
interface LocationEntry {
  location_id:    string;
  location_guuid: string;
  name:           string;
  is_primary:     boolean;    // Head Office flag
  is_locked:      boolean;    // downgrade-locked
}

interface StorePermissionEntry {
  store_id:                  string;
  store_guuid:               string;
  roles:                     string[];
  is_owner:                  boolean;

  crud:                      Record<EntityCode, CrudMatrix>;
  special:                   Record<EntityCode, string[]>;

  offline_allowed_entities:  string[];
  offline_constraints:       { max_refund_amount: number | null };

  // NEW: location access
  locations: LocationEntry[];   // locations THIS user is assigned to (or all if owner)
  default_location_id?: string; // last used / pinned location for offline startup
}
```

The mobile app uses `locations[]` to:
- Show the location picker on startup.
- Know which locations to sync data for (offline-first: only download data for assigned locations).
- Gate location-scoped UI without a network call.

**Three independent version signals (split versions)**

Instead of a single `permissions_version` that forces a full snapshot refresh on any change,
split into three separate versions:

| Version | Bumped when | Client action on mismatch |
|---|---|---|
| `permissions_version` (pv) | Role assigned/revoked, permission matrix changed | Re-fetch full `snapshot.stores[].crud` + `special` |
| `location_version` (lv) | Location created/archived, user_location_mapping assigned/revoked | Re-fetch `snapshot.stores[].locations[]` only |
| `subscription_version` (sv) | Plan changed, payment received, trial ended | Re-fetch `snapshot.stores[].subscription` only |

> `subscription_version` already exists in the backend (verified api-reference §6).
> `location_version` is new.

> **Placement of `location_version` — put it on `store`, not `user`.** A location change
> (created / archived / assignment added or revoked) is a **store-scoped** event. Storing
> `location_version` on the `user` row forces a fan-out UPDATE to **every** member of the store
> on each location change — expensive for large stores. Instead store `location_version` on the
> **`store`** row and bump it once per location change. The JWT (or bootstrap) carries `lv` per
> store; a mismatch on any request to that store busts the location cache. This mirrors the
> `permissions_version` pattern but at **store scope** rather than user scope. (`permissions_version`
> stays on `user` — it genuinely tracks a per-user RBAC state.)

**Bootstrap response extended**:
```typescript
{
  permissions_version: number,   // existing
  location_version: number,      // new — bump on location/assignment changes
  subscription_version: number,  // existing (from api-reference §6)
  snapshot: StorePermissionEntry[]
}
```

**Permission cache key** — must include all three versions:
```
rbac:{userId}:{storeId}:{pv}:{lv}:{sv}
```
This ensures the cache is busted after location reassignment (`lv` changes) or subscription
change (`sv` changes) without invalidating unrelated permission entries.

---

### 26.9 Reports — store, location, and account scopes

**Current state (🔴 GAP — `Report` entity has view/export but no scope concept)**

**Target scopes**

```
Account-level report          → aggregates all stores under the account
Store-level report            → aggregates all locations within one store
Location-level report         → one specific location only
Multi-location report         → arbitrary subset of locations (regional manager)
```

**Route pattern**

```
GET /me/account/reports/summary                                        ← account-wide (owner/accountant only)
GET /stores/:storeId/reports/summary                                   ← store-wide (store owner)
GET /stores/:storeId/locations/:locationId/reports/summary             ← per-location (any assigned staff)
GET /stores/:storeId/reports/summary?location_ids[]=loc1&location_ids[]=loc2   ← multi-location aggregate
```

**Multi-location aggregate** — for regional managers assigned to multiple but not all locations.
The server validates that the requesting user is assigned to every `location_id` in the array
(or is STORE_OWNER). This avoids needing a "Regional Manager" role; any user assigned to
locations A+B can request a joint report for A+B.

**Permission check for account-level reports**

```typescript
@RequirePermissions({ entity: 'Report', action: 'view' })
// + account_users role check: only 'owner' | 'co_owner' | 'accountant'
```

**Permission check for location-level reports**

```typescript
@RequirePermissions({ entity: 'Report', action: 'view' })
// + location assignment check (user must be assigned to this location or be store owner)
```

**EXPORT special action** remains entity-level; scope (location vs store vs account) is
determined by the route, not by the permission matrix.

---

### 26.10 Complete target permission flow

```
Mobile login
     │
     ▼
MobileJwtGuard
  Verify JWT, check JTI blacklist, load session + device + user
  request.auth = { user, device, session, jwt: { pv } }
     │
     ▼
TenantGuard
  @StoreContext → resolve storeId; verify user has role in this store
  @LocationContext → resolve locationId; verify user is assigned to location
  request.context = { storeId, storeGuuid, locationId?, locationGuuid? }
     │
     ▼
StepUpAuthGuard (if @StepUpAuth)
  Check session.lastStepUpAt within window
     │
     ▼
PermissionsGuard  ← RBAC check: "can this user do this action?"
  pv/lv/sv mismatch (any version) → bust Redis cache
  getCachedPermissions(userId, storeId, pv, lv, sv, isCritical)
    → cache key: rbac:{userId}:{storeId}:{pv}:{lv}:{sv}
    → EffectivePermissions { crud, special }
  checkCrud(permissions, entity, action)
  checkSpecial(permissions, entity, actionCode)  [if @RequireSpecial]
  request.auth.permissions = EffectivePermissions
     │
     ▼
SubscriptionStatusGuard  ← Subscription check: "has this account paid for this?"
  Load account via store.account_fk → accounts
  Load account_subscription
  Status gate → block writes if lapsed
  Entitlement gate → block creates if over-plan limit
  Feature gate → block if feature disabled on plan
     │
     ▼
Controller (Business Logic)
```

Two **independent** checks — RBAC and Subscription — must both pass:
- **RBAC** answers: "Is this user allowed to do this action?"
- **Subscription** answers: "Has this account purchased this capability, and are limits in range?"

---

### 26.11 Sync filter extension for location scope

**Current state (🔴 GAP)**

All sync filters use `ctx.storeId` only. For location-scoped entities, they must also
filter by `ctx.locationId` if present.

```typescript
// Current (store-scoped only)
.where(eq(order.storeFk, ctx.storeId))

// Target (location-aware)
.where(
  and(
    eq(order.storeFk, ctx.storeId),
    ctx.locationId ? eq(order.locationFk, ctx.locationId) : undefined,
  )
)
```

For the initial sync (`POST /sync/initial`), the client must send:

```typescript
{
  locationIds: string[],       // all locations assigned to this user (from bootstrap snapshot)
  defaultLocationId?: string,  // the location to prioritize / load first on cold start
  cursor?: number,             // omit for cold start
}
```

`locationIds[]` bounds the sync payload — only entities for these locations are returned.
`defaultLocationId` lets the server prioritize that location's data in the response so the
client can open the POS while remaining locations sync in the background.

---

### 26.12 Overall target hierarchy — reference model

```
accounts  (tenant / organization — INTERNAL name; not on invoices)
│
├── account_subscription  (one per account — plan, billing, limits)
│     ├── plan_entitlements  (max_stores, max_locations_per_store, max_devices_per_store, ...)
│     └── plan_features      (offline_mode, barcode_scanning, advanced_reports, ...)
│
├── account_users  (M:M — is_owner: bool, is_co_owner: bool; store roles live in user_role_mapping)
│
└── stores  (account_fk → accounts)
      │
      ├── user_role_mapping  (who has which role in THIS store)  ← RBAC: WHAT
      │
      └── locations  (store_fk → store)
            │
            ├── user_location_mapping  (who can work HERE)       ← RBAC: WHERE
            │
            ├── store_device_access  (device ↔ location link)
            │
            ├── inventory_balance / movements  (stock at this location)
            │
            ├── orders  (placed at this location)
            │
            ├── shifts / shift_sessions  (opened at this location)
            │
            └── registers  (POS terminals at this location)

users
  ├── user_role_mapping  (store membership + role)
  └── user_location_mapping  (location assignment within a store)
```

---

### 26.13 Implementation priority

| Priority | Change | Depends on |
|---|---|---|
| P0 | Create `location` table + Head Office auto-provision at store-create | Nothing |
| P0 | Add `location_fk` to `store_device_access` | `location` table |
| P1 | Add `location_fk` to `order`, `shift`, `shift_session`, `register` | `location` table |
| P1 | Create `user_location_mapping` table | `location` table |
| P1 | `TenantGuard` — add `@LocationContext` resolver + location assignment check | `user_location_mapping` |
| P1 | Bootstrap snapshot — include `locations[]` per store | `user_location_mapping` |
| P1 | Replace text `locationId` strings in inventory tables with `location_fk` FK | `location` table |
| P2 | Extend `accounts` + create `account_subscription` migration (`accounts`/`account_users` already exist) | Subscription PRD §27 items 1–6 |
| P2 | `SubscriptionStatusGuard` — read from `account_subscription` via `store.account_fk` | P2 account migration |
| P2 | Entitlement enforcement (`max_stores`, `max_locations`, `max_devices`, `max_users`, `max_products`) | `plan_entitlements` table |
| P2 | Feature flag enforcement (`@RequiresFeature` wired to `plan_features` table) | `plan_features` table |
| P3 | Sync filters — add `locationId` scope for location-scoped entities | P1 `location_fk` additions |
| P3 | Route restructure to `/stores/:id/locations/:id/orders` etc. | P1 |
| P3 | Account-level and store-level report aggregation endpoints | P2 account migration |

---

### 26.14 What MUST NOT change

| Decision | Rationale |
|---|---|
| Roles remain **store-scoped**, not location-scoped | One role per store, multiple location assignments. Prevents N duplicate roles for multi-location staff. |
| Permission union across roles remains OR logic | Already correct. |
| Reads are never subscription-blocked | Already correct. |
| Point-in-time authorization for offline sync | Must extend to include location assignment check at the time of mutation: `wasAssignedToLocationAt(userId, locationId, asOf)`. |
| Critical operations use 30s cache TTL | Already correct. |
| System roles (`STORE_OWNER`, `USER`, `SUPER_ADMIN`) remain immutable | Already correct. |
| Invitations assign custom roles only | Already correct. |
| **Route nesting depth ≤ 3 levels** | Never go deeper than `/stores/:id/locations/:id/<resource>`. Authorization logic becomes unmaintainable beyond this depth. |
| **Locations are never hard-deleted** | Always archive (`is_active = false`, `archived_at`). Historical orders/inventory/shifts reference `location_fk` — deleting breaks reporting. |
| **One active location per device** | Enforced by `UNIQUE (device_fk) WHERE released_at IS NULL` on `store_device_access`. |
| **One primary location per store** | Enforced by `UNIQUE INDEX uk_location_primary ON location(store_fk) WHERE is_primary = TRUE`. |

---

### 26.15 Database indexes — production readiness

Without explicit indexes, queries degrade to full-table scans as data grows. The following
indexes are required before any location-scoped feature goes to production.

**`user_location_mapping`**
```sql
CREATE INDEX idx_ulm_user_location    ON user_location_mapping(user_fk, location_fk);
CREATE INDEX idx_ulm_user_active      ON user_location_mapping(user_fk, revoked_at);
CREATE INDEX idx_ulm_location         ON user_location_mapping(location_fk);
```
Enables: "all active locations for user X", "all users at location Y".

**`location`**
```sql
CREATE UNIQUE INDEX uk_location_primary ON location(store_fk) WHERE is_primary = TRUE;
CREATE INDEX idx_location_store_active  ON location(store_fk) WHERE is_active = TRUE;
```
Enables: Head Office enforcement + fast active-location list per store.

**`order`**
```sql
CREATE INDEX idx_order_store_location  ON "order"(store_fk, location_fk);
CREATE INDEX idx_order_location_date   ON "order"(location_fk, created_at);
```
Enables: store-wide and location-level order reports with date range filters.

**`inventory_balance`**
```sql
CREATE INDEX idx_inv_balance_location_product ON inventory_balance(location_fk, product_fk);
```
Enables: fast per-location stock lookup for a specific product.

**`shift`**
```sql
CREATE INDEX idx_shift_location_date ON shift(location_fk, opened_at);
```
Enables: location shift history and date-range shift reports.

**`store_device_access`**
```sql
CREATE INDEX idx_sda_store         ON store_device_access(store_fk);
CREATE INDEX idx_sda_location      ON store_device_access(location_fk);
CREATE INDEX idx_sda_device        ON store_device_access(device_fk);
CREATE UNIQUE INDEX uk_device_active_location ON store_device_access(device_fk)
  WHERE released_at IS NULL;
```
Enables: device limit count per store, active-location lookup per device, one-location constraint.

**`accounts` / `account_users`**
```sql
CREATE INDEX idx_account_users_user ON account_users(user_fk);
```
Enables: fast lookup of "which accounts does this user belong to".

> These indexes should be created in the same migration that adds the corresponding columns.
> All are non-unique (except where noted) and safe to add without locking on PostgreSQL 12+
> using `CREATE INDEX CONCURRENTLY`.
