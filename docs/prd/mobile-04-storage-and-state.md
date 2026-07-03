# Mobile Architecture · Part 4 — Storage, State Domains & API Layering

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 5. Storage map

| Data | Where | Why |
|---|---|---|
| access + refresh tokens | **SecureStore** (Keychain/Keystore) | credentials; never SQLite/AsyncStorage |
| signed snapshot + signature + `snapshot.version` | **SecureStore**, hydrate to **memory/Redux** on launch | signed auth document (few KB); verify Ed25519 sig vs bundled public key before trust; gate off the in-memory copy |
| subscription status | rides **inside the snapshot** (SecureStore + memory) | it's `snapshot.stores[].subscription` |
| entity data (catalog, customers, orders, shifts, stock…) | **SQLite** | not auth |
| sync cursors, `lastPvCheckAt` | SQLite / MMKV | non-sensitive |

**Rules:** never gate off SQLite; never trust an unverified snapshot; always verify
`snapshot.expiresAt` (7d) before using it offline.

---

## 8C. Storage classification — local SQLite vs SecureStore vs API call

> **Full table-by-table catalog:** [mobile-10 Local Database & Storage Tiering](./mobile-10-local-database-schema.md)
> — every synced table, client-only bookkeeping table, draft, and the API-only (never-local) list with
> reasoning. This section is the summary; mobile-10 is the complete reference.

Decision rule:
- **Has a sync filter?** → local **SQLite**, partitioned by `store_fk`, kept fresh by sync.
- **Auth credential** (token / signed snapshot)? → **SecureStore** + in-memory. Never SQLite.
- **Everything else** (rare / must-be-fresh / signed-expiring URL) → **API call on demand,
  don't persist**.

### 8C.1 Local SQLite — the 21 synced entities (offline-first)
Source of truth: `SyncFilterRegistry` (dependency order in parentheses).

**Reference / config — pull-only (read offline, can't edit offline):**
`store`(0), `unit`(2), `store_device_access`(2), `payment_method`(5), `lookup`(5),
`taxrate`(6), `staff`(8)

**Catalog / master data — ✅ writable offline (have mutation handlers, push via `/sync/delta`):**
`product`(10) (+ `product_case`), `paymentaccount`(15), `customer`(20), `supplier`(21),
`lookup`(5)

**Transactional — synced into local tables:**
`order`(30), `order_item`(31), `shift`(40), `stock_take`(70), `stock_take_line`(71),
`stock_adjustment`(72), `stock_adjustment_line`(73), `fifo_cost_layer`(74),
`stock_history`(75), `stock_event`(76)

> **Confirmed writable set = `product`, `customer`, `supplier`, `paymentaccount`, `lookup`
> only.** No `order` / `shift` / stock mutation handler exists — pushing a sale/shift via
> `/sync/delta` would return `rejected: UNKNOWN_MUTATION`. **GAP** to resolve before
> building offline checkout. (`modules/sync/services/mutation-handler-registry.service.ts`;
> handler files only under product/customer/supplier/payment-account/lookup.)

### 8C.2 Local SQLite — sync bookkeeping tables the client must keep
- **delta cursor per store** (one row per `store_fk`)
- **cold-start state per store** (entities completed / persisted `next_delta_cursor`)
- **outbound mutation queue** — `mutation_id` (ULID = idempotency key), `entity_type`,
  `action`, `payload`, `expected_row_version`, `client_modified_at`, **`priority`**, **`attempts`**,
  **`next_attempt_at`**, status (`pending` / `inflight` / `applied` / `rejected` / `conflict` / `dead`)
- **tombstones** — apply `deletes[]` from `/sync/changes` to purge local rows

### 8C.2a Mutation queue — priority, backoff & dead-letter (resilience)

The queue is **not a flat FIFO** — on a poor connection, **revenue must sync first** and a single
poison mutation must not block everything behind it.

**Priority tiers** (drained high → low; **but FK/dependency order wins within a tier**):
```
HIGH    order · order_item · order_payment · refund        (revenue — never starve)
MEDIUM  shift_session · cash_movement · stock_* · inventory
LOW     audit · analytics · telemetry · device last_accessed_at
```
- **Dependency order is non-negotiable inside a batch:** `order_item` can never push before its
  `order` (cascade via `parent_guuid`), and a write can't reference a row the server lacks. Since
  **reference data is pull-only** (read-only on the client), write-side priority is safe: revenue
  jumps the queue, audit/analytics wait.
- A `/sync/delta` batch is assembled **highest-priority-first, then dependency-sorted**.

**Backoff** (per mutation, on transient failure / 5xx / network):
```
attempts 1..N → next_attempt_at = now + min(2^attempts · base, cap)   (exponential, jittered)
honor server Retry-After (429) over the local curve
```

**Dead-letter (poison-mutation isolation):**
```
attempts > MAX (e.g. 7)  → status='dead'  → move OUT of the active queue
                          → surface in a "needs attention" list for the owner
                          → the rest of the queue keeps flowing (one bad sale never blocks the day)
```
- `rejected` (server `4xx` business error, e.g. `PERMISSION_DENIED` / `SHIFT_NOT_OPEN`) → **do not
  retry**; roll back the optimistic change + notify (it's a logic failure, not transient).
- `conflict` (stale `row_version`) → resolve via `/sync/conflicts`, then re-queue.
- `dead` rows are retained for audit; the owner can retry or discard from the attention list.

> Net: **sales always go first; transient failures back off; poison mutations are quarantined**
> instead of stalling the queue.

### 8C.3 SecureStore (NOT SQLite) — credentials & auth
- access token + refresh token
- **signed permission snapshot + signature + `snapshot.version`** (carries all stores'
  permissions + per-store subscription). Verify the Ed25519 signature against the bundled
  public key, then hydrate into **memory/Redux** for gating.
- Rule: gate off the **in-memory** snapshot; durable copy in SecureStore; never gate off
  SQLite; never trust an unverified snapshot.

### 8C.4 API call on demand — live, do NOT persist as data
| Need | Call | When |
|---|---|---|
| permission-change check | `GET /me/pv` (ETag→304) | foreground / screen-focus |
| full auth context refresh | `GET /me/bootstrap` | first login, pv changed, snapshot expired |
| token rotation | `POST /auth/refresh` | near 1h expiry / on `401 token_expired` |
| invitations list | `GET /me/invitations` (recommended) | invitations screen only |
| store hours | bootstrap today / `GET /stores/:id/context` | on store open (not a sync entity) |
| signed media URLs (logo, profile image, attachments) | attachment endpoints | **lazily on render** — they **expire**; never store the URL in SQLite |
| subscription plans catalogue | `GET /subscription/plans` | billing screen |
| subscription status re-check | `GET /me/subscription` (Hybrid; own stores) | after `402` / after payment |
| device list | `GET /stores/:id/devices` | device-management screen |
| claim device slot | `POST /stores/:id/access` | each time a store is opened |
| app version / force-update | `GET /auth/mobile/app-version` | app start (pre-auth) |
| server clock | `x-server-time` header (or `GET /time`) | every response / pre-auth |
| sync conflicts | `GET /sync/conflicts` | when a mutation returns `conflict` |

> Trap: **never cache signed media URLs or permission/subscription state in SQLite** —
> URLs expire, and auth state must come from the verified snapshot (memory), not a stale
> local copy.

---

## 8E. Client state domains & API layering

### 8E.1 Client state — split into dedicated domains (not one Redux blob)
Don't keep permissions/subscription/profile/user/store/context in one slice. Split by domain
so each has its own lifecycle, persistence, and freshness rules:
```
Auth Store     tokens, session, signed snapshot (+version)        → SecureStore + memory
User Store     profile, preferences                               → memory (bootstrap-fed)
Store Store    active store, device access, store context, hours  → memory (per-store)
Subscription   account status + account subscriptionVersion (own  → memory (own freshness, §7)
               stores); invited stores ride snapshot.stores[].subscription
Sync Store     per-store cursor, mutation queue, sync status       → SQLite + memory
SQLite         the 21 synced entities (per store_fk)               → SQLite
```
Why: auth refreshes on `permissionVersion`, subscription on `subscriptionVersion`, entities via
sync cursors, preferences rarely — different cadences. One blob couples them; domains scale.

### 8E.2 API layering (domain map)
```
Auth      /auth/login  /auth/refresh  /auth/challenge  /auth/step-up  /me/pv  /me/snapshot
Profile   /me  /me/preferences  /me/account-mode  /me/invitations  /me/devices
Store     /stores  /stores/:id/open  /stores/:id/context  /stores/:id/hours  /stores/:id/devices
Sync      /stores/:id/sync/manifest  /sync/initial  /sync/changes  /sync/delta  /sync/conflicts
Billing   /subscription/plans  /me/subscription(+/sv +/cancel +/reactivate)  ❌/me/subscription/checkout|verify(store-scoped only)  (account-level; checkout=store-scoped /stores/:id/subscription/checkout|verify)
```
Keep client API modules aligned to these domains (one module per row) so the freshness protocol
and storage tier for each are obvious at the call site.
