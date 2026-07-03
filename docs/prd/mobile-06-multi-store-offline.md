# Mobile Architecture · Part 6 — Multi-Store Offline & Active-Store Selection

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 8. Multi-store offline model & store switching

**Goal:** the user belongs to multiple stores; the last *N* opened stores (e.g. 3)
must work fully offline, and switching between them must be instant.

### 8.1 Verdict
The backend is **correctly designed** for this — everything that must be per-store
*is* per-store, and all stores' permissions arrive in **one** snapshot. The previously
noted sync rate limiter defect (keyed per-user, not per-store) is **now fixed** (§8.5).

### 8.2 What is per-store vs shared (verified)
| Mechanism | Scope | Source |
|---|---|---|
| Permissions (`crud`/`special`/`is_owner`) | **all stores in ONE snapshot** | `crypto.service.ts:48-69`, `snapshot.service.ts:120-178` |
| Subscription | **per store in the snapshot** (each `stores[]` entry reflects **that store-owner's account plan** — Hybrid) | `snapshot.service.ts:163-175` |
| Sync delta cursor | **per (userId, storeId)** — decode rejects cross-store reuse | `cursor-codec.service.ts:119-120,216` |
| Cold-start progress | **per (store, device, entity)** — PK | `sync-init-progress.ts:57` |
| Device access slot | **per (store, device)** — unique, idempotent re-claim | `store-device-access.ts:58-59` |
| Sync rate limit | ✅ **per `(userId, storeId, endpoint)` — fixed** | `sync-rate-limit.guard.ts` (api-reference §5) |

So three stores can hold independent sync state, independent cursors, independent
cold-start progress, and the permissions for all three are already in the single
cached snapshot.

### 8.3 First open of a store (must be ONLINE)
```
**Option A — merged (preferred, BUILT ✅):** `POST /stores/:id/open` → one call returns access result, store hours, sync_config, subscription + warnings.
**Option B — two-call (legacy, still valid):**
1. POST /stores/:id/access      → claim this device's slot for the store
2. GET  /stores/:id/context     → store details / hours / sync_config
3. loop GET /stores/:id/sync/initial   → pull all entity types into SQLite (store_fk=:id)
4. persist this store's next_delta_cursor
5. snapshot (already holds ALL stores' permissions) saved in SecureStore
```
After this, the store works offline from local SQLite + the cached snapshot.

### 8.4 Switching to another store
- **Permissions: ZERO network.** The target store's permissions are already in
  `snapshot.stores[]` — switch which entry you gate against.
- **Data:**
  - Target was opened before (in the cached set) → **resume delta**:
    `GET /stores/:id/sync/changes?cursor=<that store's cursor>` (works offline from
    its SQLite partition; reconciles on reconnect).
  - Target is first-time → **cold start** it (§8.3 — requires online).
- Persist the active store: `PATCH /me/preferences { last_opened_store_id }`.
- All store-scoped calls now send the new `storeId` (path param `:storeId`).

```
Switch A → B (B already cached):
  (in-memory) activeStore = snapshot.stores.find(s => s.store_guuid === B)   // no network
  GET /stores/B/sync/changes?cursor=<cursorB>     // delta only, offline-tolerant
  PATCH /me/preferences { last_opened_store_id: B }

Switch A → C (C never opened):
  POST /stores/C/access → GET /stores/C/context → loop /stores/C/sync/initial  // online cold start
```

### 8.5 ✅ Rate limiter — fixed
`SyncRateLimitGuard` is now keyed **per `(userId, storeId, endpoint)`**
(`sync_rate_limit:{userId}:{storeId}:{endpoint}`) — verified in the real backend
(api-reference §5). `/sync/pull` was never a live path (stale comment in the old guard).
The mutation budget `sync_mutations:{userId}:{storeId}` also includes `storeId` — both stores
sharing one pull budget was a prior bug, confirmed fixed.

### 8.6 Per-store caveats to design around
1. **Device limit is per store, subscription-driven.** Each cached store needs a free
   device slot for this device; otherwise `POST /stores/:id/access` → `403
   device_limit_reached`. Re-opening a store this device already holds is idempotent.
2. **Subscription is per store and NOT pv-driven** (§7). A store may have lapsed while
   offline; writes gate optimistically and get a `402` rejection at sync time.
3. **180-day cursor horizon.** A store not synced in 180 days → its cursor `410`s →
   full re-cold-start for that store only.
4. **"Last N" eviction is the client's policy** — the backend is stateless per request
   and never caps how many stores you cache. Evicting the (N+1)th store = drop its
   SQLite partition + its cursor locally.

### 8.7 Client responsibilities
- **Partition all SQLite data by `store_fk`** — N stores coexist, scoped by store.
- **Keep one delta cursor + one "cold-start complete" flag per store.**
- **Pre-sync the last N stores in the background while online** so a switch is instant
  offline — don't wait for the user to switch to start syncing.
- **One snapshot, all stores** — never split permissions into per-store tables. On a
  `permissionsVersion` bump, replace the whole snapshot and re-gate every store at once.
- **Gate per active store:** `snapshot.stores.find(s => s.store_guuid === activeGuuid)`,
  then read its `crud` / `special` / `is_owner` / `subscription`.

---

## 8B. Active store selection — `default` vs `last_opened` (policy)

### 8B.1 The two pointers (both per-user, in `me_preferences`)
| | `last_opened_store_id` (`lastOpenedStoreFk`) | `default_store_id` (`pinnedStoreFk`) |
|---|---|---|
| Meaning | "resume here" — the store I was last working in | owner's pinned **home** store |
| Who can set | any member — **any visible store (incl. invited)** | **owner only** |
| Validation | resolve to any accessible store, else `404` (`bootstrap.service.ts:204-228`) | must be **owned + active**; else `403 cannot_set_non_owned_default` / `cannot_set_archived_default` (`:240-258`) |
| Side effect | none | **bumps `permissionsVersion`** (`:262-264`) |

### 8B.2 Confirmed backend behaviour
- **First created store is auto-pinned as default** — `store.service.ts:188-191,287-289`
  (`isFirstOwnedStore` → `shouldMakeDefault` → `upsertPreferencesPinnedStore`).
- **A default store cannot be archived** until everyone re-picks — `409`
  (`store.service.ts:658-663`).
- **Revoking a user's store access bumps THAT user's pv** —
  `assignment.service.ts:202` (`bulkBumpPermissionsVersion([userFk])` +
  `invalidateUserCache`) → the snapshot drops the store on the next request.

### 8B.3 The adopted policy
1. **First created store ⇒ auto `default`.** (already native)
2. Opening an **invited** store sets it as `last_opened`. (already native)
3. **Reopen ⇒ land on `last_opened`** (the invited store). (already native)
4. **Owner revokes that invited store ⇒ fall back to the user's `default`** (their own
   first store). *(already works — the `??` cascade in §8B.4 handles it)*

`default` = pinned home store (auto-seeded from the first owned store);
`last_opened` = the live "resume here" pointer that follows the user into invited stores.

### 8B.4 Resolution cascade — ✅ already correct in the backend (remaining: `active_store` object + locked-aware)
**Verified current code** (`bootstrap.service.ts:362-381`) already implements the correct
membership-checked `??` cascade (rule 4 works today):
```js
const findInSnapshot = (fk) =>
  fk != null ? snapshot.stores.find(s => s.store_id === String(fk)) : undefined;

const activeStoreEntry =
  findInSnapshot(preferences?.lastOpenedStoreFk)   // 1. resume where you were
  ?? findInSnapshot(preferences?.pinnedStoreFk)     // 2. else the owner's default   (rule 4 ✓)
  ?? snapshot.stores[0];                             // 3. else first accessible (server scoping)
```
Because `findInSnapshot` returns `undefined` for a store no longer in `snapshot.stores[]`, a
**revoked** `last_opened` correctly **falls through to `default`** — the earlier "skips default"
bug is **already fixed**. The code comment even documents this.

**Remaining work (not a bug):**
1. **Return a full `active_store: { id, guuid }`** — today bootstrap returns only `active_store_id`
   (guuid) + `active_store_access` (`bootstrap.service.ts:380,386`). Add the object so the client
   stops re-deriving (§3c).
2. **Locked-aware** — once `store.locked` exists (§8B.5), keep locked entries selectable (open
   read-only) but skip revoked ones.
3. **Client picker** — the server ends at `?? stores[0]` for *scoping* `store_hours`/`subscription`,
   but the **client must NOT auto-open `stores[0]`** when there's no `last_opened`/`default` and
   `>1` store — it shows the **picker**.

### 8B.5 Edge cases the policy must handle
- **Pure-staff user (no owned store ⇒ `default` = null).** If their `last_opened` is
  revoked, both pointers are empty → **1 remaining store → open it; >1 → show the picker**
  (not an arbitrary `stores[0]`).
- **`last_opened`/`default` are per-user, not per-device** — both live in
  `me_preferences`, so a second device opens the globally last-opened store, not that
  device's. Per-device "resume" would require device-scoping `last_opened` (not today).
- An **invited store can never be a user's `default`** (owner-only), so "fall back to
  default" always lands on a store the user owns.
- **Locked store (downgrade) vs revoked store — different fallback.** A store that is
  **locked** (read-only after a plan downgrade — [subscription.md §14B](./subscription.md),
  [device-management.md F14](./device-management.md#19-f14--subscription-downgrade-account-plan--lower-limits))
  is **still in `snapshot.stores[]`** (with a `locked`/read-only flag). Resolution treats it
  differently from a **revoked** store:
  - `last_opened` resolves to a **locked** store → **open it read-only** (show the "Upgrade to
    reactivate" banner). Do **not** fall through to `default` — the user was working there.
  - `last_opened` resolves to a **revoked/missing** store (no longer in `snapshot.stores[]`) →
    fall through to `default` → picker (the §8B.4 chain).
  So the resolve helper must check membership-in-snapshot (revoked → skip) but **keep locked
  entries** (locked → open read-only).
