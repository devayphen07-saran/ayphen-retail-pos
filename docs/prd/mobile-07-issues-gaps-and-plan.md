# Mobile Architecture · Part 7 — Issues, GAPs, Implementation Plan & End-State

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 9. Issues & fixes (prioritized)

### P0 — bugs
1. **Bootstrap recomputes everything every open** (N+1 signed URLs + invitations join
   + hours; no caching) → slow open. **Fix:** `/me/pv`-gated warm open + ETag/304 +
   re-tier (§3c). `bootstrap.service.ts:331-459`.
2. ✅ **FIXED — Sync rate limiters are now per-`(userId, storeId)`** (verified api-reference §5).
   `SyncRateLimitGuard` keys `sync_rate_limit:{userId}:{storeId}:{endpoint}`;
   `checkMutationRateLimit` keys `sync_mutations:{userId}:{storeId}`. `/sync/pull` was a stale
   comment, not a live route. Multi-store sync no longer shares a budget.
3. **`force_bootstrap`/`store_access_changed` = `snapshotChanged`** → redundant
   bootstraps + over-invalidation. **Fix:** decouple (§3b).
4. **No server-side open-shift enforcement** — `shift_not_open` defined but never
   thrown; `order.shiftSessionFk` nullable. **Fix:** validate open-shift **in the order
   mutation handler** (domain logic at apply time, not the generic `/sync/delta` preflight) when
   the store's `enforce_open_shift_before_sale` is on (shifts PRD §12, backend plan WS-A).

### P1 — tiering / flow
5. Move `store_logos`, `store_hours`, `pending_invitations` out of bootstrap (§3c).
6. Drop `sync_config`, `app_config`, top-level `subscription`, `server_time` from
   bootstrap; remove `server_time` from all bodies.
7. `GET /stores/mine` is **owner-only** — never use as the store list; use
   `snapshot.stores[]` (`store.controller.ts:73`).
8. Post-login is 4+ sequential round trips — fold device-slot + context into bootstrap;
   expose `active_store_id` + a single `POST /me/active-store` writer.
8a. **Active-store resolution** — the "skips `default`" bug is **already fixed** in current code
   (`bootstrap.service.ts:362-381` uses the membership-checked `last_opened ?? default ?? stores[0]`
   cascade). **Done:** `active_store: {id, guuid} | null` and `active_store_access` are now returned ✅ (api-reference §2). Remaining: make it locked-aware once `store.locked` lands (§8B.4).
9. Client **single-flight refresh** (reuse one `idempotencyKey`) or concurrent refresh
   trips `refresh_reuse_detected` → full session kill.

### P2 — smaller
10. Stale "15 min" access-TTL comments (actual 1h).
11. `x-device-id`/`x-device-sig` headers defined but never read — wire or delete.
12. Confirm `category` syncs (no `category` filter exists).
13. Trim tombstone `deleted_by_*`; batch small initial-sync entities.

---

## 10. GAPs (backend doesn't support today)

- **🔴 #1 PRIORITY — No `order`/`shift`/`payment`/stock/`cash-drawer` mutation handler.**
  Only product/customer/supplier/paymentaccount/lookup are writable via `/sync/delta`; pushing
  a sale/shift/cash-movement returns `rejected: UNKNOWN_MUTATION` (§8C.1). **Offline checkout
  literally cannot work until these are added** — this is the single highest-priority backend
  gap; everything else is optimization.
- ✅ **BUILT — Subscription freshness signal exists.** `GET /me/subscription` returns `subscription_version` + `access_valid_until`; every response sets `X-Subscription-Version` header; `GET /me/subscription/sv` is the cheap ETag poll. Verified api-reference §6.
- ✅ **BUILT — Account-level subscription.** `user_subscription` table + `GET /me/subscription` + cancel + reactivate exist. `max_stores` gate is in the store-create service. Checkout/verify remain store-scoped (`/stores/:id/subscription/checkout|verify`). Verified api-reference §6.
- ✅ **BUILT — `POST /stores/:id/open`** merges access + context + subscription + warnings into one call. Verified api-reference §3.
- **No shift / sale / cash-session REST API** — all via sync; no server enforcement of
  the shift lifecycle.
- ✅ **BUILT — `GET /me/subscription`** is the current subscription endpoint with version + `access_valid_until`. Verified api-reference §6.
- **No `426`/maintenance middleware** — `503` is the de-facto retry signal; force-update
  is voluntary polling of `/auth/mobile/app-version`.

---

## 11. Implementation plan (v2 architecture)

**Guiding constraints:** (a) mobile can't force-update instantly → every backend change is
**additive first** (add new field/header/endpoint, keep old, gate by app version, remove old
after adoption); (b) three load-bearing caveats — `subscriptionVersion` is **account-level**
(Hybrid — see [subscription.md](./subscription.md), the authoritative model), **time-based**
subscription transitions need a **cron**, client applies versions **monotonically** (never
downgrade); (c) feature-flag each phase in `system_config`.

### Phase 0 — Prerequisite bug fixes (no flag; unblock later phases)
- **0.1 Sync rate limiter** — ✅ **FIXED** (verified api-reference §5). Both limiters are per-`(userId, storeId)`. `/sync/pull` was a dead path. Phase 6 is unblocked from this dependency.
- **0.2 Active-store object** — ✅ **DONE.** `BootstrapResponseDto` already ships `active_store: {id, guuid} | null` and `active_store_access`. Verified in api-reference §2.
- **0.3 `force_bootstrap`/`store_access_changed`** (`mobile-auth.mapper.ts:78-79`): decouple
  from `snapshotChanged` (superseded by Phase 2, but stop redundant bootstraps now).

### Phase 1 — Separate Subscription from the Permission Snapshot (account-level, Hybrid)
**Backend:** introduce the account-level `user_subscription` + `max_stores` (Hybrid —
[subscription.md §2/§27](./subscription.md)); add an **account-level `subscription_version`**
(migrate, backfill 1); bump it **in the same tx** as every status change in
`subscription.service.ts` (+ keep `invalidateAccessCache`); add a **cron** to bump it at
`trial_ends_at`/`current_period_end` (time-based caveat); new **`GET /me/subscription`** (payload
+ version + `access_valid_until`) and **`GET /me/sv`** (cheap version, ETag). Keep the per-store
`snapshot.stores[].subscription` field — it now carries **each store-owner's** account-plan status
(so invited stores still get their owner's status via the snapshot).
**Client:** dedicated subscription slice; for **own stores** read from `/me/subscription` (not the
snapshot); for **invited stores** read `snapshot.stores[].subscription`; gate POS writes off
`status` + `banner_severity` + `access_valid_until` (see [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)).

### Phase 2 — Unified version-header freshness (consolidation)
**Backend:** repurpose `snapshot-refresh.interceptor.ts` to emit tiny headers on **every**
response — `x-permission-version`, `x-subscription-version` — instead of the full
`X-Permission-Snapshot`; add `GET /me/snapshot` (signed snapshot + sig); stop inlining the
snapshot in `/auth/refresh` and `/sync/delta` bodies (gated); deprecate the full-snapshot header.
**Client (one freshness module):** on every response compare versions → pull `GET /me/snapshot`
or `GET /me/subscription` only when advanced; `/me/pv`(+sv) on resume; **bootstrap only**
for first login / expired snapshot (7d) / schema change / recovery.
> Pattern per domain: **version header (push) + poll (resume) + pull-on-change + bootstrap
> (recovery).** Don't push multi-KB snapshots in headers/bodies — push the version, pull the doc.
>
> **One protocol, NOT one version.** Do **not** collapse permissions + subscription into a
> single global `stateVersion` — that re-couples the two domains (a subscription change would
> invalidate the permission snapshot, undoing Phase 1). Keep **two independent counters**
> (`permissionVersion` + `subscriptionVersion`), each with its own ETag, both driven by the
> **same** version-header → pull-on-change pattern. Preferences need no version (low-stakes,
> returned in bootstrap, client-written). So: two versions, one protocol shape.

### Phase 3 — Lean bootstrap + warm-open
**Backend:** remove `store_logos`, `store_hours`, `pending_invitations[]`, `sync_config`,
`app_config`, top-level `subscription`, `server_time` (gated); add `has_pending_invitations`
**and server-resolved `active_store {id, guuid}`** (§3c — client stops re-deriving it); lazy
endpoints (`GET /me/invitations`, attachment URLs, `GET /stores/:id/hours`); ETag bootstrap
on `(permissionsVersion + preferences hash)` → 304.
**Client:** warm resume = `/me/pv` → 304 → render from cache, skip bootstrap; fetch the rest lazily.

### Phase 4 — Merge store open — ✅ BUILT
`POST /stores/:id/open` exists and returns access result, store hours, `sync_config`,
subscription (+ version), and warnings in one response (verified api-reference §3).
Both `POST /stores/:id/access` and `GET /stores/:id/context` still exist as the legacy two-call path.
**Client:** adopt `/open`; offline reopen skips it and uses cached context.
> Device allowance (`deviceAllowed`/`remaining`) belongs **here**, not in bootstrap — it is
> **per-store**, and putting per-store slot computation into the per-user bootstrap re-bloats it
> (conflicts with Phase 3). `/open` already returns it in one round trip.

### Phase 5 — Transactional / monotonic snapshot apply (client only)
- **Durable-write-first:** verify sig → write SecureStore → project to memory/Redux; always
  hydrate from SecureStore on launch.
- **Monotonic guard:** drop any snapshot/subscription whose version ≤ current (out-of-order
  responses across channels).
- **Single-flight** the pull; coalesce concurrent triggers.

### Phase 6 — Manifest + parallel initial sync (last; needs Phase 0.1)
**Backend:** `GET /stores/:id/sync/manifest` → `{entity:{estimated_count, initial_cursor}}` +
`schema_version`; allow parallel `/sync/initial` across entities under the per-store budget.
**Client:** bounded-concurrency (3–4) parallel downloaders; **buffer + apply in dependency order**
(parallel fetch, ordered insert); progress bar from manifest counts; respect 429/`Retry-After`.

**Dependency groups (parallel within a group, sequential between groups):**
```
Group 1 (reference)  store, unit, taxrate, payment_method, lookup, store_device_access
Group 2 (parties)    customer, supplier            (independent of products → may overlap G3)
Group 3 (catalog)    product (+ product_case), paymentaccount
Group 4 (inventory)  stock_take(+line), stock_adjustment(+line), fifo_cost_layer, stock_history, stock_event
Group 5 (txn)        order, order_item, shift
```
Far fewer round trips than the 21-entity sequential loop; each group's entities download in
parallel, groups gate on the prior group's FKs.

### Testing & rollout (per phase)
Flag in `system_config` → internal builds → ramp by app version → remove deprecated fields after
adoption. Lock wire shapes in `libs-common/shared-types`. Scenario tests that must pass:
permission revoke → re-gate in one request (Ph2); subscription lapse via webhook **and** trial-end
cron → version advances, writes blocked (Ph1+5); multi-store cold start → no 429/cross-store
throttle (Ph0.1/6); crash mid-apply → consistent + stale version dropped (Ph5); revoked invited
`last_opened` → lands on `default` (Ph0.2).

### Phase A — 🔴 Mutation handlers for `order`/`shift`/`payment`/stock/`cash-drawer` (highest priority)
Independent backend feature (no freshness coupling) → **run in parallel with everything**.
Register create/update/delete `MutationHandler`s for the POS write entities in
`mutation-handler-registry.service.ts`, enforce open-shift + subscription at apply time (§9 #4),
and make sale-order `shiftSessionFk` NOT NULL. **Until this ships, offline checkout cannot push.**

### Sequencing
**Phase A (start now, parallel — it's the only thing that unblocks offline POS)** ‖
Phase 0 (now) → Phase 1+2 (core win) → Phase 3+4 (latency) → Phase 5 (alongside 2) → Phase 6 (last).

---

## 12. The confirmed correct end-state

- **Snapshot is the single auth/RBAC/subscription truth**, delivered via bootstrap
  (rare) + refresh/delta (piggyback) + response header (push). Stored signed in
  SecureStore, hydrated to memory, gated optimistically, enforced authoritatively by
  the server.
- **Entity data via sync only** (SQLite). Store hours + logo-ids move onto the synced
  `store` entity → store switch becomes zero-network.
- **On-demand separate calls:** invitations, signed media URLs, subscription re-check.
- **Multi-store offline:** one snapshot covers all stores (permission switch is
  zero-network); per-store cursors + SQLite partitions + device slots let the last N
  stores work offline; pre-sync them in the background. Fix the per-user rate limiter to
  per-`(userId, storeId)` so stores don't throttle each other.
- **Warm open = `GET /me/pv` (→304)**, render from cache, no full bootstrap.
- **Permissions reconcile automatically** on the next request (version header → pull-on-change).
- **Subscription is its own domain** — separate `subscriptionVersion`, **two independent
  versions, one shared protocol** (never a single global `stateVersion`, which would re-couple
  them).
- **Bootstrap returns server-resolved `active_store {id, guuid}`** — the client stops
  re-deriving it and only re-resolves on invalidation.
- **Client state is split into domains** (Auth / User / Store / Subscription / Sync + SQLite),
  each with its own freshness cadence (§8E).
- **Highest-priority backend gap:** mutation handlers for `order`/`shift`/`payment`/stock — without
  them offline checkout cannot push (§10 #1, §11 Phase A).
- **Clock via `x-server-time` header only.**
