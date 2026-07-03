# Mobile Architecture · Part 9 — Client Services & Concurrency Invariants

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.
> The other parts are organized **by flow**; this part is organized **by service module** — the
> client-side backbone that *owns* those flows — plus the hard **concurrency invariants** every service
> must uphold. If a flow doc says *what* happens, this doc says *which module owns it* and *what must
> never race*.
> **Status:** 🆕 architecture spec (no backend change). 🔴 = correctness invariant (a bug here corrupts
> state or leaks permissions).

---

## Table of contents
1. [Why a service catalog](#1-why-a-service-catalog)
2. [The service catalog](#2-the-service-catalog)
3. [Ownership map & sole-owner rules](#3-ownership-map--sole-owner-rules)
4. [🔴 Concurrency & durability invariants](#4--concurrency--durability-invariants)
   - [INV-1 Monotonic snapshot version guard](#inv-1--monotonic-snapshot-version-guard)
   - [INV-2 Latest-only context commit](#inv-2--latest-only-context-commit)
   - [INV-3 Single-flight refresh](#inv-3--single-flight-refresh)
   - [INV-4 Active-store-removed teardown](#inv-4--active-store-removed-teardown)
   - [INV-5 Migrate-before-sync](#inv-5--migrate-before-sync)
   - [INV-6 Logout lifecycle](#inv-6--logout-lifecycle)
   - [INV-7 Unlock-on-minimum, sync-in-background](#inv-7--unlock-on-minimum-sync-in-background)
   - [INV-8 Atomic + storage-transactional snapshot swap](#inv-8--atomic--storage-transactional-snapshot-swap)
   - [INV-9 Cursor advances only after commit](#inv-9--cursor-advances-only-after-commit) 🔴 durability
   - [INV-10 Queue commit ordering](#inv-10--queue-commit-ordering) 🔴 durability
   - [INV-11 Exactly-one (or no) active store](#inv-11--exactly-one-or-no-active-store)
   - [INV-12 Freshness precedence — version wins, transport-independent](#inv-12--freshness-precedence)
5. [Startup state machine](#5-startup-state-machine)
6. [Store-open state machine](#6-store-open-state-machine)
7. [Failure-policy matrix](#7-failure-policy-matrix)
8. [Background-task / app-lifecycle policy](#8-background-task--app-lifecycle-policy)
9. [Event catalog (typed event bus)](#9-event-catalog-typed-event-bus)
10. [Snapshot generations](#10-snapshot-generations)
11. [Telemetry & sync metrics](#11-telemetry--sync-metrics)
12. [End-to-end lifecycle sequence](#12-end-to-end-lifecycle-sequence)
13. [Service interaction sequences](#13-service-interaction-sequences)
14. [Invariant ↔ service matrix](#14-invariant--service-matrix)

---

## 1. Why a service catalog

Flows cut across modules: a single store-switch touches auth (token still valid?), the snapshot (perms
for the new store), the clock (timestamp the `/access` call), the store manager (context), and the sync
engine (cursors). If every screen wires these ad-hoc, you get the production races in §4. The fix is
**one owner per concern**, with explicit boundaries. **Eleven modules** own the entire client — eight
domain services plus three foundational layers (HttpClient, SyncScheduler, Repositories) — coordinated by
a top-level **AppLifecycle** orchestrator (§5). Dependencies point **one direction only** (top → down); a
lower layer never reaches up.

**Layering (top calls down only):**
```
AppLifecycle  (orchestrator — owns the startup state machine §5; wires the rest)
   │
   ▼
UI / screens
   │  (read selectors, dispatch intents — never fetch / never touch SQLite/SecureStore directly)
   ▼
SubscriptionManager   StoreManager   PermissionGate
   │                      │              │
   └──────────┬───────────┴──────┬───────┘
              ▼                   ▼
        RefreshCoordinator   SyncEngine ──▶ SyncScheduler (decides WHEN; engine EXECUTES)
              │                   │
              ▼                   ▼
        SnapshotManager      Repositories ──▶ SQLite + mutation queue
              │                   │
              ▼                   ▼
        AuthService ─── ClockService ─── HttpClient (retry · auth · nonce · clock · tracing pipeline)
              │                                  │
              ▼                                  ▼
        SecureStore                           network
```
All cross-module signalling goes over the **typed event bus** (§9), not direct method calls, except the
synchronous read paths (e.g. `PermissionGate.canCreate()`, `ClockService.now()`).

---

## 2. The service catalog

### 2.1 AuthService 🔴
**Owns:** OTP login (2-stage), token storage, **token refresh (single-flight, INV-3)**, logout teardown
(INV-6).
- Sole writer of tokens in SecureStore; sole caller of `/auth/refresh`.
- Exposes `getValidAccessToken()` → returns the live token or awaits the **one** in-flight refresh.
- Knows nothing about permissions or stores — it only proves *who* and keeps the session alive.
- Refs: [mobile-01 §1](./mobile-01-auth-and-snapshot.md), backend [`refresh-idempotency.service.ts`](../../apps/api/src/auth/mobile/services/refresh-idempotency.service.ts).

### 2.2 SnapshotManager 🔴
**Owns:** signature verification, **version comparison (INV-1)**, **atomic swap (INV-8)**, SecureStore
persistence of the snapshot.
- Single entry point `ingest(snapshot, sig, source)` used by **all four delivery channels** (bootstrap,
  refresh inline, `/sync/delta` piggyback, `X-Permission-Snapshot` header).
- Rejects older/equal versions, verifies Ed25519, freezes, swaps the live reference, notifies subscribers.
- Refs: [mobile-01 §2](./mobile-01-auth-and-snapshot.md), [mobile-05 atomic swap](./mobile-05-freshness.md).

### 2.3 PermissionGate
**Owns:** the optimistic client-side authorization read — CRUD `(Entity, view|create|edit|delete)`,
special `(Entity, ACTION_CODE)`, and offline-allowed gating.
- **Pure read** over the current frozen snapshot for the **active store**; no I/O, no caching of its own
  (the snapshot *is* the cache). Re-derives on SnapshotManager notify.
- Never more permissive than the server (the server's `403` + pushed snapshot is truth).
- Refs: [mobile-01 §0/§2](./mobile-01-auth-and-snapshot.md).

### 2.4 RefreshCoordinator
**Owns:** the *cadence* of freshness — **one** owner deciding when to poll/refresh, so screens don't.
- Triggers: app-focus, periodic heartbeat, reconnect. Actions it sequences: `GET /me/pv` (ETag→304) →
  if stale ask SnapshotManager to pull → token-refresh scheduling (pre-expiry) → `GET /me/subscription`
  → notify stores.
- **Coalesces**: never two concurrent freshness passes; a focus event during an in-flight pass is a no-op.
- Refs: [mobile-05 §6/§7](./mobile-05-freshness.md).

### 2.5 StoreManager 🔴
**Owns:** active-store pointer, **context load (latest-only, INV-2)**, store switching, device access
(`/access` claim, release-on-logout), **active-store-removed teardown (INV-4)**.
- Holds `activeStoreId` + the current store **context** (hours, `sync_config`, feature flags, tax) — all
  **store-scoped, re-loaded on every switch** ([mobile-03 store-context note](./mobile-03-post-login-flow.md)).
- On switch: abort the previous context request, clear store-scoped selectors, load the new context,
  hand the new `store_fk` to SyncEngine.
- Refs: [mobile-06 §8B.4](./mobile-06-multi-store-offline.md), [device F2/F10B](./device-management.md).

### 2.6 SyncEngine 🔴
**Owns:** the SQLite mutation queue, **priority scheduling + `parent_guuid` dependency resolution**,
retries/backoff/DLQ, conflict handling, cold-start + delta pull, **migrate-before-sync (INV-5)**.
- Per-`store_fk` partitioned. Push-before-pull on reconnect.
- Two write models behind one transport ([sync-engine §13](./sync-engine.md)).
- Refs: [sync-engine.md](./sync-engine.md), [mobile-04 §8C](./mobile-04-storage-and-state.md).

### 2.7 ClockService 🔴
**Owns:** the single server-time offset; the **only** source of "now" for anything the server validates.
- `offset = serverNow − deviceNow`, refreshed from `x-server-time` on every response (and `GET /time`).
- Feeds: request `x-timestamp`, `x-nonce` timestamps, and **every mutation `client_modified_at`**.
- **No module computes its own timestamp** — a divergent clock breaks replay protection and the
  point-in-time entitlement grace ([sync-engine §12](./sync-engine.md)).
- Refs: [mobile-01 §1](./mobile-01-auth-and-snapshot.md).

### 2.8 SubscriptionManager
**Owns:** banner severity/state, billing routing, **write-gating** (the cached `access_valid_until`
gate), refresh-after-payment.
- Reads the account channel (`/me/subscription`) and the per-store snapshot channel (Hybrid, two
  channels — [mobile-05 §7](./mobile-05-freshness.md), [subscription.md](./subscription.md)).
- **`/me/subscription` is the truth; `snapshot.stores[].subscription` is an offline *hint* only** — never
  enforce off the hint (banner + optimistic gate only). After a successful payment, refresh subscription
  and **bootstrap only if the account version actually changed** (§13 sequence, [subscription.md](./subscription.md)).
- Exposes `canWrite(storeId)` consulted by SyncEngine before enqueuing a sale ([device §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)).

### 2.9 HttpClient (foundational)
**Owns:** the single outbound request pipeline — **every** networked service goes through it, so headers,
retry, refresh, and tracing exist in exactly one place.
```
request → [ tracing id ] → [ ClockService: x-timestamp + x-nonce ]
        → [ AuthService: Bearer + getValidAccessToken (INV-3) ]
        → [ retry/backoff + Retry-After ] → [ on 401: single-flight refresh then replay once ]
        → [ on x-server-time: feed ClockService ] → response
```
- No service sets auth headers, nonces, or retry logic itself; they call `http.get/post`.
- A `401` triggers **one** refresh-and-replay (via AuthService single-flight), never a refresh storm.
- Emits `TokenRefreshed` / surfaces hard-auth failures to AppLifecycle (→ INV-6).

### 2.10 SyncScheduler (foundational)
**Owns:** *when* sync runs — the policy layer above SyncEngine, which only *executes*.
- Inputs it reacts to: **network restored, app foreground, wifi-vs-cellular, battery, idle, manual pull,
  retry timers**. Decides cadence (e.g. aggressive on wifi+charging, throttled on cellular, paused in
  background — §8).
- Calls `SyncEngine.runPush()` / `runPull()`; never touches the queue or cursors directly.
- Splitting *policy* (scheduler) from *mechanism* (engine) keeps battery/network rules out of the durable
  write path.

### 2.11 Repositories (foundational)
**Owns:** **all** SQLite access. UI/Redux read and write **through repositories**, never raw SQL in
components.
- One repository per entity (`ProductRepo`, `OrderRepo`, `ShiftRepo`, …) + the `QueueRepo` (owned by
  SyncEngine). Encapsulates the schema so a storage/migration change (INV-5) is local, not app-wide.
- **Components → Repository → SQLite.** Never Components → SQLite.

---

## 3. Ownership map & sole-owner rules

Each row is a **sole-owner invariant**: exactly one module may touch the resource; everyone else goes
through it. Violating these is how, over time, a random reducer replaces permissions or a screen corrupts
the queue.

| Concern | **Sole owner** | Nobody else may… |
|---|---|---|
| Tokens in SecureStore | AuthService | read/write tokens directly |
| `/auth/refresh` | AuthService | call refresh (use `getValidAccessToken()`) |
| **SecureStore (all keys)** | AuthService / SnapshotManager | access SecureStore from a screen or reducer |
| Snapshot bytes + swap | SnapshotManager | mutate the live snapshot field-by-field; **only SnapshotManager holds the mutable reference — everyone else gets a frozen, immutable read** |
| "Can I do X?" | PermissionGate | hand-roll permission checks; **PermissionGate must NEVER call the API — pure in-memory read, allow/deny only** |
| When to poll/refresh | RefreshCoordinator | trigger freshness from a screen |
| Active store + context | StoreManager | cache a stale store context; hold a second active-store pointer |
| **Mutation queue lifecycle** | SyncEngine (via QueueRepo) | enqueue/`removeMutation()`/mark-applied from anywhere else |
| **Sync cursors** | SyncEngine | advance a cursor (see INV-9) |
| **All SQLite** | Repositories | run raw SQL from a component (Components → Repository → SQLite) |
| Bootstrap pipeline | **AppLifecycle / BootstrapCoordinator** | call `bootstrap()` from inside a screen |
| "Now" (server-bound) | ClockService | call `Date.now()` for a timestamp the server validates |
| Subscription **truth** | SubscriptionManager (`/me/subscription`) | enforce off `snapshot.subscription` (that's an offline **hint**) |
| Write-gate + banners | SubscriptionManager | gate writes from a screen |

---

## 4. 🔴 Concurrency & durability invariants

The production races plus the lifecycle and **durability** rules. Each is a **hard rule**, not a guideline.
INV-9/INV-10 are the durability backbone — get them wrong and you lose data permanently.

### INV-1 · Monotonic snapshot version guard
A snapshot may only ever move **forward**. SnapshotManager ingests from four channels concurrently; a
slow **bootstrap** can finish *after* a fast **header push** carrying a newer version.
```
ingest(incoming):
  acquire(swapMutex)                                        // serialize — see below
  try:
    if incoming.version <= current.version: IGNORE          // never regress
    if not verifySig(incoming): KEEP current, retry         // never apply unverified
    swap(incoming)                                          // INV-8 (atomic + storage-transactional)
  finally: release(swapMutex)
```
**Serialize swaps (mutex/queue).** Two channels delivering the *same* newer version (e.g. header `pv=12`
and refresh `pv=12` arriving together) can **both** pass the `<=` check before either swaps — a check-then-
act race. SnapshotManager runs the verify→compare→swap as a **single critical section** so only one wins
and the other becomes a no-op.
**Bug if violated:** a stale bootstrap clobbers freshly-revoked permissions → user keeps access they lost.

### INV-2 · Latest-only context commit
Only the **most recent** store-context request may commit its result. Switch A→B; A's context can return
after B's.
```
switchStore(B):
  prevController.abort()                 // cancel in-flight A
  const reqId = ++contextEpoch
  ctx = await GET /stores/B/context
  if reqId !== contextEpoch: DISCARD     // a newer switch superseded us
  commit(ctx)
```
**Bug if violated:** Store B renders with Store A's hours/tax/feature-flags/`sync_config`.

### INV-3 · Single-flight refresh
At most **one** `/auth/refresh` in flight; concurrent 401s await the same promise.
```
getValidAccessToken():
  if token.valid: return token
  if !inFlightRefresh: inFlightRefresh = doRefresh().finally(() => inFlightRefresh = null)
  return await inFlightRefresh
```
Refresh tokens are **single-use + rotated** ([mobile-01](./mobile-01-auth-and-snapshot.md)); two parallel
refreshes race the rotation → one orphans the other → **spurious hard logout**. The backend
[`refresh-idempotency.service.ts`](../../apps/api/src/auth/mobile/services/refresh-idempotency.service.ts)
tolerates the duplicate, so this is a *client* obligation: **don't burn rotations, don't false-logout.**

### INV-4 · Active-store-removed teardown
When the active store disappears from the snapshot (owner removed the user, store archived), updating the
snapshot is **not enough**.
```
onSnapshotSwap():
  if activeStoreId not in snapshot.stores:
    abort context + queue work for that store
    clear store-scoped selectors + cached context
    resolve new active store (last_opened ?? default ?? picker)   // mobile-06 §8B.4
    open new store (fresh context + cursors)
```
**Bug if violated:** UI keeps rendering a store the user can no longer access; writes queue against a dead `store_fk`.

### INV-5 · Migrate-before-sync
On app update, **SQLite migration runs to completion before any sync touches the DB**.
```
appStart / postUpdate:
  if localSchemaVersion < bundledSchemaVersion: runMigrations()    // add columns/tables
  // only now:
  SyncEngine.start()                                               // cold-start or delta
```
Pairs with the manifest [`minimum_client_version` gate (§6.2)](./sync-engine.md) and `entity_version`. A
delta applying new columns against an un-migrated table corrupts the first write.
**Bug if violated:** first post-update delta throws / writes malformed rows.

### INV-6 · Logout lifecycle
Logout is an explicit, ordered teardown — not just "drop the token."
```
logout(reason):
  StoreManager.releaseDeviceSlots()        // DELETE /stores/:id/access  (device F10B.1)
  AuthService: DELETE session + revoke refresh   (best-effort; offline → queue)
  wipe SecureStore (tokens + snapshot)
  SnapshotManager.clear(); memory state reset
  SQLite:  EXPLICIT logout → WIPE per-store data (shared-device privacy)
           token-expiry re-auth → KEEP (warm re-login)         // different intents
  → login screen
```
**Decision:** wipe SQLite on **user-initiated** logout (privacy on shared counter devices); **keep** it on
silent token-expiry re-auth (the same user is coming back — avoid a needless cold sync).

### INV-7 · Unlock-on-minimum, sync-in-background
**Architectural invariant, not just a loading rule:** the UI unlocks the moment **minimum viable store
context + required reference data (G1–G3)** are present; G4–G5 and the long tail finish in the background.
Never block the shell to 100%. ([sync-engine §5](./sync-engine.md), [mobile-08 §13](./mobile-08-loading-ux-states.md).)

### INV-8 · Atomic + storage-transactional snapshot swap
Build → verify → **freeze** → swap the live reference → **notify subscribers**. Never field-by-field. A
half-applied snapshot is a security hole (new perms for entity A, old for B). On verify-fail keep the old
snapshot. ([mobile-05](./mobile-05-freshness.md).)

**Storage-transactional ordering** — persist **before** you swap memory:
```
swap(incoming):
  freeze(incoming)
  writeSecureStore(incoming) + flush      // durable FIRST
  liveRef = incoming                       // THEN memory
  emit SnapshotChanged                     // THEN notify
```
If you swap memory first and the SecureStore write then fails, a restart reads the **old** snapshot from
disk while memory had the new one → silent permission regression across launches. Disk is the source of
truth on cold start, so it must be written (and flushed) first.

### INV-9 · Cursor advances only after commit 🔴 durability
The sync **cursor is persisted only after the rows it covers are committed to SQLite — in that order,
never before.**
```
applyDelta(page):
  BEGIN
    upsert rows; apply tombstones
    persist new cursor            // same tx as the rows
  COMMIT                          // rows + cursor advance atomically
```
The cursor and the data **advance in one transaction** (or rows-first-then-cursor if separate). **Never**
persist the cursor, then write rows — a crash in between **skips those rows forever** (the next pull starts
past them). This is the single most important durability rule on the pull path.
**Bug if violated:** permanent silent data loss — rows the server sent are never re-delivered.

### INV-10 · Queue commit ordering 🔴 durability
On the push path, a queued mutation is marked **applied only after** its server result **and** any local
projection are durably written — never mark-first.
```
onPushResult(mutation, result):
  BEGIN
    apply result locally (upsert entity, patch FK, write projection)
    mark queue row = applied / dead / conflict
  COMMIT
```
**Never** mark a mutation `applied`, then write its local effect — a crash in between **loses the
mutation** (it's gone from the queue but its effect never landed). Same rule for `dead`/`conflict`
transitions: the status change and its bookkeeping commit together.
**Bug if violated:** a sale leaves the queue but never appears locally → drawer/report mismatch.

### INV-11 · Exactly-one (or no) active store
At all times there is **exactly one** active store **or none** — **never an invalid/stale one**. Setting
the active store is a single guarded transition (validate membership in the current snapshot → set
pointer → load context). On removal, INV-4 runs. A "no active store" state is valid (store picker /
empty-state); a pointer to a store not in the snapshot is **never** valid.
**Bug if violated:** screens read a `store_fk` the user can't access; writes queue against a dead store.

### INV-12 · Freshness precedence
**The highest signed snapshot version always wins — the delivery channel is irrelevant.** bootstrap,
refresh-inline, `/sync/delta` piggyback, and the header push are ranked **only** by `version`, never by
"which arrived last" or "which endpoint." (This is INV-1 stated as a precedence rule; ClockService/time
plays no part — version is the sole arbiter.)
```
bootstrap v10 → refresh v11 → header v12 → (late) bootstrap v10  ⇒  v12 stands, late v10 ignored
```

---

## 5. Startup state machine

**AppLifecycle owns one explicit state machine** — every transition is resumable, and impossible states
(e.g. "syncing" before "store opened") are unrepresentable. ([mobile-03 flow](./mobile-03-post-login-flow.md)
is the *narrative*; this is the *state model*.)

```
INITIAL ──▶ PREAUTH ──▶ AUTHENTICATING ──▶ BOOTSTRAPPING ──▶ RESOLVING_MODE
  │                                                              │
  │                                  ┌───────────────────────────┘
  │                                  ▼
  │                            RESOLVING_STORE ──▶ CLAIMING_SLOT ──▶ LOADING_CONTEXT
  │                                  │ (no store / personal)            │
  │                                  ▼                                  ▼
  └─────────────────────────────▶ EMPTY_STATE                       MIGRATING ──▶ SYNCING ──▶ READY
                                  (create / invitations)            (INV-5)      (INV-7: shell
                                                                                  unlocks at G1–G3)
ANY ──(hard-auth fail / logout)──▶ LOGGING_OUT ──▶ PREAUTH          (INV-6)
ANY ──(force-update / 410 UPGRADE_REQUIRED)──▶ UPGRADE_WALL
```

| State | Owner action | Exit |
|---|---|---|
| INITIAL | read SecureStore; `GET /time`, app-version | → PREAUTH (no/expired token) or BOOTSTRAPPING (valid) |
| PREAUTH | OTP login (2-stage) | tokens stored → AUTHENTICATING |
| AUTHENTICATING | verify tokens; SnapshotManager hydrate | → BOOTSTRAPPING |
| BOOTSTRAPPING | `GET /me/bootstrap`; ingest snapshot (INV-1/8) | → RESOLVING_MODE |
| RESOLVING_MODE | personal vs business; profile/maintenance gates | personal → READY(personal); business → RESOLVING_STORE |
| RESOLVING_STORE | `last_opened ?? default ?? picker` (INV-11) | store → CLAIMING_SLOT; none → EMPTY_STATE |
| CLAIMING_SLOT | `POST /stores/:id/access` (online) | granted → LOADING_CONTEXT; 403 → device-limit |
| LOADING_CONTEXT | `GET /stores/:id/context` (latest-only, INV-2) | → MIGRATING |
| MIGRATING | run SQLite migrations (INV-5) | → SYNCING |
| SYNCING | cold-start or delta via SyncScheduler | G1–G3 in → **READY** (rest in background, INV-7) |
| READY | steady state | events drive transitions |
| LOGGING_OUT | INV-6 teardown | → PREAUTH |
| UPGRADE_WALL | block until app updated | — |

---

## 6. Store-open state machine

Switching/opening a store is its own resumable machine (a sub-machine of SYNCING/READY), so a crash mid-
open resumes cleanly and a fast re-switch can't interleave:

```
NONE ──▶ RESOLVE ──▶ CLAIM_SLOT ──▶ LOAD_SNAPSHOT_SCOPE ──▶ OPEN_CONTEXT ──▶ COLD_START? ──▶ DELTA ──▶ READY
                                    (active-store crud)     (INV-2 epoch)   (first time)   (steady)
```
- **CLAIM_SLOT** offline → skip (reuse prior claim, [device F2](./device-management.md)).
- **OPEN_CONTEXT** commits only if it's still the latest switch (INV-2).
- **COLD_START** is the [sync-engine §5](./sync-engine.md) resumable per-entity loop; **DELTA** thereafter.
- Every state persists enough to resume (`sync_init_progress`, cursors) — no state is "in memory only."

---

## 7. Failure-policy matrix

One table, exhaustive, so the implementation never invents ad-hoc handling. **Retry** = automatic;
**User sees** = the UX treatment ([mobile-08](./mobile-08-loading-ux-states.md)).

| Failure | Retry | User sees | Owner |
|---|---|---|---|
| Network down / timeout | yes (backoff) | ambient **offline banner**; app stays usable (offline-first) | HttpClient / SyncScheduler |
| `401` access expired | refresh + replay **once** (INV-3) | nothing | HttpClient + AuthService |
| Refresh failed (revoked/rotated-out) | no | **"Session expired"** → re-login | AuthService → INV-6 |
| Snapshot signature invalid | keep old snapshot, retry pull | nothing (silent) | SnapshotManager (INV-8) |
| Snapshot generation mismatch | no → force bootstrap | brief skeleton | SnapshotManager (§10) |
| Bootstrap failed | yes (backoff) | **app-shell skeleton** | AppLifecycle |
| Context load failed | yes | **"Store unavailable"** retry; other stores still switchable | StoreManager |
| `403` permission denied (live) | no | roll back optimistic change + toast; pull fresh snapshot | PermissionGate / SyncEngine |
| `402` / write-gated (sub lapsed) | no | **upgrade/billing** sheet; reads continue | SubscriptionManager |
| Mutation `rejected` (business rule) | no | explain rule; move to review if needed | SyncEngine |
| Mutation `conflict` | no (manual) | conflict resolver (rebase) | SyncEngine (sync §11) |
| Mutation poison (repeated 5xx) | capped → **DLQ** | owner-facing "stuck items" | SyncEngine (sync §15) |
| SQLite migration failed | no → **stop** | **"Update required / reinstall"** wall | AppLifecycle (INV-5) |
| Device slot `403` at limit | no | **device-limit** screen ("free a device") | StoreManager (device F10B) |
| `410 SYNC_HORIZON_EXCEEDED` | auto → cold-start | brief sync progress | SyncEngine (sync §4) |
| `410 UPGRADE_REQUIRED` | no | **upgrade wall** | AppLifecycle (sync §6.2) |

---

## 8. Background-task / app-lifecycle policy

Exactly which module acts in each OS state — no ambiguity, no two services polling at once.

| App state | Active owner | Behaviour |
|---|---|---|
| **Foreground (active)** | RefreshCoordinator + SyncScheduler | pv heartbeat (§ below); sync per scheduler policy |
| **Background** | SyncScheduler (drain-only) | **stop polling**; allow a short OS-granted window to **flush the push queue** (don't pull); then idle |
| **Terminated** | — | nothing runs; state is durable (INV-9/10) so next launch resumes |
| **Reconnect (network restored)** | SyncScheduler → SyncEngine | **push-before-pull**, then `pv` check (snapshot/subscription refresh) |

**Precise pv-poll triggers** (replaces the vague "heartbeat") — RefreshCoordinator fires `GET /me/pv`
(ETag→304) on: **app→foreground**, **every 5–10 min while active**, **focus of a privileged screen**
(settings/cash/manager actions), and **reconnect**. Coalesced — never two passes at once.

---

## 9. Event catalog (typed event bus)

Cross-module signalling is **typed events**, not direct calls — modules subscribe, so adding a consumer
never edits a producer. Synchronous *reads* (`canCreate()`, `now()`) stay direct calls.

| Event | Emitted by | Typical subscribers |
|---|---|---|
| `TokenRefreshed` | AuthService / HttpClient | (logging, retry replay) |
| `SnapshotChanged` | SnapshotManager (INV-8) | PermissionGate (re-derive), StoreManager (INV-4 check), UI |
| `StoreChanged` | StoreManager | SyncEngine (bind `store_fk`), PermissionGate (active scope), UI |
| `SubscriptionChanged` | SubscriptionManager | SyncEngine (write-gate), UI banners |
| `QueueUpdated` | SyncEngine | UI (pending count / sync chip), telemetry |
| `SyncStateChanged` | SyncEngine/Scheduler | UI (syncing/synced/offline) |
| `Logout` | AppLifecycle/AuthService | **every** module (teardown, INV-6) |

---

## 10. Snapshot generations

The snapshot carries a **`generation`** alongside `version`. `version` tracks *content* (perms changed);
`generation` tracks *format* — bumped when the **snapshot schema, signature algorithm, or entity shape**
changes. A **generation mismatch → force bootstrap**, instead of surfacing as a confusing signature/parse
failure. (Mirrors the manifest `schema_version`/`entity_version` on the data side — [sync §6](./sync-engine.md).)
```
if incoming.generation !== client.supportedGeneration: discard → force fresh bootstrap
```

---

## 11. Telemetry & sync metrics

SyncEngine exposes a metrics surface (local debug screen + opt-in telemetry) — saves days of field
debugging:

`queue_depth` · `oldest_pending_mutation_age` · `last_push_at` / `last_pull_at` · `avg_push_latency` ·
`conflicts` · `duplicates` · `retries` · `dead_letter_count` · `oldest_cursor_age` ·
`cold_start_progress` · `pending_by_priority`.

Surfaced to the user as the **ambient sync chip** (Syncing / Synced + pending count, [mobile-08](./mobile-08-loading-ux-states.md))
and to the owner as a **"stuck items"** view fed by the DLQ + diagnostic columns ([sync §15](./sync-engine.md)).

---

## 12. End-to-end lifecycle sequence

One diagram, launch → ready, so a reader sees how all the docs fit before diving into parts:

```
App Launch
   │  AppLifecycle: INITIAL
   ▼
Load SecureStore (tokens + snapshot)          [AuthService, SnapshotManager]
   │
   ▼
Verify snapshot sig + generation + expiry      [SnapshotManager · INV-8/§10]
   │
   ▼
Token valid? ──no──▶ Refresh (single-flight)   [AuthService · INV-3]
   │ yes                  │ fail
   │                      ▼
   │                 Re-login (OTP)             [PREAUTH]
   ▼
Bootstrap (GET /me/bootstrap) ─ ingest snapshot (INV-1/8/12)   [AppLifecycle]
   │
   ▼
Resolve mode → resolve active store (INV-11)   [StoreManager · mobile-06]
   │
   ▼
Claim device slot (online)                     [StoreManager · device F2]
   │
   ▼
Open store → load context (latest-only)        [StoreManager · INV-2]
   │
   ▼
Migrate SQLite (if updated)                    [Repositories · INV-5]
   │
   ▼
Cold start (if needed) → delta pull            [SyncEngine · INV-9 · push-before-pull]
   │   (shell unlocks at G1–G3, INV-7)
   ▼
Process mutation queue (apply → commit)        [SyncEngine · INV-10]
   │
   ▼
READY  ── events (SnapshotChanged / StoreChanged / SubscriptionChanged / QueueUpdated) drive steady state
```

---

## 13. Service interaction sequences

**Store switch (the race-dense path):**
```
UI → StoreManager.switch(B)
  StoreManager: abort A-context (INV-2), ++epoch
  StoreManager → PermissionGate: active store = B (re-derive over frozen snapshot)
  StoreManager → ClockService: offset (for /access timestamp)
  StoreManager → AuthService.getValidAccessToken() (single-flight, INV-3)
  StoreManager → POST /stores/B/access  → GET /stores/B/context
    (commit only if epoch current, INV-2)
  StoreManager → SyncEngine.bind(store_fk=B)  → push-before-pull
```

**App focus (freshness pass, coalesced):**
```
OS focus → RefreshCoordinator.tick()  (no-op if a pass is in flight)
  GET /me/pv (ETag) → 304 ? stop
  else SnapshotManager.pull() → ingest (INV-1 + INV-8) → PermissionGate re-derives
  AuthService: refresh if near expiry (INV-3)
  SubscriptionManager: GET /me/subscription → banner/write-gate
  if active store gone → INV-4
```

---

## 14. Invariant ↔ service matrix

| Invariant | Primary owner | Touches |
|---|---|---|
| INV-1 monotonic version guard (+ serialized swap) | SnapshotManager | RefreshCoordinator, AuthService, HttpClient (channels) |
| INV-2 latest-only context | StoreManager | HttpClient (abort) |
| INV-3 single-flight refresh | AuthService | HttpClient, every networked service |
| INV-4 active-store teardown | StoreManager | SnapshotManager (trigger), SyncEngine, PermissionGate |
| INV-5 migrate-before-sync | Repositories / SyncEngine | AppLifecycle |
| INV-6 logout lifecycle | AppLifecycle / AuthService | StoreManager, SnapshotManager, SyncEngine |
| INV-7 unlock-on-minimum | SyncEngine | UI, StoreManager |
| INV-8 atomic + storage-transactional swap | SnapshotManager | SecureStore, PermissionGate (subscriber) |
| **INV-9 cursor-after-commit** 🔴 | SyncEngine | Repositories (same tx) |
| **INV-10 queue commit ordering** 🔴 | SyncEngine | Repositories (same tx) |
| INV-11 exactly-one active store | StoreManager | SnapshotManager (validity), SyncEngine |
| INV-12 freshness precedence | SnapshotManager | all snapshot channels |
