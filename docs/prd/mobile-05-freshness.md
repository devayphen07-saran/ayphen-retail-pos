# Mobile Architecture · Part 5 — Freshness (Permissions & Subscription)

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 6. PERMISSION freshness (pv-driven, reliable)

`permissionsVersion` is bumped by **RBAC changes, store add/archive, ownership
transfer, admin suspend/role** (`rbac.permissions.repository.ts:292,308`,
`store.repository.ts:841,857`, `ownership-transfer.service.ts:256`,
`admin.service.ts:234`). A bump → snapshot cache miss → the snapshot is re-pushed.

| Scenario | Call / signal | When | Action |
|---|---|---|---|
| general change | consume `X-Permission-Snapshot` header | on **every** authed response | verify sig → swap snapshot in SecureStore + memory |
| explicit poll | `GET /me/pv` (ETag → 304) | **app→foreground · every 5–10 min while active · focus of a privileged screen (settings/cash/manager) · reconnect** (coalesced — never two passes at once; owned by RefreshCoordinator, [mobile-09 §8](./mobile-09-client-services-and-invariants.md)) | if `pv > local` → pull fresh snapshot |
| offline → online | first `GET /sync/changes` or `POST /auth/refresh` | on reconnect | header/inline snapshot arrives automatically; swap |
| store added/removed | `store_access_changed` from `/auth/refresh` | on refresh | **if it's the active store** ([mobile-09 INV-4](./mobile-09-client-services-and-invariants.md)): abort its in-flight context/queue work → **clear store-scoped selectors + cached context** → re-pick active store (`last_opened ?? default ?? picker`) → open it (fresh context + cursors). Then drop the removed store's SQLite rows. Updating the snapshot alone is **not** enough. |
| account revoked/suspended/device blocked | server `403 user_suspended` / `user_deleted` / `device_blocked` | next request | **hard logout, wipe SecureStore** |
| offline action now denied | `POST /sync/delta` per-mutation `rejected:PERMISSION_DENIED` | on sync | roll back optimistic local change + notify |

**Atomic swap invariant** (owned by SnapshotManager — [mobile-09 INV-8](./mobile-09-client-services-and-invariants.md)).
Every "swap" above is **all-or-nothing**: `verify sig → build the new in-memory snapshot → **freeze** →
atomically replace the live reference → **notify subscribers** (PermissionGate re-derives)`. **Never**
mutate the live snapshot field-by-field — a half-applied snapshot (new perms for entity A, old for B) is a
security hole. If verification fails, keep the *old* snapshot and retry; degrade, never partially apply.

**Monotonic version guard** ([mobile-09 INV-1](./mobile-09-client-services-and-invariants.md)). The snapshot
arrives on **four** channels (bootstrap, refresh inline, `/sync/delta` piggyback, header push) that can
land **out of order** — a slow bootstrap can finish *after* a fast header carrying a newer version. So a
swap may only ever move the version **forward**: `if incoming.version <= current.version → IGNORE`. (The
`pv == local` no-op is the equality case of this rule.) Without it, a late bootstrap clobbers
freshly-revoked permissions.

**Cold-launch sequence:** read SecureStore → verify snapshot signature + `expiresAt`
→ valid: hydrate to memory, gate optimistically (works offline); expired/missing:
must go online and bootstrap.

**Idle-detection bound:** if the app makes no requests, a revocation isn't seen until
the next request, the `/me/pv` foreground heartbeat, or token refresh (≤1h). Use a
periodic/on-focus `/me/pv` to keep this tight.

---

## 7. SUBSCRIPTION freshness (NOT pv-driven — weaker)

**Verified:** subscription changes call only `invalidateAccessCache(storeId)`
(`subscription.service.ts:361`, deletes the guard's 60s Redis key). They **do not bump
`permissionsVersion`** and **do not rebuild the snapshot**. Therefore:

- `/me/pv` and the snapshot-header push **do NOT catch subscription changes.**
- The embedded `snapshot.stores[].subscription` is **optimistic only** — refreshed
  only when the snapshot is rebuilt for other reasons (a pv bump, or a fresh bootstrap
  after the 120s cache expires). Use it for banners, not as truth.

**Live truth = server enforcement at write time** (`SubscriptionStatusGuard`, reads
`checkAccess()` cached 60s, invalidated on change):
- **Reads never blocked.** Only **writes** gated, within ≤60s of a change.
- Status enum: `trialing | active | free | past_due | cancelled | paused | expired`
  (`expired` is derived in the snapshot when `cancelled` + period elapsed —
  `crypto.service.ts:33-46`).
- Write after lapse → **402 `subscription_payment_required`** (past_due grace over /
  cancelled period over / expired), **403 `subscription_suspended`** (paused),
  **403 `subscription_feature_limit_reached`**.
- Grace → response header `X-Subscription-Warning`
  (`past_due:grace_until_…` / `cancelled:ends_at_…`).

| Scenario | Signal | Action |
|---|---|---|
| approaching/within grace | `X-Subscription-Warning` header | show soft banner (`banner_severity`) |
| write blocked | `402` / `403 subscription_*` | block write UI, route to billing |
| after payment | `POST /stores/:id/subscription/checkout` + `/verify` | **re-bootstrap** to refresh status (no pv bump) |
| proactive refresh | periodic **bootstrap** (per session / daily) | only push-free way to refresh |
| offline lapse | mutation `rejected` at sync time | reconcile/roll back |

**Storage:** rides with the snapshot (SecureStore + memory). Offline write gating off
a stale subscription is **best-effort** — writes queued while lapsed will be rejected
with `402` on sync.

> **UPDATE — the Hybrid model is now partly built (verified: api-reference §6).** The `user_subscription`
> table, `GET /me/subscription` (with `access_valid_until`, `X-Subscription-Version` header,
> `subscription_version`), `/me/subscription/sv` (ETag poll), `/me/subscription/cancel`, and
> `/me/subscription/reactivate` all exist. What remains store-scoped: **checkout + verify**
> (`/stores/:id/subscription/checkout|verify`).
>
> **Two freshness channels (Hybrid — partly live):**
> 1. **Your own stores** → your account `subscriptionVersion` via `GET /me/subscription` ✅.
> 2. **Invited stores** (owned by someone else) → ride the **permission snapshot**
>    (`snapshot.stores[].subscription` carries that store-owner's plan status, refreshed when the
>    snapshot rebuilds) — you cannot poll another owner's `/me/subscription`.
>
> So the per-store `snapshot.stores[].subscription` field stays; the version/refresh for your own
> stores is **account-level** via `/me/subscription`. The offline write-gate (`access_valid_until`)
> and `subscription_lapsed_at_write` are also live ([device §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)).
