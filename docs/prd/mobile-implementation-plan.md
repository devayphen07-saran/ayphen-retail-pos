# Mobile Implementation Plan — Complete Reference

> Synthesized from mobile-01 through mobile-12, device-management, subscription, rbac, and sync-engine PRDs.
> Backend verified against actual source code (apps/api/src) on 2026-06-30.
> This is the single file a mobile developer needs before touching a screen.

---

## Table of Contents

1. [Backend Gap Status](#1-backend-gap-status)
2. [Storage Strategy — What Goes Where](#2-storage-strategy--what-goes-where)
3. [API Calls — What to Call and When](#3-api-calls--what-to-call-and-when)
4. [Loading States — When to Show What](#4-loading-states--when-to-show-what)
5. [Offline-First Decision Map](#5-offline-first-decision-map)
6. [Service Architecture — 11 Modules](#6-service-architecture--11-modules)
7. [Concurrency Invariants — Must-Never-Violate](#7-concurrency-invariants--must-never-violate)
8. [Startup State Machine](#8-startup-state-machine)
9. [Post-Login Flow — Step by Step](#9-post-login-flow--step-by-step)
10. [Sync Implementation Guide](#10-sync-implementation-guide)
11. [Freshness Protocol](#11-freshness-protocol)
12. [Device Management Flows](#12-device-management-flows)
13. [Subscription & Write Gating](#13-subscription--write-gating)
14. [RBAC & Permission Gating](#14-rbac--permission-gating)
15. [Implementation Phases](#15-implementation-phases)
16. [Known Backend Contract Issues](#16-known-backend-contract-issues)

---

## 1. Backend Gap Status

Backend verified against source code. **The critical #1 gap (POS handlers) is already built.**

### ✅ Built and verified

| Feature | Endpoint / File | Notes |
|---|---|---|
| 2-stage OTP login with device registration | `POST /auth/mobile/login` | Stage 2 requires `device` object |
| Bootstrap with active store | `GET /me/bootstrap` | Returns `active_store`, `active_store_access`, `has_pending_invitations`, `snapshot`, `snapshot_signature`, `permissions_version` |
| Merged store open | `POST /stores/:id/open` | Access + context + subscription in one call |
| Sync manifest | `GET /stores/:id/sync/manifest` | Returns entity counts + schema_version |
| Cold-start per entity | `GET /stores/:id/sync/initial` | All 7 fields present |
| Delta pull | `GET /stores/:storeId/sync/changes` | Store-scoped (see §16) |
| Push+pull | `POST /stores/:storeId/sync/delta` | Store-scoped; returns `mutation_results[]`, `changes`, `sync_cursor` |
| Subscription ETag poll | `GET /me/subscription/sv` | 304 on no change |
| Subscription version header | `X-Subscription-Version` | Every authenticated response |
| Device slot claim | `POST /stores/:id/access` | Returns `{access, isNew}` or 403 `DEVICE_LIMIT_REACHED` |
| Device list | `GET /stores/:id/devices` | Returns `{meta:{limit,active,planName}, devices[]}` |
| Device revoke | `POST /stores/:storeId/devices/:deviceGuuid/revoke` | Blocks self-revoke |
| Device block/unblock | `PATCH /devices/:guuid/block|unblock` | Under `/devices` controller |
| My devices | `GET /devices/my` | Lists all user devices across stores |
| Per-account subscription guard | `subscription-status.guard.ts` | Reads via `account_users → account_subscription` |
| **POS mutation handlers** | `order-create`, `order-item-create`, `order-payment-create`, `shift-session-create/update`, `cash-movement-create`, `shift-event-create`, `denomination-count-create` | **All built** — offline checkout can push |
| Subscription lapse write check | `sync-delta.service.ts:464` | Rejects mutations where `clientModifiedAt > accessValidUntil` with `SUBSCRIPTION_LAPSED_AT_WRITE` |
| Rate limiter per `(userId, storeId)` | `SyncRateLimitGuard` | Per-store budget, no cross-store throttling |

### ⚠️ Partial / Contract Mismatches

| Feature | Issue | Mobile action required |
|---|---|---|
| `GET /me/subscription` response shape | `access_valid_until` is at `subscription.offline_access_until`, `banner_severity` is at `subscription.banner.severity` — not flat top-level fields | Read nested paths, or request backend to flatten |
| `/stores/:id/access` vs `/open` field names | `/access` returns `isNew` (camelCase), `/open` returns `is_new_slot` (snake_case) | Use `is_new_slot` from `/open` (preferred path); only use `/access` camelCase field on legacy path |

### ❌ Not Built

| Feature | Impact | Priority |
|---|---|---|
| `force_bootstrap`/`store_access_changed` decoupled from `snapshotChanged` | Redundant bootstraps | P1 |
| Lean bootstrap (remove `store_logos`, `store_hours`, `pending_invitations[]`, `sync_config`, `app_config`, top-level `subscription`, `server_time`) | Slower cold launch | P1 |
| `GET /me/pv` ETag warm-open endpoint | Warm launch still hits full bootstrap | P1 |
| `GET /me/snapshot` (pull snapshot on version mismatch) | Must inline in refresh or bootstrap | P2 |
| Shift lifecycle server enforcement (`shift_not_open` error) | No server-side shift validation | P2 |
| `426` / maintenance middleware | 503 is de-facto; no force-update gate | P2 |
| Reconciliation cron for `access_valid_until` at `trial_ends_at`/`current_period_end` | Time-based subscription transitions need cron or webhook | P1 |

---

## 2. Storage Strategy — What Goes Where

### 2.1 Storage Tiers

```
SecureStore (Keychain/Keystore)
  ├── access_token
  ├── refresh_token
  ├── signed_snapshot  (bytes — Ed25519 signed)
  ├── snapshot_signature
  ├── snapshot_version
  ├── access_valid_until       (offline write-gate guard)
  ├── server_time_offset_ms    (ClockService persisted offset)
  └── subscription_version     (last known, for monotonic guard)

SQLite (one DB per store_fk — partitioned)
  ├── [21 synced entities] — see §2.2
  ├── sync_cursors             (one row per store_fk)
  ├── sync_init_progress       (cold-start resume)
  ├── local_store_state        (active store pointer)
  ├── mutation_queue           (outbound writes)
  ├── failed_applies           (DLQ)
  └── schema_meta              (migration version)

MMKV / In-Memory (ephemeral, non-sensitive)
  ├── server_time_offset_ms    (fast read; SecureStore is canonical)
  ├── UI preferences           (theme, layout)
  └── plan_catalog_cache       (24h TTL — billing screen only)

Redux / Memory (derived, rebuilt from SecureStore + SQLite on launch)
  ├── Auth slice               (tokens, session state)
  ├── User slice               (profile, preferences)
  ├── Store slice              (active store, context, hours)
  ├── Subscription slice       (account status, banner, write-gate)
  └── Sync slice               (queue depth, sync state, per-store cursor)
```

### 2.2 The 21 Synced Entities (SQLite — offline-first)

Partitioned by `store_fk`. Sync filter dependency order shown in parens.

**Reference / pull-only (read offline, no mutation handlers):**

| Entity | Dep order | Notes |
|---|---|---|
| `store` | 0 | Store config, hours → synced, no REST needed |
| `unit` | 2 | Unit of measure |
| `store_device_access` | 2 | Device slot records |
| `payment_method` | 5 | Payment types |
| `lookup` | 5 | Lookup tables (also writable) |
| `taxrate` | 6 | Tax rates |
| `staff` | 8 | Staff members |

**Catalog / master data (writable offline — mutation handlers exist):**

| Entity | Dep order | Mutation actions |
|---|---|---|
| `product` | 10 | create, update, delete |
| `product_case` | 11 | create, update, delete |
| `customer` | 20 | create, update, delete |
| `supplier` | 21 | create, update, delete |
| `paymentaccount` | 15 | create, update |
| `lookup` | 5 | create, update, delete |

**Transactional / POS (writable offline — ALL handlers built):**

| Entity | Dep order | Mutation entity type | Notes |
|---|---|---|---|
| `order` | 30 | `order` | HIGH priority queue |
| `order_item` | 31 | `order_item` | HIGH priority, parent=order |
| `order_payment` | 32 | `order_payment` | HIGH priority, parent=order |
| `shift` | 40 | `shift` (note: entity type is `shift` not `shift_session`) | MEDIUM priority |
| `cash_movement` | 41 | `cash_movement` | MEDIUM priority |
| `stock_take` | 70 | — | Synced in, no outbound handlers |
| `stock_take_line` | 71 | — | |
| `stock_adjustment` | 72 | — | |
| `stock_adjustment_line` | 73 | — | |
| `fifo_cost_layer` | 74 | — | |
| `stock_history` | 75 | — | |
| `stock_event` | 76 | — | |

### 2.3 What Must NEVER Be Stored Locally (API-Only)

| Data | Why never local | Endpoint |
|---|---|---|
| Subscription truth | Must be live — never gate writes off cached snapshot `subscription` (hint only) | `GET /me/subscription` |
| Invitation list | Low-volume, not synced, must-be-fresh | `GET /me/invitations` |
| Device list | Real-time slot state | `GET /stores/:id/devices` |
| Signed media URLs (logos, attachments) | Expire; SQLite URL would go stale silently | Attachment endpoints — lazy on render |
| Plan catalog | Low-frequency; 24h MMKV cache acceptable, never SQLite | `GET /subscription/plans` |
| Conflicts | Point-in-time resolution data | `GET /sync/conflicts` |
| Store hours | Returned by `/open` and `/context`; now also a sync entity on `store` table | From sync or `/context` |
| RBAC role definitions | Never client-authored | `GET /roles` (on-demand) |
| Deep reports / history | Server aggregated | On-demand only |

---

## 3. API Calls — What to Call and When

### 3.1 Pre-Auth (before any token)

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `GET /time` | App launch (INITIAL state) | `server_time_offset_ms` → SecureStore + MMKV | Stay on native splash (A) |
| `GET /auth/mobile/app-version` | App launch (INITIAL state) | Compare to bundled version | Stay on native splash; force-update wall if required |

### 3.2 Authentication

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `POST /auth/mobile/login` (stage 1 — send OTP) | User submits phone | Nothing | Inline button spinner (E) |
| `POST /auth/mobile/login` (stage 2 — verify OTP + register device) | User submits OTP code | `access_token`, `refresh_token` → SecureStore | Inline button spinner (E) |

**Stage 2 payload must include `device` object:**
```json
{
  "otpCode": "123456",
  "device": {
    "publicKey": "...",
    "platform": "ios",
    "model": "iPhone 15",
    "osVersion": "17.0",
    "appVersion": "1.2.3"
  }
}
```

### 3.3 Bootstrap (first login or expired/missing snapshot)

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `GET /me/bootstrap` | First login, snapshot expired (>7d), generation mismatch, explicit refresh needed | `snapshot` → SecureStore (verify Ed25519 sig first), `snapshot_signature`, `permissions_version`, `active_store`, `active_store_access` in memory | App-shell skeleton (C) — not blank spinner |

**Bootstrap response fields to consume:**
```
snapshot                 → SnapshotManager.ingest() → SecureStore + memory
snapshot_signature       → stored alongside snapshot
permissions_version      → monotonic guard input
active_store             → {id: string, guuid: string} | null
active_store_access      → {status:'granted', is_new_slot:boolean} | {status:'limit_reached',...} | null
has_pending_invitations  → show invitations badge/prompt
```

**Do NOT bootstrap on every launch.** Only when:
- First login (no snapshot in SecureStore)
- Snapshot `expiresAt` > 7 days ago
- Snapshot `generation` ≠ client's supported generation
- `GET /me/pv` returns a new `permissions_version` (not implemented yet → fall back to bootstrap)
- Hard recovery after signature verify failure

### 3.4 Store Open

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `POST /stores/:id/open` | User opens/switches to a store (online) | `store_hours`, `sync_config` → StoreManager memory; `subscription`, `subscription_version` → SubscriptionManager; `access` result | POS-shell skeleton (C) while one call returns |

**Use `/open` as the primary path — never call `/access` + `/context` separately.**

`POST /stores/:id/open` returns:
```
access              → {status:'granted', is_new_slot:boolean} | {status:'limit_reached',...}
store_hours         → in-memory only (do NOT persist to SQLite)
sync_config         → in-memory (per-store feature flags)
subscription        → SubscriptionManager.ingest() (hint — NOT truth)
subscription_version → monotonic subscription guard input
warnings            → surface to user (device near limit, trial ending)
```

**Offline reopen:** skip `/open`. Use prior claim. Load context from `store` sync entity.

### 3.5 Token Refresh

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `POST /auth/refresh` | Near 1h expiry detected by AuthService, OR on `401 token_expired` response | Rotated `access_token` + `refresh_token` → SecureStore | Silent — at most the triggering action's spinner |

**Single-flight (INV-3):** never two concurrent refreshes. All concurrent callers await the same promise. Refresh token is single-use; duplicate calls would orphan one rotation and cause a hard logout.

### 3.6 Subscription Freshness

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `GET /me/subscription/sv` | App foreground, every 5–10 min, reconnect | Nothing — just compare ETag | D ambient (or nothing if 304) |
| `GET /me/subscription` | `subscription_version` advanced (ETag miss on `/sv`), after payment, after `402` response | `subscription.offline_access_until`, `subscription.banner.severity`, `subscription_version` → SubscriptionManager | D ambient |

**Field mapping (backend shape vs what you use):**
```
GET /me/subscription response:
  subscription_version              → monotonic guard
  subscription.offline_access_until → write-gate: block writes when now() >= this
  subscription.banner.severity      → banner color: 'info' | 'warning' | 'critical' | 'blocked'
  subscription.status               → 'active' | 'trial' | 'grace_period' | 'expired' | 'canceled'
```

**Own stores:** always use `GET /me/subscription` as truth.
**Invited stores:** use `snapshot.stores[].subscription` as hint only (never enforce writes off it).

### 3.7 Permission Freshness

| Call | Trigger | What to store | Loading |
|---|---|---|---|
| `GET /me/pv` (when built) | App foreground, every 5–10 min, reconnect | Compare `permissions_version`; pull snapshot only if advanced | D ambient (nothing if 304) |
| `GET /me/bootstrap` | `permissions_version` advanced (fallback until `/me/pv` is built) | Full snapshot refresh | App-shell skeleton (C) |

**Until `GET /me/pv` is built**, rely on:
1. `X-Subscription-Version` header on every response (for subscription)
2. `permissions_version` in `/auth/refresh` and `/sync/delta` response (for permissions)
3. Full bootstrap on foreground (with 5-min debounce)

### 3.8 Sync Calls

All sync routes are **store-scoped** at `/stores/:storeId/sync/*`.

| Call | Trigger | Cursor | Loading |
|---|---|---|---|
| `GET /stores/:id/sync/manifest` | Before cold-start, if never synced | None | D ambient |
| `GET /stores/:id/sync/initial?entity_type=X&page_cursor=Y` | Cold-start, entity by entity | `page_cursor` per entity (from `sync_init_progress`) | B until G1–G3 done, then D |
| `GET /stores/:storeId/sync/changes?cursor=<opaque>` | Delta pull (steady state) | Opaque cursor from `sync_cursors` table | D ambient always |
| `POST /stores/:storeId/sync/delta` | Push mutations + pull simultaneously | Body: `{mutations:[], cursor:<opaque>}` | E optimistic for POS writes; D for background sync |

**Cursor rules:**
- Cursor is **opaque** — never parse it on the client; round-trip verbatim
- Cursor stored in `sync_cursors` table (SQLite), keyed by `store_id`
- Cursor must be persisted **in the same SQLite transaction as the rows it covers** (INV-9)
- Missing cursor → cold-start from scratch

### 3.9 Device Management Calls (all API-only, no local tables)

| Call | Trigger | Loading |
|---|---|---|
| `GET /stores/:id/devices` | Device-management screen open | C skeleton |
| `POST /stores/:storeId/devices/:deviceGuuid/revoke` | Owner taps "Revoke" | E optimistic, rollback on error |
| `PATCH /devices/:guuid/block` | Owner blocks a device | E optimistic |
| `PATCH /devices/:guuid/unblock` | Owner unblocks | E optimistic |
| `GET /devices/my` | "My devices" profile screen | C skeleton |

### 3.10 Lazy / On-Demand Calls

| Call | When to call | Never... |
|---|---|---|
| `GET /me/invitations` | Invitations screen open or `has_pending_invitations=true` badge tapped | Pre-fetch or cache |
| Attachment URL endpoints | Lazy on image render | Store URL in SQLite — it expires |
| `GET /subscription/plans` | Billing/upgrade screen open | On every launch; 24h MMKV cache is fine |
| `GET /sync/conflicts` | Mutation returns `conflict` status | Pre-fetch |
| `GET /stores/:id/hours` | Hours display (after sync entity `store` is available, use that) | — |

---

## 4. Loading States — When to Show What

### 4.1 The Five Treatments

| Treatment | Rule | What it looks like |
|---|---|---|
| **A — Native splash** | App boot only (milliseconds) | OS-native splash screen |
| **B — Full-screen blocking** | No usable content AND cannot proceed | Branded spinner or determinate progress bar |
| **C — Skeleton / app-shell** | Layout is known, content is loading | Shimmer placeholder components |
| **D — Ambient / non-blocking** | Background work behind a usable screen | Persistent status chip in chrome |
| **E — Optimistic** | User-initiated write | Instant local apply + queue; rollback toast on reject |
| **Wall / Banner / Modal** | Error, entitlement, version state | Not a loader — a blocking UX decision gate |

### 4.2 Decision Rule

```
Has usable cached content for this screen?
  YES → NEVER full-screen. Render content + (D) ambient chip.
  NO  → (B) full-screen ONLY until minimum-viable data exists → unlock + background the rest.

Is this a user write?         → (E) optimistic. NOT a blocking spinner.
Is this irreversible finance? → (E) + explicit confirmation dialog (the ONE exception).
Is this an error/entitlement? → wall/banner/modal. NOT a loader.
Will this complete in <300ms? → show NOTHING (anti-flash delay).
```

### 4.3 Per-Scenario Matrix

| Scenario | Treatment | Notes |
|---|---|---|
| App boot | **A** native splash | |
| `GET /time` + `GET /auth/mobile/app-version` | Stay on **A** | forceUpdate → **wall** |
| OTP send / verify | **E** inline button spinner | |
| Cold launch, no snapshot → bootstrap | **C** app-shell skeleton | Not a blank spinner; chrome + placeholders while routing resolves |
| Warm launch, snapshot cached | **Nothing** | Render last screen from cache; pv check in **D** background |
| Mode chooser (Business/Personal) | Instant | Already in bootstrap response |
| Complete-profile / account forms | **E** button spinner on submit | |
| First store create / accept invite | **B** full-screen setup wizard with progress | First-run setup — the accepted full-screen case |
| `POST /stores/:id/open` | **C** POS-shell skeleton | Brief — one request |
| First cold sync | **B** until G1–G3 done → unlock POS | Finish G4–G5 in **D** background banner; NEVER block to 100% |
| Store switch → cached store | **Instant — NO loader** | Anti-flash; delta in **D** background |
| Store switch → un-cached store | **Content-area loading** within nav chrome | Scoped, cancelable; NOT full-screen takeover |
| Steady-state delta (`/sync/changes`, `/sync/delta`) | **D** ambient only | NEVER block |
| All POS writes (sale, add item, customer) | **E** optimistic | Instant local + queue; rollback toast on `rejected`/`conflict` |
| Refund / void / large cash | **E** + explicit confirm | The one place blocking is correct |
| Offline → online reconnect | **D** chip: Offline→Syncing→Synced | |
| Permission change (snapshot swap) | **D** silent re-gate | Optional toast "Permissions updated" |
| Account revoked / suspended / device blocked | **Wall** "Session ended" → login | Wipe SecureStore |
| Token refresh on `401` | **Silent** | At most the triggering action's spinner |
| Subscription write blocked (`402`/`403`) | **Banner/modal** "Renew" | Reads keep working |
| Device limit (`403` on `/access` or `/open`) | **Modal** with device list | |
| Maintenance (`503`) | **Wall** | |
| Invitations / hours / logos / devices / plans | **C** section skeleton | Never full-screen |
| Any list/detail reading from SQLite | **Instant**; C skeleton only if empty + sync in flight | |

### 4.4 The Only Correct Full-Screen Moments

After applying all defaults, full-screen blocking (`B`) is correct in **exactly two cases**:
1. **First-run store setup** (create or join) — setup wizard with progress.
2. **Hard session-end** — forced logout, force-update, maintenance walls.

Everything else is non-blocking by definition. If full-screen appears anywhere else, SQLite/snapshot cache is not being used.

### 4.5 Cold Sync Unlock Groups

```
Group 1 (reference)  store, unit, taxrate, payment_method, lookup, store_device_access
Group 2 (parties)    customer, supplier
Group 3 (catalog)    product, product_case, paymentaccount

→ G1–G3 complete = UNLOCK POS (INV-7)

Group 4 (inventory)  stock_take, stock_take_line, stock_adjustment, stock_adjustment_line,
                     fifo_cost_layer, stock_history, stock_event
Group 5 (txn)        order, order_item, shift

→ G4–G5 complete in D background
```

Within each group, fetch entities **in parallel** (bounded concurrency 3–4). Groups are sequential (FK dependencies).

---

## 5. Offline-First Decision Map

### 5.1 Fully Offline (no network needed)

| Operation | How |
|---|---|
| Browse products, customers, orders, shifts | Read from SQLite |
| Create/edit product, customer, supplier | Optimistic SQLite write + mutation queue (MEDIUM) |
| Place a sale (order + order_items + payment) | Optimistic SQLite write + mutation queue (HIGH) |
| Open/close shift, record cash movement | Optimistic SQLite write + mutation queue (MEDIUM) |
| View subscription banner | From last-known `access_valid_until` in SecureStore |
| Permission checks | From in-memory snapshot |
| Clock / timestamps | ClockService uses cached `server_time_offset_ms` |
| Store switch → cached store | Instant from SQLite + memory; no network needed |

### 5.2 Online-Only (require network)

| Operation | Why | What to show when offline |
|---|---|---|
| Login / OTP | No offline auth | Lock screen |
| Bootstrap | Requires server auth | App-shell skeleton; retry on reconnect |
| Token refresh | Server-side rotation | Silent retry; hard-logout if truly offline and token expired |
| Claim device slot (`POST /stores/:id/open`) | Atomic slot claim | Skip on reopen if prior claim exists |
| Upload product images | No queue; upload is online-only | Show prompt + disable picker while offline |
| View invitations | Not synced | Show empty + offline message |
| Manage devices | Not synced | Show empty + offline message |
| View subscription plans | Not synced | Disable billing nav entry or show cached MMKV |
| Subscription checkout | Financial action | Require network |

### 5.3 Offline Write-Gate (Subscription Lapsed)

```
Every write (before enqueue):
  1. if SubscriptionManager.canWrite(storeId) === false:
       show subscription-lapsed banner/modal
       block the write (do NOT enqueue)
       return early

canWrite checks:
  accessValidUntil = SecureStore["access_valid_until"]
  if now() >= accessValidUntil: return false

Server-side check (belt-and-suspenders):
  POST /sync/delta rejects mutations where clientModifiedAt > accessValidUntil
  → returns SUBSCRIPTION_LAPSED_AT_WRITE in mutation_results
```

### 5.4 Mutation Queue Priority

```
HIGH    order, order_item, order_payment, refund      (revenue — never starve)
MEDIUM  shift, cash_movement, stock_*, inventory
LOW     audit, analytics, telemetry, device last_accessed_at
```

Rules:
- Drain HIGH before MEDIUM before LOW
- FK/dependency order (`parent_guuid`) wins **within** a tier — `order_item` can never push before its `order`
- Build delta batch: sort by (priority DESC, dependency order)
- Max 7 retries per mutation → `dead` status → DLQ → surface in owner's "stuck items" view

### 5.5 Backoff Policy

```
attempts 1–7: next_attempt_at = now + min(2^attempts × base_ms, cap_ms)  (exponential, jittered)
Server Retry-After (429): honor over local curve
rejected (4xx business error, e.g. PERMISSION_DENIED): do NOT retry; roll back + toast
conflict (stale row_version): do NOT retry; route to conflict resolver
dead (attempts > 7): keep in DLQ for owner review; queue keeps flowing
```

---

## 6. Service Architecture — 11 Modules

### 6.1 Layer Diagram

```
AppLifecycle  (orchestrator — startup state machine; wires everything)
   │
   ▼
UI / screens  (read selectors, dispatch intents — NEVER fetch, NEVER touch SQLite directly)
   │
   ▼
SubscriptionManager   StoreManager   PermissionGate
   │                      │              │
   └──────────┬───────────┴──────┬───────┘
              ▼                   ▼
        RefreshCoordinator   SyncEngine ──▶ SyncScheduler (policy)
              │                   │
              ▼                   ▼
        SnapshotManager      Repositories (all SQLite access)
              │                   │
              ▼                   ▼
        AuthService ─── ClockService ─── HttpClient
              │                                │
              ▼                                ▼
        SecureStore                         network
```

Dependencies point **one direction only** (top → down). Lower layers never reach up.

### 6.2 Service Catalog

**AuthService**
- Owns: OTP login, token storage, single-flight token refresh (INV-3), logout teardown (INV-6)
- Sole writer of tokens in SecureStore
- Sole caller of `POST /auth/refresh`
- Exposes `getValidAccessToken()` — returns live token or awaits in-flight refresh
- Never touches permissions or stores

**SnapshotManager**
- Owns: Ed25519 signature verification, version monotonic guard (INV-1), atomic swap (INV-8), SecureStore snapshot persistence
- Single entrypoint `ingest(snapshot, sig, source)` — all four delivery channels use it
- Rejects older/equal versions, verifies sig, freezes snapshot, swaps live reference, notifies subscribers

**PermissionGate**
- Owns: client-side authorization reads — `canCreate(entity)`, `canEdit(entity)`, `canDelete(entity)`, `canPerform(action)`
- Pure read over current frozen snapshot for the active store — no I/O, no caching of its own
- NEVER calls the API; re-derives on `SnapshotChanged` event
- Never more permissive than the server

**RefreshCoordinator**
- Owns: cadence of freshness polling — one owner decides when to poll; screens never trigger freshness directly
- Triggers: app→foreground, every 5–10 min while active, focus of privileged screen, reconnect
- Actions: `GET /me/pv` ETag check → pull snapshot if stale → token pre-expiry refresh → subscription check
- Coalesces: never two concurrent passes

**StoreManager**
- Owns: active-store pointer, context load (latest-only, INV-2), store switching, device slot claim/release, active-store-removed teardown (INV-4)
- Holds `activeStoreId` + store context (hours, `sync_config`, feature flags, tax) — re-loaded on every switch
- On switch: abort previous context request, clear store-scoped selectors, load new context, hand `store_fk` to SyncEngine

**SyncEngine**
- Owns: SQLite mutation queue, priority scheduling + `parent_guuid` dependency resolution, retries/backoff/DLQ, conflict handling, cold-start + delta pull, migrate-before-sync (INV-5)
- Partitioned per `store_fk`
- Push-before-pull on reconnect
- INV-9 (cursor-after-commit) and INV-10 (queue-commit-ordering) live here

**ClockService**
- Owns: single server-time offset; the **only** source of "now" for anything the server validates
- `offset = serverNow − deviceNow`, refreshed from `x-server-time` header on every response and from `GET /time` pre-auth
- NO module calls `Date.now()` for a server-validated timestamp — they call `ClockService.now()`

**SubscriptionManager**
- Owns: banner severity/state, billing routing, `canWrite(storeId)` check, refresh-after-payment
- Truth channel: `GET /me/subscription` (own stores only)
- Hint channel: `snapshot.stores[].subscription` (invited stores — banner + optimistic gate only)
- NEVER enforces writes off the snapshot hint

**HttpClient** (foundational)
- Owns: single outbound pipeline — every service goes through it
- Pipeline: `tracing → ClockService(x-timestamp+nonce) → AuthService(Bearer) → retry/backoff → on-401: single-flight refresh → on-x-server-time: ClockService feed`
- No service sets auth headers, nonces, or retry logic itself

**SyncScheduler** (foundational)
- Owns: WHEN sync runs (policy); SyncEngine owns HOW it runs (mechanism)
- Reacts to: network restore, app foreground, wifi/cellular, battery, idle, manual pull, retry timers
- Splits policy from durable write path

**Repositories** (foundational)
- Owns: all SQLite access — one repository per entity
- `Components → Repository → SQLite` — never raw SQL in components

### 6.3 Sole-Owner Rules

| Concern | Sole Owner | Nobody else may... |
|---|---|---|
| Tokens in SecureStore | AuthService | Read/write tokens directly |
| `POST /auth/refresh` | AuthService | Call refresh (use `getValidAccessToken()`) |
| SecureStore (all keys) | AuthService / SnapshotManager | Access SecureStore from a screen or reducer |
| Snapshot bytes + swap | SnapshotManager | Mutate the live snapshot field-by-field |
| "Can I do X?" | PermissionGate | Hand-roll permission checks; call the API for perms |
| When to poll/refresh | RefreshCoordinator | Trigger freshness from a screen |
| Active store + context | StoreManager | Cache a stale store context; hold a second active-store pointer |
| Mutation queue lifecycle | SyncEngine / QueueRepo | Enqueue/remove/mark-applied from anywhere else |
| Sync cursors | SyncEngine | Advance a cursor |
| All SQLite | Repositories | Run raw SQL from a component |
| Bootstrap pipeline | AppLifecycle / BootstrapCoordinator | Call `bootstrap()` from inside a screen |
| "Now" (server-bound) | ClockService | Call `Date.now()` for a timestamp the server validates |
| Subscription truth | SubscriptionManager via `/me/subscription` | Enforce writes off `snapshot.subscription` |

---

## 7. Concurrency Invariants — Must-Never-Violate

### INV-1 — Monotonic Snapshot Version Guard

```
SnapshotManager.ingest(incoming):
  acquire(swapMutex)
  try:
    if incoming.version <= current.version: IGNORE (never regress)
    if not verifySig(incoming): keep current (never apply unverified)
    swap(incoming)  ← INV-8
  finally: release(swapMutex)
```

**Bug if violated:** a stale bootstrap clobbers freshly-revoked permissions.

### INV-2 — Latest-Only Context Commit

```
switchStore(B):
  prevController.abort()
  reqId = ++contextEpoch
  ctx = await GET /stores/B/context
  if reqId !== contextEpoch: DISCARD
  commit(ctx)
```

**Bug if violated:** Store B renders with Store A's hours/tax/flags.

### INV-3 — Single-Flight Refresh

```
getValidAccessToken():
  if token.valid: return token
  if !inFlightRefresh: inFlightRefresh = doRefresh().finally(() => inFlightRefresh = null)
  return await inFlightRefresh
```

**Bug if violated:** two parallel refreshes race the single-use rotation → hard logout.

### INV-4 — Active-Store-Removed Teardown

```
onSnapshotSwap():
  if activeStoreId not in snapshot.stores:
    abort context + queue work for that store
    clear store-scoped selectors + cached context
    resolve new active store (last_opened ?? default ?? picker)
    open new store
```

### INV-5 — Migrate-Before-Sync

```
appStart / postUpdate:
  if localSchemaVersion < bundledSchemaVersion: runMigrations()
  // only now:
  SyncEngine.start()
```

**Bug if violated:** post-update delta writes new columns against un-migrated table.

### INV-6 — Logout Lifecycle (ordered teardown)

```
logout(reason):
  StoreManager.releaseDeviceSlots()     // DELETE /stores/:id/access (best-effort)
  AuthService: DELETE session + revoke refresh (best-effort; offline → queue)
  wipe SecureStore (tokens + snapshot)
  SnapshotManager.clear(); memory reset
  if user-initiated: wipe SQLite (shared-device privacy)
  if token-expiry re-auth: KEEP SQLite (same user coming back — avoid needless cold sync)
  → login screen
```

### INV-7 — Unlock-on-Minimum, Sync-in-Background

The UI unlocks the moment **G1–G3 are complete**. Never block to 100%. G4–G5 finish in `D` ambient.

### INV-8 — Atomic + Storage-Transactional Snapshot Swap

```
swap(incoming):
  freeze(incoming)
  writeSecureStore(incoming) + flush    // DURABLE FIRST
  liveRef = incoming                    // THEN memory
  emit SnapshotChanged                  // THEN notify
```

SecureStore must be written (and flushed) **before** updating the in-memory reference. Disk is the source of truth on cold start.

### INV-9 — Cursor Advances Only After Commit 🔴

```
applyDelta(page):
  BEGIN
    upsert rows; apply tombstones
    persist new cursor            // SAME tx as rows
  COMMIT                          // rows + cursor atomically
```

**Never** persist the cursor before the rows. A crash between them skips those rows forever.

### INV-10 — Queue Commit Ordering 🔴

```
onPushResult(mutation, result):
  BEGIN
    apply result locally (upsert entity, patch FK, write projection)
    mark queue row = applied / dead / conflict
  COMMIT
```

**Never** mark applied then write effect. A crash between loses the mutation permanently.

### INV-11 — Exactly-One (or No) Active Store

Setting active store is a single guarded transition: validate membership in snapshot → set pointer → load context. A pointer to a store not in the snapshot is never valid.

### INV-12 — Freshness Precedence

Highest signed snapshot version always wins — delivery channel is irrelevant. Version is the sole arbiter; clock plays no part.

---

## 8. Startup State Machine

```
INITIAL ──▶ PREAUTH ──▶ AUTHENTICATING ──▶ BOOTSTRAPPING ──▶ RESOLVING_MODE
  │                                                               │
  │                                  ┌────────────────────────────┘
  │                                  ▼
  │                            RESOLVING_STORE ──▶ CLAIMING_SLOT ──▶ LOADING_CONTEXT
  │                                  │ (no store)                       │
  │                                  ▼                                  ▼
  └─────────────────────────────▶ EMPTY_STATE                       MIGRATING ──▶ SYNCING ──▶ READY
                                  (create/invite)                    (INV-5)      (shell at G1–G3,
                                                                                   INV-7)
ANY ──(hard-auth fail / logout)──▶ LOGGING_OUT ──▶ PREAUTH
ANY ──(force-update / 410 UPGRADE_REQUIRED)──▶ UPGRADE_WALL
```

| State | Action | Exit condition |
|---|---|---|
| INITIAL | Read SecureStore; `GET /time`; `GET /auth/mobile/app-version` | No/expired token → PREAUTH; valid token + snapshot → BOOTSTRAPPING |
| PREAUTH | OTP login (2-stage) | Tokens stored → AUTHENTICATING |
| AUTHENTICATING | Verify tokens; SnapshotManager hydrate from SecureStore | → BOOTSTRAPPING |
| BOOTSTRAPPING | `GET /me/bootstrap`; ingest snapshot (INV-1/8) | → RESOLVING_MODE |
| RESOLVING_MODE | Personal vs business; profile/maintenance gates | Personal → READY; business → RESOLVING_STORE |
| RESOLVING_STORE | `last_opened ?? default ?? stores[0]` cascade (INV-11) | Store found → CLAIMING_SLOT; none → EMPTY_STATE |
| CLAIMING_SLOT | `POST /stores/:id/open` (online) | Granted → LOADING_CONTEXT; 403 → device-limit modal |
| LOADING_CONTEXT | Load store context from `/open` response; abort if stale (INV-2) | → MIGRATING |
| MIGRATING | Run SQLite migrations (INV-5) | → SYNCING |
| SYNCING | Cold-start or delta; G1–G3 in → **READY** (rest background, INV-7) | G1–G3 complete → READY |
| READY | Steady state | Events drive transitions |
| LOGGING_OUT | INV-6 teardown | → PREAUTH |
| UPGRADE_WALL | Block until app updated | — |

---

## 9. Post-Login Flow — Step by Step

```
Step 0 — Pre-auth (stays on native splash A)
  GET /time → ClockService.setOffset(serverNow - deviceNow)
  GET /auth/mobile/app-version → if forceUpdate: show wall; else continue

Step 1 — Login (inline spinner E)
  Stage 1: POST /auth/mobile/login {phone} → OTP sent
  Stage 2: POST /auth/mobile/login {otpCode, device{...}} → tokens
  → Store access_token + refresh_token in SecureStore

Step 2 — Bootstrap (app-shell skeleton C)
  GET /me/bootstrap
  → SnapshotManager.ingest(snapshot, sig)  [INV-1, INV-8]
  → Store to SecureStore; project to Redux
  → Read active_store, active_store_access from response

Step 3 — Mode resolution (instant — in bootstrap response)
  personal → READY on personal home
  business → continue to step 4

Step 4 — Store resolution (instant)
  active_store from bootstrap → use it
  else: last_opened ?? default ?? stores[0] (from snapshot.stores[])
  If none → EMPTY_STATE (create store wizard or accept invitation)

Step 5 — Device slot + store open (POS-shell skeleton C)
  POST /stores/:id/open
  → Read: access, is_new_slot, store_hours, sync_config, subscription, subscription_version
  → SubscriptionManager.ingest(subscription, subscription_version)
  → StoreManager: store context in memory
  → If 403 DEVICE_LIMIT_REACHED: show device-limit modal

Step 6 — SQLite migration (invisible if up-to-date)
  if localSchemaVersion < bundledSchemaVersion: runMigrations() [INV-5]

Step 7 — Sync (B until G1–G3, then D)
  Has sync cursor for this store?
    YES → delta pull (GET /stores/:id/sync/changes?cursor=...)
    NO  → cold start:
            GET /stores/:id/sync/manifest
            Parallel download G1 (4 entities), then G2 (2), then G3 (3) in bounded concurrency
            → UNLOCK POS at G1–G3 complete [INV-7]
            → G4–G5 in D background

Step 8 — Flush mutation queue (push-before-pull)
  If queue has pending mutations:
    POST /stores/:id/sync/delta {mutations: [highest-priority, dep-sorted], cursor: current}
  Apply results locally in same tx [INV-10]

Step 9 — Steady-state (READY)
  Ambient sync chip: Offline | Syncing | Synced (+ pending count)
  RefreshCoordinator polling:
    Every 5–10 min: GET /me/pv → if changed: bootstrap (or pull snapshot when built)
    On foreground: GET /me/subscription/sv → if advanced: GET /me/subscription
  SyncScheduler: delta on foreground, reconnect, manual pull, 30-90s idle timer
```

---

## 10. Sync Implementation Guide

### 10.1 Cold Start (per-store, resumable)

```
1. GET /stores/:id/sync/manifest
   → save schema_version; build entity order list
   → if minimum_client_version > bundled: show upgrade wall

2. For each entity in dependency order (parallel within groups):
   loop:
     GET /stores/:id/sync/initial?entity_type=X&page_cursor=lastCursor
     → BEGIN tx
         upsert rows via entity applier
         if has_more: upsertEntityProgress(store, entity, page_cursor, totalFetched)
         else: markEntityComplete(store, entity)
       COMMIT
     if !has_more: break

3. When all G1-G3 entities complete → emit G1G3_COMPLETE → unlock POS [INV-7]

4. On last entity: persist next_delta_cursor from manifest/initial response into sync_cursors

5. Continue G4-G5 in background
```

**Resumability:** `sync_init_progress` table stores per-entity status + `last_page_cursor`. On crash/restart, `findIncompleteEntity()` returns where to resume.

### 10.2 Delta Pull

```
cursor = getDeltaCursor(storeId)  // null if no cursor yet
GET /stores/:storeId/sync/changes?cursor=${cursor}

response:
  changes: { [entityType]: { upserts: [], deletes: [] } }
  sync_cursor: string  // opaque new cursor
  has_more: boolean

// INV-9: rows + cursor in same tx
BEGIN
  for each entity in changes:
    apply upserts via entity applier
    apply deletes (purge from local table)
  setDeltaCursor(storeId, sync_cursor, tx)
COMMIT

if has_more: repeat immediately
```

### 10.3 Push (Mutation Queue)

```
// Push-before-pull on every sync cycle
mutations = takeAndMarkSending(storeId, maxBatch=50)
  // sorted by (priority DESC, dependency order)

POST /stores/:storeId/sync/delta {
  mutations: mutations,
  cursor: getDeltaCursor(storeId)
}

response.mutation_results:
  for each result:
    if status === 'applied':
      BEGIN
        apply server effect locally
        markApplied(mutationId)
      COMMIT  [INV-10]
    if status === 'rejected':
      markRejected(mutationId, result.code)
      rollback optimistic local change
      show toast with error
    if status === 'conflict':
      markConflict(mutationId)
      route to conflict resolver
    if status === 'duplicate':
      markApplied(mutationId)  // idempotent — already succeeded

// Then apply pull changes from response (same response has delta changes)
if response.sync_cursor:
  BEGIN
    apply response.changes
    setDeltaCursor(storeId, response.sync_cursor, tx)
  COMMIT  [INV-9]
```

### 10.4 Entity Type Names (exact strings)

These must match the backend `entityType` strings exactly:

```
store, unit, store_device_access, payment_method, lookup, taxrate, staff
product, product_case, customer, supplier, paymentaccount
order, order_item, order_payment
shift          (NOT shift_session — backend registers as 'shift')
cash_movement
stock_take, stock_take_line, stock_adjustment, stock_adjustment_line
fifo_cost_layer, stock_history, stock_event
```

### 10.5 Conflict Resolver

On `conflict` result:
1. Mark mutation `conflict` in queue
2. Fetch fresh server row: implied by delta pull (the server row should come back in changes)
3. Present to user: "Your change conflicts with a newer server version"
4. User choices: keep mine (re-queue with new `expected_row_version`) or discard mine

For `takeServer` (auto-resolve):
```
modified_at: serverRow.modified_at ?? serverRow.updated_at ?? new Date().toISOString()
// Note: prefer modified_at (keyset cursor field) over updated_at
```

---

## 11. Freshness Protocol

### 11.1 Two Independent Versions, One Protocol Shape

```
permissionsVersion:  driven by RBAC/role changes; bump = pull GET /me/snapshot (when built) or GET /me/bootstrap
subscriptionVersion: driven by subscription events; bump = pull GET /me/subscription
```

Do **not** collapse into a single global version — that re-couples the domains (a subscription change would invalidate the permission snapshot).

### 11.2 Protocol Pattern (per domain)

```
version header (push on every response)
  → compare to known version
  → if advanced: pull the doc (GET /me/snapshot or GET /me/subscription)
  → if stale/expired: bootstrap (recovery)

+ poll on app resume (GET /me/pv → 304 or bump trigger)
```

### 11.3 Four Delivery Channels for Snapshots

Every channel routes through `SnapshotManager.ingest(snapshot, sig, source)`:

1. **Bootstrap** — `GET /me/bootstrap` response body
2. **Refresh inline** — `POST /auth/refresh` response body (if backend sends snapshot)
3. **`/sync/delta` piggyback** — `POST /stores/:storeId/sync/delta` response `snapshot` field
4. **Header push** — `X-Permission-Version` header → triggers pull of `GET /me/snapshot` (when built)

INV-12: highest version wins regardless of which channel delivered it.

### 11.4 Subscription Freshness

```
On every response:
  X-Subscription-Version header:
    if value > known subscriptionVersion:
      → SubscriptionManager: GET /me/subscription

On app foreground / 5-10 min heartbeat:
  GET /me/subscription/sv
    → 304: no change, stop
    → 200 {subscription_version}: if > known: GET /me/subscription

After payment:
  GET /me/subscription → refresh + if account version changed: GET /me/bootstrap
```

### 11.5 Snapshot Expiry and Generation

- Snapshot expires after **7 days** (check `snapshot.expiresAt` before offline use)
- `snapshot.generation` tracks format version — mismatch → force fresh bootstrap (not a parse error)
- `snapshot.version` tracks content — monotonic; never regress (INV-1)

---

## 12. Device Management Flows

All device operations are **online-only / API-only** — no local tables.

### F1 — First Store Open (initial slot claim)

```
POST /stores/:id/open
  → {access:'granted', is_new_slot: true/false, ...}
  → if is_new_slot: new slot consumed
  → if 403 DEVICE_LIMIT_REACHED: show device-limit modal (GET /stores/:id/devices to list)
```

### F2 — Reopen Offline

```
No network? → skip POST /stores/:id/open
Use prior claim (slot still held until 30-day cron)
Load store context from SQLite (sync entity 'store')
```

### F3 — Store Switch

```
Online:
  POST /stores/:id/open for the new store
  → StoreManager handles slot for old store (release on explicit logout, not on switch)

Offline:
  Switch to cached store (no /open call)
```

### F10B — Logout / Release Slots

```
User-initiated logout:
  for each active store:
    DELETE /stores/:id/access (best-effort; if offline → ignore, cron will reclaim at 30d)
  then full INV-6 teardown

Token-expiry re-auth:
  Keep slots; user is coming back
  Keep SQLite; avoid needless cold sync
```

### F10B.3 — Owner Reclaim (instant)

```
Owner action: POST /stores/:storeId/devices/:deviceGuuid/revoke
→ Slot immediately freed (no 30-day wait)
→ Revoked device gets 403 on next /open attempt
```

### Device Limit UI

Show device-limit modal when `403 DEVICE_LIMIT_REACHED`:
1. `GET /stores/:id/devices` → list active devices
2. User selects device to revoke → `POST /stores/:storeId/devices/:deviceGuuid/revoke`
3. Retry `/open` after revoke

---

## 13. Subscription & Write Gating

### 13.1 Subscription Status Flow

```
account_subscription (server truth)
  ↓ via GET /me/subscription (own account's stores)
  ↓ via snapshot.stores[].subscription (invited stores — hint only)

SubscriptionManager holds:
  status:            'active' | 'trial' | 'grace_period' | 'expired' | 'canceled'
  offline_access_until: timestamp (from subscription.offline_access_until)
  banner_severity:   from subscription.banner.severity ('info'|'warning'|'critical'|'blocked')
  subscription_version: monotonic guard
```

### 13.2 Banner Rules

| Severity | When | Show |
|---|---|---|
| `info` | Trial running normally | Subtle info banner with days remaining |
| `warning` | Grace period or trial ending <7d | Yellow banner "subscription ending soon" |
| `critical` | Lapsed but within `offline_access_until` | Red banner "renew to keep selling" |
| `blocked` | Past `offline_access_until` | Modal or wall — writes completely blocked |
| None | Active + healthy | No banner |

### 13.3 Write Gate

```
Before any POS write:
  if now() >= accessValidUntil:
    block write, show renewal CTA
    return

Before enqueue in SyncEngine:
  SubscriptionManager.canWrite(storeId) must return true

Server double-check:
  POST /sync/delta → SUBSCRIPTION_LAPSED_AT_WRITE for mutations where
  clientModifiedAt > accessValidUntil (belt-and-suspenders)
```

### 13.4 Subscription Screens (all online-only)

| Screen | Data source | Trigger |
|---|---|---|
| Current subscription | `GET /me/subscription` (live) | Screen open |
| Subscription plans | `GET /subscription/plans` (24h MMKV cache) | Upgrade/billing screen |
| Checkout | `POST /stores/:id/subscription/checkout` | User confirms plan |
| Billing history | `GET /me/subscription/history` | History screen open |
| Cancel | `DELETE /me/subscription` or `POST /me/subscription/cancel` | Cancel flow |
| Reactivate | `POST /me/subscription/reactivate` | Reactivate flow |

---

## 14. RBAC & Permission Gating

### 14.1 How Permissions Work

```
snapshot.stores[storeId].permissions  (in-memory from SecureStore)
  ↓
PermissionGate.canCreate(entity)
PermissionGate.canEdit(entity)
PermissionGate.canDelete(entity)
PermissionGate.canPerform(actionCode)
```

Never call the API for permission checks — pure in-memory read.

### 14.2 Offline Optimism

If a user's permission is revoked while they're offline:
1. Local `PermissionGate` still says "allowed" (off cached snapshot)
2. Mutation enters queue and pushes to server
3. Server returns `403 / PERMISSION_DENIED` in `mutation_results`
4. SyncEngine: rollback optimistic change, show toast "Permission denied"
5. Pull fresh snapshot (triggered by `X-Permission-Version` bump on the server response)

### 14.3 Snapshot Delivery to PermissionGate

```
SnapshotChanged event (from SnapshotManager)
  → PermissionGate re-derives from new frozen snapshot for activeStoreId
  → StoreManager checks INV-4 (active store still in snapshot?)
  → UI subscribers re-render gated UI
```

### 14.4 Store-Scoped vs Account-Wide Permissions

- Permissions are **per-store** — each store in `snapshot.stores[]` has its own `permissions` object
- Account-level actions (subscription, billing) are not in the snapshot — use subscription status
- Invited stores: permissions come from `snapshot.stores[invitedStoreId].permissions`

---

## 15. Implementation Phases

### Phase A — 🟢 POS Mutation Handlers (ALREADY BUILT — verified)

All order/shift/payment/cash-movement mutation handlers exist. Offline checkout CAN push.

**Entity type strings to use in mutations:**
- `order`, `order_item`, `order_payment`
- `shift` (not `shift_session`)
- `cash_movement`

### Phase 0 — Prerequisite Fixes

| Task | Status | Mobile impact |
|---|---|---|
| Sync rate limiter per `(userId, storeId)` | ✅ Done | Multi-store sync safe |
| Bootstrap returns `active_store {id, guuid}` | ✅ Done | Stop re-deriving active store |
| Decouple `force_bootstrap`/`store_access_changed` from `snapshotChanged` | ❌ Not done | Redundant bootstraps on session refresh |

### Phase 1 — Core Sync + Auth (implement now)

Mobile must implement:
1. **AuthService** — OTP login, single-flight refresh (INV-3), SecureStore token management
2. **SnapshotManager** — Ed25519 verify, monotonic guard (INV-1), atomic swap (INV-8)
3. **ClockService** — offset from `x-server-time`; `ClockService.now()` for all validated timestamps
4. **HttpClient pipeline** — Bearer, nonce, retry, 401-refresh-replay, clock-feed
5. **SQLite migrations** (INV-5) — run before any sync
6. **Cold-start sync** — manifest → parallel G1-G3 → unlock POS [INV-7] → G4-G5 background
7. **Mutation queue** — priority tiers, topoSort, push-before-pull, INV-10

### Phase 2 — Store Management + Freshness (implement next)

1. **StoreManager** — `/open` merged call, latest-only context (INV-2), teardown (INV-4)
2. **SyncEngine** — delta pull + push, INV-9, conflict handling, DLQ
3. **RefreshCoordinator** — pv heartbeat, subscription freshness, coalescing
4. **SubscriptionManager** — write gate, banner, `canWrite()`, version guard
5. **PermissionGate** — read-only over frozen snapshot, re-derive on SnapshotChanged

### Phase 3 — Multi-Store + Offline Polish

1. **SyncScheduler** — network/battery/foreground policy; push-before-pull on reconnect
2. **Store switch** — instant for cached, scoped loading for uncached, INV-2 abort
3. **Ambient sync chip** — Offline / Syncing / Synced + pending count
4. **Conflict resolver** — present to user, re-queue or discard

### Phase 4 — Device Management Screens (online-only)

1. Device list screen → `GET /stores/:id/devices`
2. Revoke/block/unblock flows
3. Device-limit modal on `/open` → 403 DEVICE_LIMIT_REACHED
4. "My devices" profile section → `GET /devices/my`

### Phase 5 — Subscription Screens (online-only)

1. Subscription status screen → `GET /me/subscription`
2. Plans catalog → `GET /subscription/plans`
3. Checkout flow → `POST /stores/:id/subscription/checkout`
4. Cancel / reactivate flows
5. Billing history

### Phase 6 — Manifest + Parallel Cold Start

When `GET /stores/:id/sync/manifest` is adopted:
1. Fetch manifest → build parallel download plan
2. Bounded concurrency 3–4 parallel entity fetchers
3. Buffer + apply in dependency order (parallel fetch, ordered insert)
4. Progress bar from manifest `estimated_count` fields
5. Respect 429 + `Retry-After`

### Testing Scenarios (must pass before ship)

| Scenario | Validates |
|---|---|
| Permission revoke → re-gate in one request cycle | Ph2 |
| Subscription lapse via cron → version advance → writes blocked | Ph1+2 |
| Multi-store cold start → no 429 / no cross-store throttle | Ph0/6 |
| Crash mid cold-start → resume from correct entity+cursor | Ph1 |
| Crash mid delta apply → no duplicate rows, no skipped rows | Ph1 (INV-9) |
| Crash between mark-applied and local effect → no lost mutation | Ph1 (INV-10) |
| Two concurrent refreshes → one succeeds, one awaits, no double rotation | Ph1 (INV-3) |
| Bootstrap v10 arrives after refresh v11 → v11 stands | Ph2 (INV-1/12) |
| Revoked invited store in last_opened → land on default | Ph2 (INV-4/11) |
| Subscription lapsed during offline session → SUBSCRIPTION_LAPSED_AT_WRITE on reconnect | Ph2+5 |
| Device limit on /open → modal → revoke → retry succeeds | Ph4 |

---

## 16. Known Backend Contract Issues

Issues to resolve with the backend before mobile implementation:

### Issue 1 — `GET /me/subscription` field shape mismatch

**PRD expects:**
```json
{
  "subscription_version": 5,
  "access_valid_until": "2026-12-31T00:00:00Z",
  "banner_severity": "warning"
}
```

**Backend actually returns:**
```json
{
  "subscription_version": 5,
  "subscription": {
    "offline_access_until": "2026-12-31T00:00:00Z",
    "banner": { "severity": "warning" }
  }
}
```

**Mobile action:** Read `response.subscription.offline_access_until` and `response.subscription.banner.severity`. Or request backend to flatten.

### Issue 2 — Sync routes are store-scoped

PRD uses `/sync/changes` and `/sync/delta` as shorthand, but actual routes are:
- `GET /stores/:storeId/sync/changes`
- `POST /stores/:storeId/sync/delta`

**Mobile action:** Always include `storeId` in sync route construction.

### Issue 3 — `/access` vs `/open` field name mismatch

- `POST /stores/:id/access` returns `isNew` (camelCase)
- `POST /stores/:id/open` returns `is_new_slot` (snake_case)

**Mobile action:** Use `/open` as the primary path (preferred). Only call `/access` directly in legacy scenarios. Handle both field names.

### Issue 4 — POS entity type is `shift` not `shift_session`

The mutation handler registers as entityType `'shift'`. The local table name may be `shift_session` in the schema but the wire entity type string is `'shift'`.

**Mobile action:** Use `'shift'` as the `entity_type` in all mutation queue entries for shift-session records.

### Issue 5 — `GET /me/pv` not yet built (warm-open endpoint)

Warm launch (cached snapshot → 304) requires `GET /me/pv` with ETag support. Not yet built.

**Mobile action:** Until built, use `GET /me/bootstrap` with a 5-minute debounce on foreground. This is correct but slower than the PRD's warm-launch path.

---

## Quick Reference — What Not to Do

| Don't | Do instead |
|---|---|
| Call `Date.now()` for a server-validated timestamp | Call `ClockService.now()` |
| Gate writes off `snapshot.stores[].subscription` | Call `SubscriptionManager.canWrite()` which reads `/me/subscription` |
| Store signed media URLs in SQLite | Fetch lazily on render; they expire |
| Call `GET /stores/mine` for the store list | Use `snapshot.stores[]` |
| Show full-screen spinner on store switch | Instant for cached; scoped content-area for un-cached |
| Advance the cursor before persisting rows | Persist rows + cursor in same SQLite tx (INV-9) |
| Mark a mutation applied before writing its local effect | Write effect + mark in same SQLite tx (INV-10) |
| Trigger freshness from a screen | Let RefreshCoordinator handle it |
| Access SecureStore from a Redux reducer | Go through AuthService / SnapshotManager |
| Parse or inspect the sync cursor | It's opaque — round-trip verbatim |
| Block POS to 100% cold sync | Unlock at G1–G3; background G4–G5 (INV-7) |
| Use `shift_session` as the mutation entity type | Use `shift` |
| Show full-screen blocking for steady-state delta | D ambient chip only |
