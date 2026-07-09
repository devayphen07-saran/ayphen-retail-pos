# QA Test Cases — Store Management (`stores/store`)

**Module under test:** `apps/backend/src/stores/store/` (`store.controller.ts`, `store.service.ts`,
`store.repository.ts`, `store.mapper.ts`, DTOs) plus the guard chain it runs behind
(`MobileJwtGuard`, `TenantGuard`, `PermissionsGuard`, `SubscriptionStatusGuard`) and the
`stores` / `accounts` / `account_subscriptions` tables in `apps/backend/src/db/schema.ts`.

Generated per `docs/agent/CLAUDE-ba-qa-testcases.md` (BA + QA agent), QA mode — grounded in the
actual controller/service/repository code and the live DB schema, not assumptions.

---

## 1. Feature understanding (BA)

### What it does

Two endpoints, both under `@Controller('stores')`, both behind
`@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)`:

1. **`POST /stores`** — creates a new store for the caller's account. This is an
   **account-level** action (`@StoreContext('none')`): gated by direct account ownership
   (`accounts.owner_user_fk`) and the plan's `max_stores` entitlement, **not** by store-level
   RBAC — the creator has no role in any store yet when this runs. One atomic transaction
   creates: the store row, an immutable per-store `STORE_OWNER` role (fully granted), a role
   mapping assigning the creator, (conditionally) the account's first trial window, a
   `permissions_version` bump, and an audit log entry. After commit it invalidates the caller's
   store-access cache and permission-snapshot cache, then best-effort rebuilds the snapshot to
   embed in the response.
2. **`GET /stores/:storeId/setup-status`** — a live-computed (never persisted) onboarding
   checklist for a store: 5 independent boolean checks run concurrently, rolled up into a
   percentage. Store-scoped (`@StoreContext('param.storeId')`), requires `Store.view`
   permission.

There is **no** update, delete, list, or "get store by id" endpoint in this controller — store
mutation (lock/unlock) and listing (`listActiveStores`/`listAllStores`) live in the repository
but are only invoked from the subscription-reconciliation flow, not exposed here.

There is **no store-open/store-closed backend gating concept** in this module. The "store-open
gate" referenced in recent commit history (`df4f97b`) is a **mobile-app-only** readiness gate
("no screen queries local SQLite before migrations/cold-start finish") — it lives in
`apps/mobile`, not in this backend module. `stores.is_active` and `stores.locked` are the only
store-level status flags on the backend, and neither is touched by this controller. See
Assumption A1.

### Actors

- **Account owner** — the only actor who can create a store (`accounts.owner_user_fk === userId`).
- **Any user with store access** (any role) — can read `setup-status` for a store they can
  access, if granted `Store.view`.
- **System/cron** — subscription-reconciliation jobs (a different module) lock/unlock stores and
  flip `reconciliation_status`, which this module's gates react to.

### Inputs / Outputs

`POST /stores` body (snake_case wire, `CreateStoreDtoSchema`):

| Field | Rule |
|---|---|
| `name` | required, string, 1–120 chars |
| `gst_number` | optional, must match `GSTIN_REGEX` if present |
| `address` | optional, string, ≤500 chars |
| `phone` | optional, string, ≤20 chars, **no format check** |
| `email` | optional, valid email format |

Response: `{ id, name, snapshot, snapshot_signature }` — `snapshot`/`snapshot_signature` are
nullable (best-effort refresh; client falls back to bootstrap on null).

`GET /stores/:storeId/setup-status` → `{ total_checks, completed_checks,
completion_percentage, status_map: { store_profile_complete, staff_invited, product_added,
payment_configured, device_linked } }`.

### Business rules / invariants extracted from code

- **BR1 — Ownership gate.** Only the account owner (direct `accounts.owner_user_fk` match, not
  an RBAC role) may create a store. Violators get 403 `NOT_ACCOUNT_OWNER`.
- **BR2 — Account write-gate** (`assertAccountCanWrite`, mirrors `SubscriptionStatusGuard`'s
  contract since that guard "can't run" on this store-unscoped route — see Bug-1):
  - subscription `status === 'paused'` → 403 `SUBSCRIPTION_SUSPENDED`.
  - subscription `status === 'expired'` → 402 `SUBSCRIPTION_PAYMENT_REQUIRED`.
  - `accessValidUntil` in the past → 402 `SUBSCRIPTION_PAYMENT_REQUIRED` (soft block —
    status hasn't flipped yet but the window is closed).
  - `reconciliationStatus === 'pending'` → 403 `SUBSCRIPTION_RECONCILIATION_REQUIRED`.
  - **No subscription row at all** → allowed through this gate ("shouldn't happen
    post-bootstrap"); the `max_stores` gate still applies (and, per `EntitlementService`,
    a missing `account_subscriptions`/`plan_entitlements` join row resolves the limit to `0`,
    which blocks creation anyway in practice — see EDGE-06).
- **BR3 — `max_stores` gate** (device F0). Enforced twice: a fast pre-check outside the
  transaction, then an authoritative recheck **inside** a transaction that holds
  `SELECT ... FOR UPDATE` on the account row — closing the TOCTOU window where two concurrent
  requests could both pass the pre-check. `locked` stores and soft-deleted (`deleted_at`)
  stores don't count toward the limit. `null` limit = unlimited; otherwise strict `current <
  limit`.
- **BR4 — Atomicity.** Store row + `STORE_OWNER` role (immutable, `is_editable=false`, fully
  granted) + role mapping (creator as `assigned_by`) + conditional trial start + user
  `permissions_version` bump + audit log — one transaction, all-or-nothing.
- **BR5 — First-store trial start.** Only when `isFirstStore` (no non-deleted store yet on the
  account) **and** `subscription.status === 'trialing'` **and** `!hasUsedTrial`: opens a 15-day
  trial window (`trialEndsAt = accessValidUntil = now + 15d`, `hasUsedTrial = true`). Never
  re-opens on subsequent stores, even if the first store is later deleted.
- **BR6 — Cache/session freshness.** After commit: `rbac.invalidateUserStoreCache` +
  `snapshot.invalidate` (in that order — invalidate before rebuild, else a stale snapshot could
  win the cache-first read) + best-effort `snapshot.getOrBuild`. A snapshot rebuild failure must
  not fail the already-committed store creation.
- **BR7 — GSTIN format.** `gst_number`, if present, must satisfy `GSTIN_REGEX`. **Bug-2 (see
  §Open Questions): the regex as written cannot match any real 15-character GSTIN.**
- **BR8 — Field validation.** `name` 1–120 chars (whitespace-only "1 char" strings pass —
  no `.trim()`); `address` ≤500; `phone` ≤20 with **no character/format validation at all**;
  `email` must be `zod` `.email()`-valid if present. Unknown/extra JSON fields are silently
  stripped (schema isn't `.strict()`).
- **BR9 — Setup-status computation.** Five independent, concurrently-run existence checks
  (`Promise.all`), never persisted:
  - `store_profile_complete` = `gst_number && address && phone && email` **all** present
    (truthy) on the store row.
  - `staff_invited` = at least one invitation with `status = 'accepted'` (pending doesn't count).
  - `product_added` = at least one product with `is_active = true` and `deleted_at IS NULL`.
  - `payment_configured` = at least one payment account with `is_active = true`.
  - `device_linked` = at least one `storeDeviceAccess` row with `status='active'` **joined** to
    a `devices` row with `is_trusted = true` (trust lives on the device, not the access row).
  - `completion_percentage = round(completed/total * 100)`.
- **BR10 — Tenant isolation.** `setup-status` resolves `:storeId` through `TenantGuard` against
  the caller's Redis-cached accessible-store list. A non-existent store and a store the caller
  cannot access return the **identical** 404 `STORE_NOT_ACCESSIBLE` (deliberate timing-oracle
  protection — must never leak "exists but you can't see it" vs "doesn't exist").
- **BR11 — Read routes bypass the subscription write-gate.** `setup-status` is a `GET`, so
  `SubscriptionStatusGuard` always lets it through regardless of suspended/expired/reconciling
  account state (reads are never blocked) — but it is still blocked cross-tenant by `TenantGuard`
  and by `Store.view` via `PermissionsGuard`.

### State machine (as it exists in code)

```
Store:      [doesn't exist] --create--> [active, unlocked]
            [active, unlocked] <--lock/unlock (downgrade reconciliation, elsewhere)--> [locked]
            [any] --soft delete (elsewhere, not in this controller)--> [deleted_at set]

Account subscription (as read by BR2 / mirrored by SubscriptionStatusGuard):
  trialing --(first store creates trial window)--> trialing (window open)
  trialing/active/past_due/cancelled  -- writes allowed unless accessValidUntil passed
  paused                               -- writes always blocked (SUSPENDED)
  expired                              -- writes always blocked (PAYMENT_REQUIRED)
  reconciliationStatus=pending         -- writes always blocked (RECONCILIATION_REQUIRED),
                                          regardless of status
```

### Assumptions / ambiguities flagged

- **A1.** "Store-open gate" from the recent commit history is a mobile-client concept, not a
  backend rule in this module. Test cases below do **not** invent a backend open/closed store
  state; if product intent differs (e.g. a planned `stores.is_open` shift-style flag), that's an
  open question (§7).
- **A2.** `stores.is_active` exists in the schema but is never read or written anywhere in this
  module (not in `insertStore`'s explicit columns, not in any query filter here — only `locked`
  and `deleted_at` gate "active" store counts). Assumed dead/reserved-for-future-use for this
  module; flagged in Open Questions.
- **A3.** No endpoint here updates a store's profile fields (name/gst/address/phone/email) after
  creation, yet `setup-status`'s `store_profile_complete` check implies such an endpoint must
  exist elsewhere. Out of scope for this module's test cases except to note the read-side
  dependency.
- **A4.** "Realistic Indian retail" data used throughout: GSTINs, Indian phone numbers, INR-less
  since this module has no money fields.

---

## 2. Coverage plan

| Dimension | Applies? | Approx. cases |
|---|---|---|
| Happy paths | Yes | 5 |
| Business rules (satisfied + violated) | Yes | 16 |
| Boundaries | Yes | 14 |
| Negative / invalid | Yes | 13 |
| Failure & recovery | Yes | 9 |
| Concurrency | Yes | 6 |
| Permissions / roles | Yes | 8 |
| State transitions | Yes | 7 |
| Cross-cutting (tenancy/time/consistency) | Yes | 8 |
| UX / experience | Partial (API-only module; "UX" = client-facing contract behavior) | 5 |
| Edge-case checklist (§5) | Yes | 13 |

**Total: ~104 cases.**

---

## 3. Test cases

### 3.1 Happy paths

**SM-HP-01 — Owner creates first store on a fresh trialing account**
Area: happy · Criticality: Critical · Traces to: BR1, BR3, BR4, BR5
Preconditions: User `U1` is `accounts.owner_user_fk` for account `A1`; `A1` has an
`account_subscriptions` row with `status='trialing'`, `hasUsedTrial=false`, no stores yet.
Input: `{ "name": "Ganesh Supermarket", "gst_number": "29AAAPL1234C1Z5", "address": "12 MG Road,
Bengaluru", "phone": "+919876543210", "email": "owner@ganeshmart.in" }`
Steps: 1) `POST /stores` as `U1`.
Expected result: 201 with `{ id, name: "Ganesh Supermarket", snapshot: <non-null>,
snapshot_signature: <non-null> }`; a `stores` row exists with `account_fk=A1`, `locked=false`,
`deleted_at=null`; a `STORE_OWNER` role (immutable) exists for the new store; `U1` is mapped to
it; `account_subscriptions.trial_ends_at`/`access_valid_until` set to now+15d,
`has_used_trial=true`; `users.permissions_version` incremented by 1; one `STORE_CREATED` audit
row. *(Note: per Bug-1 in §7, this currently 403s before reaching any of this — see there.)*

**SM-HP-02 — Owner creates a second store (trial untouched)**
Area: happy · Criticality: High · Traces to: BR3, BR5
Preconditions: `A1` already has 1 active store; subscription `status='trialing'`,
`has_used_trial=true`, `trial_ends_at` already set; `max_stores=3`.
Steps: `POST /stores` with a valid minimal body `{ "name": "Ganesh Supermarket - Whitefield" }`.
Expected result: 201, new store created; `trial_ends_at`/`access_valid_until` **unchanged**
(trial not restarted); active store count now 2.

**SM-HP-03 — Create store with only the required field**
Area: happy · Criticality: Medium · Traces to: BR8
Preconditions: Owner, room under `max_stores`.
Input: `{ "name": "Corner Store" }` (no gst/address/phone/email).
Expected result: 201; `gst_number`/`address`/`phone`/`email` all `null` in the row.

**SM-HP-04 — Setup-status for a brand-new store shows 0%**
Area: happy · Criticality: Medium · Traces to: BR9
Preconditions: Store just created via SM-HP-03, no invitations/products/payment
accounts/devices yet.
Steps: `GET /stores/{id}/setup-status` as a user with `Store.view` on that store.
Expected result: 200, `total_checks=5`, `completed_checks=0`, `completion_percentage=0`, every
`status_map` key `false`.

**SM-HP-05 — Setup-status reaches 100% as each dependency is satisfied**
Area: happy · Criticality: Medium · Traces to: BR9
Preconditions: Store has `gst_number`, `address`, `phone`, `email` all set; one accepted
invitation; one active non-deleted product; one active payment account; one active
`storeDeviceAccess` joined to a trusted device.
Steps: `GET /stores/{id}/setup-status`.
Expected result: 200, `completed_checks=5`, `completion_percentage=100`, all `status_map` keys
`true`.

### 3.2 Business rules (satisfied + violated)

**SM-BR-01 — Non-owner cannot create a store (violated)**
Area: rule · Criticality: Critical · Traces to: BR1
Preconditions: `U2` has a `STORE_OWNER` role on an existing store of `A1` but is **not**
`accounts.owner_user_fk` (e.g. was granted ownership-equivalent role by the real owner, or is
staff). 
Steps: `U2` calls `POST /stores`.
Expected result: 403 `NOT_ACCOUNT_OWNER`; no store row inserted; no audit `STORE_CREATED` entry.

**SM-BR-02 — Owner with no account row at all**
Area: rule · Criticality: High · Traces to: BR1
Preconditions: `findOwnedAccount(userId)` returns null (user owns no account — e.g. a staff-only
user who was invited but never onboarded an account of their own).
Steps: `POST /stores`.
Expected result: 403 `NOT_ACCOUNT_OWNER`.

**SM-BR-03 — Suspended (paused) account blocked (violated)**
Area: rule · Criticality: Critical · Traces to: BR2
Preconditions: Owner; `account_subscriptions.status='paused'`.
Expected result: 403 `SUBSCRIPTION_SUSPENDED`; no store created.

**SM-BR-04 — Expired account blocked (violated)**
Area: rule · Criticality: Critical · Traces to: BR2
Preconditions: `status='expired'`.
Expected result: 402 `SUBSCRIPTION_PAYMENT_REQUIRED`.

**SM-BR-05 — Access window closed but status not yet flipped (violated)**
Area: rule · Criticality: High · Traces to: BR2
Preconditions: `status='active'` (or `past_due`), `access_valid_until` = yesterday (reconciliation
cron hasn't run yet).
Expected result: 402 `SUBSCRIPTION_PAYMENT_REQUIRED` — soft block honored even though `status`
itself still says active/past_due.

**SM-BR-06 — Access window valid, satisfied**
Area: rule · Criticality: High · Traces to: BR2
Preconditions: `status='active'`, `access_valid_until` = tomorrow.
Expected result: gate passes; falls through to max_stores check.

**SM-BR-07 — Reconciliation pending blocks creation (violated)**
Area: rule · Criticality: Critical · Traces to: BR2
Preconditions: `status='active'`, `access_valid_until` future, `reconciliation_status='pending'`
(a downgrade left the account over a limit).
Expected result: 403 `SUBSCRIPTION_RECONCILIATION_REQUIRED`; owner must resolve via
`POST /subscription/reconciliation` first.

**SM-BR-08 — No subscription row at all (edge-allowed)**
Area: rule · Criticality: Medium · Traces to: BR2
Preconditions: Account exists, owner valid, but no `account_subscriptions` row (bootstrap gap).
Expected result: `assertAccountCanWrite` does not throw (falls through), **but**
`EntitlementService.get()` then returns `0` for `max_stores` (missing join row = no entitlement),
so `canCreate(0, 0)` is `false` → 403 `STORE_LIMIT_REACHED` with `{ limit: 0, current: 0 }`. Net
effect: creation still blocked, just via a different error code than BR2's checks. *(Flag if
product wants a distinct error code for this genuinely-anomalous state — see Open Questions.)*

**SM-BR-09 — At the `max_stores` limit (violated)**
Area: rule/boundary · Criticality: Critical · Traces to: BR3
Preconditions: `max_stores=3`, account has exactly 3 active (unlocked, non-deleted) stores.
Expected result: 403 `STORE_LIMIT_REACHED`, `{ limit: 3, current: 3 }`; no 4th store created.

**SM-BR-10 — One under the limit (satisfied boundary)**
Area: rule/boundary · Criticality: High · Traces to: BR3
Preconditions: `max_stores=3`, 2 active stores.
Expected result: 201; 3rd store created; now at limit (next attempt hits SM-BR-09).

**SM-BR-11 — Unlimited plan (`max_stores = null`)**
Area: rule · Criticality: Medium · Traces to: BR3
Preconditions: Plan entitlement row for `max_stores` has `value = NULL` (explicit unlimited).
Steps: Create a 10th, 50th store.
Expected result: always allowed; `canCreate(null, n)` is `true` regardless of `n`.

**SM-BR-12 — Locked stores don't count toward the limit (satisfied)**
Area: rule · Criticality: High · Traces to: BR3
Preconditions: `max_stores=3`; account has 3 stores total but 1 is `locked=true` (downgrade
reconciliation).
Steps: `POST /stores`.
Expected result: 201 — `countActiveStores` excludes the locked store, so active count is 2 < 3.

**SM-BR-13 — Soft-deleted stores don't count toward the limit**
Area: rule · Criticality: Medium · Traces to: BR3
Preconditions: `max_stores=3`; account has 3 stores, 1 with `deleted_at` set.
Expected result: 201 — deleted store excluded from both `countActiveStores` and `hasAnyStore`.

**SM-BR-14 — GSTIN validated when present (violated)**
Area: rule · Criticality: High · Traces to: BR7
Input: `gst_number: "INVALID123"`.
Expected result: 422 `VALIDATION_FAILED`, message references `gst_number: Invalid GSTIN`; no
store created.

**SM-BR-15 — GSTIN validated when present — real GSTIN incorrectly rejected (Bug-2)**
Area: rule · Criticality: Critical (data-quality/regression) · Traces to: BR7
Input: `gst_number: "29AAAPL1234C1Z5"` (a real, correctly-formatted 15-character GSTIN).
Expected result **per business intent**: 201, store created with this GSTIN.
**Actual result per current regex**: 422 `VALIDATION_FAILED` — the pattern requires 16
characters and rejects every valid 15-character GSTIN. See Bug-2, §7. **This case must be run
against the real code, not assumed** — it is the single highest-value case in this whole
document to execute first.

**SM-BR-16 — Email validated when present (violated)**
Area: rule · Criticality: Medium · Traces to: BR8
Input: `email: "not-an-email"`.
Expected result: 422 `VALIDATION_FAILED`.

### 3.3 Boundaries

**SM-BND-01 — `name` at minimum length (1 char)**
Input: `name: "A"`. Expected: 201.

**SM-BND-02 — `name` empty string (below minimum)**
Input: `name: ""`. Expected: 422 `VALIDATION_FAILED` (`name` min 1).

**SM-BND-03 — `name` at maximum length (120 chars)**
Input: `name` = exactly 120 chars. Expected: 201.

**SM-BND-04 — `name` over maximum (121 chars)**
Input: `name` = 121 chars. Expected: 422 `VALIDATION_FAILED`.

**SM-BND-05 — `name` missing entirely**
Input: body without `name` key. Expected: 422 `VALIDATION_FAILED` (required field).

**SM-BND-06 — `address` at maximum (500 chars)**
Expected: 201.

**SM-BND-07 — `address` over maximum (501 chars)**
Expected: 422 `VALIDATION_FAILED`.

**SM-BND-08 — `phone` at maximum (20 chars)**
Input: `phone: "12345678901234567890"` (20 digits). Expected: 201 (no format check beyond length).

**SM-BND-09 — `phone` over maximum (21 chars)**
Expected: 422 `VALIDATION_FAILED`.

**SM-BND-10 — `max_stores` limit exactly 0**
Preconditions: plan entitlement `max_stores = 0` (explicit zero, not missing row).
Expected: 403 `STORE_LIMIT_REACHED`, `{ limit: 0, current: 0 }` even for the very first store —
this plan grants no stores at all.

**SM-BND-11 — `max_stores` limit exactly 1, first store**
Expected: 201 (0 < 1); attempting a 2nd store then hits `STORE_LIMIT_REACHED` with
`{ limit: 1, current: 1 }`.

**SM-BND-12 — `access_valid_until` exactly equal to "now"**
Preconditions: `access_valid_until` = current instant (race the clock).
Expected: code uses `sub.accessValidUntil < new Date()` — an instant that is *exactly* equal at
comparison time is **not** `<` now, so it passes through at that exact microsecond, but will
fail on the very next check a moment later. Verify the boundary is inclusive-until (valid up to
and not including the compared instant) and that this isn't flaky under real clock granularity.

**SM-BND-13 — GSTIN with lowercase letters**
Input: `gst_number: "29aaapl1234c1z5"`. Expected: 422 (regex is uppercase-only, no
case-insensitive flag) — confirm this is intended (real GSTINs are always issued uppercase, so
likely fine, but worth an explicit case since the DTO doesn't `.toUpperCase()` before validating).

**SM-BND-14 — `completion_percentage` rounding**
Preconditions: exactly 2 of 5 checks true (40% — clean). Also test 1 of 5 (20%), 3 of 5 (60%) to
confirm `Math.round` never needed to actually round (5 is evenly divisible-ish); explicitly
re-derive: 1/5=20, 2/5=40, 3/5=60, 4/5=80 — all exact, so rounding never triggers with 5 checks.
Expected: values exactly 0/20/40/60/80/100, never a non-integer artifact. *(Flag: since 5 checks
never actually requires rounding, `Math.round` here is defensive/no-op — fine, just note it.)*

### 3.4 Negative / invalid

**SM-NEG-01 — Malformed JSON body**
Steps: `POST /stores` with invalid JSON. Expected: 400/422 from body-parser/Nest pipeline before
reaching the Zod parse; no store created.

**SM-NEG-02 — `name` wrong type (number instead of string)**
Input: `{ "name": 12345 }`. Expected: 422 `VALIDATION_FAILED`.

**SM-NEG-03 — Extra/unknown fields silently stripped**
Input: `{ "name": "Test Store", "locked": true, "is_active": false, "invoice_prefix": "HACK" }`.
Expected: 201; store created with `locked=false` (DB default), `invoice_prefix='INV'` (DB
default) — client-supplied values for fields not in the DTO are **ignored**, not honored and not
rejected (schema isn't `.strict()`). Confirm this can't be used to sneak privileged fields
through.

**SM-NEG-04 — SQL-injection-style `name`**
Input: `name: "Robert'); DROP TABLE stores;--"`. Expected: 201, stored verbatim as a string
(parameterized query via Drizzle) — no injection; verify via direct DB read that the literal
string is stored and the table still exists.

**SM-NEG-05 — Missing/invalid Bearer token**
Steps: `POST /stores` with no `Authorization` header. Expected: 401 `MISSING_TOKEN`, guarded by
`MobileJwtGuard` before any store logic runs.

**SM-NEG-06 — Expired/blacklisted JWT**
Expected: 401 `TOKEN_REVOKED` / session-expiry code, per `MobileJwtGuard`; no store logic reached.

**SM-NEG-07 — `storeId` not a UUID on setup-status**
Steps: `GET /stores/not-a-uuid/setup-status`. Expected: 400 from `ParseUUIDPipe`, before
`TenantGuard` even runs.

**SM-NEG-08 — `setup-status` for a store that doesn't exist**
Steps: `GET /stores/{random-uuid}/setup-status`. Expected: 404 `STORE_NOT_ACCESSIBLE` (same shape
as SM-NEG-09 — see BR10).

**SM-NEG-09 — `setup-status` for a store that exists but caller can't access (cross-tenant)**
Preconditions: Store belongs to a different account; caller has no role there.
Expected: 404 `STORE_NOT_ACCESSIBLE` — **identical** body/status to SM-NEG-08 (verify no
distinguishing detail leaks existence).

**SM-NEG-10 — `setup-status` without `Store.view` permission**
Preconditions: Caller has a role in the store but the role's matrix denies `Store.view`.
Expected: 403 `PERMISSION_DENIED`; a `PERMISSION_DENIED` audit row written before the throw.

**SM-NEG-11 — Create with `gst_number` as empty string**
Input: `gst_number: ""`. Expected: 422 (empty string fails the regex — `.optional()` only skips
validation when the key is `undefined`/absent, not when it's an empty string). Confirm this is
the intended behavior vs. treating `""` as "not provided."

**SM-NEG-12 — Whitespace-only `gst_number`/`phone`**
Input: `gst_number: "   "`. Expected: 422 (fails regex). `phone: "   "` (3 spaces, ≤20): passes
length check and is stored as-is (no trim) — flag as a data-quality gap, see EDGE-05.

**SM-NEG-13 — Body is a non-object (array/string/null)**
Input: raw body `[]` or `"store"` or `null`. Expected: 422 `VALIDATION_FAILED` — Zod object
parse fails cleanly, no 500.

### 3.5 Failure & recovery

**SM-FAIL-01 — DB failure mid-transaction (after store insert, before role insert)**
Preconditions: simulate a DB error thrown by `insertStoreOwnerRole`.
Expected result: whole `uow.execute` transaction rolls back — **no** orphan `stores` row, no
partial role, `permissions_version` not bumped, no audit row. Verify via direct DB check after
the failed call that the `stores` table has zero new rows.

**SM-FAIL-02 — Snapshot rebuild fails after successful commit**
Preconditions: store creation transaction commits; `snapshot.getOrBuild(userId)` throws (e.g.
Redis/service error).
Expected result: `POST /stores` still returns 201 with `snapshot: null, snapshot_signature:
null`; the store, role, and mapping are all durably committed; client is expected to fall back to
`GET /me/bootstrap`.

**SM-FAIL-03 — Cache invalidation (`invalidateUserStoreCache`) fails after commit**
Expected result: creation still succeeds (already committed); document that the caller's cached
accessible-store list may be stale until TTL expiry or a retry — verify whether this is
best-effort (no try/catch currently shown around it — confirm whether an unhandled throw here
would incorrectly surface as a 500 on an otherwise-successful creation; if so, this is a bug: a
post-commit cache-invalidation failure should never turn a successful write into an error
response).

**SM-FAIL-04 — Redis outage during `SubscriptionStatusGuard`'s cache read**
Expected result: guard degrades to DB read (documented fallback in `loadSubscription`); request
still evaluated correctly, just slower; no 500.

**SM-FAIL-05 — Redis outage during permission cache bust (H-6 version mismatch)**
Expected result: `bustCacheOnVersionMismatch` catches and logs; request proceeds (`getCached
Permissions` may serve a stale-but-bounded entry) — not a hard failure.

**SM-FAIL-06 — Network drop after request sent, before response received (client retries)**
Steps: Client sends `POST /stores`, connection drops after server processes but before response
returns; client retries the identical request.
Expected result: **this is not idempotent** — a retry creates a **second** store with the same
name (no idempotency key on this endpoint). Document as a real risk (see EDGE-04) — client-side
guidance needed (disable the "create" button after first tap, per UX cases) since the server has
no dedupe.

**SM-FAIL-07 — Trial-start write fails after store/role already inserted**
Preconditions: `repo.startTrial` throws inside the transaction.
Expected result: whole transaction rolls back (same tx) — store and role also undone; verify no
"store exists but trial never started" partial state is possible.

**SM-FAIL-08 — `bumpUserPermissionsVersion` fails**
Expected result: same transaction, rolls back entirely — store creation must not succeed with a
stale `permissions_version` (would leave the creator's existing JWT/snapshot silently correct
by accident, masking the intended H-6 refresh).

**SM-FAIL-09 — Audit log insert fails inside the transaction**
Expected result: `audit.logInTransaction` is inside the same `uow.execute` — if it throws, the
whole store creation rolls back. Confirm this is intended (audit is not best-effort here, unlike
the denial-audit in `PermissionsGuard` which explicitly swallows failures) — flag the asymmetry
in Open Questions.

### 3.6 Concurrency

**SM-CONC-01 — Two concurrent `POST /stores` when exactly 1 slot remains**
Preconditions: `max_stores=3`, 2 active stores; two requests fire near-simultaneously.
Expected result: exactly **one** succeeds (201, 3rd store), the other gets 403
`STORE_LIMIT_REACHED` — enforced by `lockAccount`'s `SELECT ... FOR UPDATE` serializing the two
transactions so the second one's in-transaction recheck sees the first's committed insert.
Final active count is exactly 3, never 4.

**SM-CONC-02 — Two concurrent `POST /stores` when 2 slots remain**
Preconditions: `max_stores=3`, 1 active store; two simultaneous requests.
Expected result: both succeed; final count 3; no race allows a 4th.

**SM-CONC-03 — Concurrent create-store and downgrade-lock on the same account**
Preconditions: One request creating a store races a reconciliation job locking an existing store
for downgrade (`lockMany`) on the same account.
Expected result: `lockAccount`'s row lock serializes both against each other only if the
downgrade path also locks the account row — verify whether `lockMany` takes the same lock;
if not, the two operations could interleave such that the active-count recheck reads a
pre-lock count, potentially allowing a store creation that should have been blocked by a
just-applied downgrade. Flag as an open question if `lockMany`/`unlockOne` don't also acquire
`SELECT ... FOR UPDATE` on `accounts`.

**SM-CONC-04 — Duplicate submission (double-tap) with no unique constraint**
Preconditions: user double-taps "Create Store" — two identical `POST /stores` requests, same
name, near-simultaneous, plenty of room under `max_stores`.
Expected result: **both succeed**, creating two stores with the identical name — no uniqueness
constraint on `stores.name` (schema has no unique index). Confirmed as a real gap (see EDGE-04).

**SM-CONC-05 — Concurrent read (`setup-status`) while a dependency is being written**
Preconditions: A staff invitation is being accepted (flipping `status` to `'accepted'`) at the
same instant `GET /stores/:id/setup-status` runs.
Expected result: the read reflects whichever state committed first — either `staff_invited:
false` (pre-commit) or `true` (post-commit); no partial/inconsistent read, since each check is a
single independent query, not a joined snapshot.

**SM-CONC-06 — permissions_version bumped mid-session by a second store creation**
Preconditions: `U1` (owner) creates store #2 while already holding a valid JWT issued before
store #1... 
Steps: `U1`'s JWT still carries `pv=1`; server-side `permissions_version` now `2`.
Expected result: next authenticated call from `U1` triggers `PermissionsGuard`'s H-6
version-mismatch cache bust (only relevant on RBAC-scoped routes, so this shows up on the *next*
store-scoped call, not on another `POST /stores` itself since that route has no
`@RequirePermissions`). Confirm the mismatch doesn't block the request, only busts the cache.

### 3.7 Permissions / roles

**SM-PERM-01 — Account owner succeeds**
Covered by SM-HP-01. Criticality: Critical.

**SM-PERM-02 — Store-level `STORE_OWNER` (of an existing store) who is not the account owner is
rejected**
Area: permission · Criticality: Critical · Traces to: BR1
Preconditions: `U2` holds `STORE_OWNER` role on store `S1` (assigned by the real owner via
invitation-to-owner-role, if that's possible) but `accounts.owner_user_fk !== U2`.
Expected result: 403 `NOT_ACCOUNT_OWNER` — store-level role, however privileged, never
substitutes for account ownership.

**SM-PERM-03 — Cashier/staff role attempts `POST /stores`**
Expected result: 403 `NOT_ACCOUNT_OWNER` (same gate — ownership check runs before any
RBAC/entity check since the route is `@StoreContext('none')` with no `@RequirePermissions`).

**SM-PERM-04 — `Store.view` granted → setup-status succeeds**
Expected result: 200, as SM-HP-04/05.

**SM-PERM-05 — `Store.view` revoked mid-session**
Preconditions: caller had `Store.view`, role edited to remove it; caller's cached permissions
haven't expired yet.
Expected result: within the cache TTL, the stale cached permission may still allow the read
(document cache staleness window); after TTL/version-bump invalidation, subsequent calls get 403
`PERMISSION_DENIED`. Confirm the acceptable staleness window with product (see Open Questions).

**SM-PERM-06 — User has access to store A but requests setup-status for store B (different
account)**
Expected result: 404 `STORE_NOT_ACCESSIBLE` (BR10) — never a 403 that would confirm existence.

**SM-PERM-07 — Owner account itself is blocked/suspended (`users.is_blocked`)**
Expected result: 401 `USER_BLOCKED` from `MobileJwtGuard`, before store logic runs at all.

**SM-PERM-08 — Device used to call the API is blocked**
Expected result: 401 `DEVICE_BLOCKED` from `MobileJwtGuard`.

### 3.8 State transitions

**SM-ST-01 — [doesn't exist] → [active, unlocked] (create)**
Legal. Covered by SM-HP-01.

**SM-ST-02 — [active, unlocked] → attempt to "re-create" (no-op transition; not a real state
machine action)**
N/A — there is no update endpoint; each `POST /stores` always creates a **new** row (see
SM-CONC-04). Note as a gap: there's no way via this controller to transition an *existing*
store's fields.

**SM-ST-03 — [locked] store excluded from active-count (legal side-effect of a transition made
elsewhere)**
Covered by SM-BR-12.

**SM-ST-04 — [deleted] store excluded from active-count and from `hasAnyStore`**
Covered by SM-BR-13.

**SM-ST-05 — [deleted] store's id reused in `setup-status`**
Preconditions: store soft-deleted (`deleted_at` set) elsewhere; caller who still has (stale)
access-list cache entry queries `GET /stores/{deletedId}/setup-status`.
Expected result: `TenantGuard`'s `resolveAccessibleStore` should exclude soft-deleted stores from
"accessible" — verify; if it doesn't filter `deleted_at`, a deleted store's setup-status would
still be readable, which is likely unintended. Flag as open question if unverified in
`RbacRepository.resolveAccessibleStore` (outside this module's files, but a direct dependency).

**SM-ST-06 — First store transitions the *subscription's* trial state as a side effect**
Covered by SM-BR-05/SM-HP-01 — verify this is treated as a legal, one-time, irreversible
transition (`hasUsedTrial: false → true`) that a later store-deletion cannot undo.

**SM-ST-07 — Illegal: creating a store while `reconciliation_status='pending'`**
Covered by SM-BR-07 — the only "state transition" this module can illegally attempt and must
reject.

### 3.9 Cross-cutting (tenancy, time, consistency)

**SM-X-01 — Tenant isolation: Account A's owner cannot see Account B's store count**
Preconditions: two unrelated accounts, each near their own `max_stores` limit.
Expected result: each account's `max_stores` gate is evaluated solely against its own
`account_fk` — verified by `countActiveStores`/`lockAccount` both scoping on `accountId`.

**SM-X-02 — Tenant isolation: `lockMany`/`unlockOne` cannot affect another account's store**
Expected result: `lockMany`/`unlockOne` both `AND` on `accountId` alongside the store id — even
a client-influenced store-id list from account A can never lock/unlock account B's store. (Not
reachable from this controller directly, but this repository is shared — worth a regression
case given the explicit code comment warning about it.)

**SM-X-03 — Timezone: `accessValidUntil` comparison uses UTC `Date`, not store-local time**
Preconditions: account in `IST` (UTC+5:30), `access_valid_until` = "today 23:59 IST".
Expected result: the guard/service compare using `new Date()` (server/UTC instant) against a
`timestamptz` column — confirm there's no local-timezone misinterpretation; the boundary should
trigger at the correct UTC instant regardless of the owner's local clock.

**SM-X-04 — Trial window exactly at DST transition**
Preconditions: trial start falls on a DST boundary date in a DST-observing locale (edge case for
any client-side display of `trial_ends_at`, even though the backend itself uses UTC timestamps
unaffected by DST).
Expected result: `trialEndsAt = now + 15*24*60*60*1000ms` is a fixed-duration offset, immune to
DST — confirm the *client's* rendering of "15 days from now" doesn't show an off-by-one due to a
DST shift in the display timezone.

**SM-X-05 — Clock skew between app server and DB**
Preconditions: DB server clock drifts from the app server issuing `new Date()` comparisons.
Expected result: `accessValidUntil < new Date()` compares an app-server-generated `Date` against
a DB-stored timestamp — any skew could allow a few seconds of incorrect allow/deny at the exact
boundary. Low-likelihood in a well-run environment; note as a known limitation, not a blocker.

**SM-X-06 — Data consistency: role mapping created atomically with the store**
Covered by SM-FAIL-01/07/08 — no observable window where a store exists without its
`STORE_OWNER` mapping.

**SM-X-07 — Data consistency: snapshot embedded in the response matches the DB state at commit
time**
Preconditions: another concurrent request changes the user's permissions between commit and the
best-effort `snapshot.getOrBuild` call.
Expected result: the embedded snapshot reflects whatever is true *at rebuild time*, which could
technically include the concurrent change too (acceptable — it's a refresh, not a
point-in-time-of-commit guarantee) — confirm this is the intended contract, not a strict
"exactly what was just committed" snapshot.

**SM-X-08 — Offline-then-sync: mobile client queues a store-create while offline**
Preconditions: mobile app is the store-open-gate/offline-sync client described in commit
`df4f97b`; user attempts to create a store while offline.
Expected result: since `POST /stores` is an online, RPC-style, non-queued mutation (not part of
the local-first sync engine's mutation queue for `products`/etc. per the repo's architecture),
confirm the mobile client **disables** "Create Store" while offline rather than queuing it —
queuing an account-level, ownership+limit-gated action for later replay would be unsafe (limit
could be hit by the time it syncs). Flag as a product/mobile-agent open question.

### 3.10 UX / experience (API-contract-level, since this is a backend module)

**SM-UX-01 — Error responses always carry a machine-readable `errorCode`**
Expected result: every rejection path (401/402/403/404/422) returns a body with `errorCode`
(via `AppException`/`parse()`'s `UnprocessableEntityException`) so the mobile client can render
the correct localized message rather than a generic error.

**SM-UX-02 — `STORE_LIMIT_REACHED` details are actionable**
Expected result: 403 body includes `{ limit, current }` so the client can render "You've reached
your plan's limit of {limit} stores — upgrade to add more," not just a bare error string.

**SM-UX-03 — Successful creation returns enough to avoid a round-trip**
Expected result: `snapshot`/`snapshot_signature` non-null on the happy path so the client can
patch its session in place; client must have a defined fallback (`refetchUser()`/bootstrap) when
they're null (SM-FAIL-02).

**SM-UX-04 — Setup-status percentage suitable for a progress bar**
Expected result: always an integer 0–100 in 20-point steps (5 checks) — client can render a
5-segment progress indicator directly off `status_map` rather than only the percentage.

**SM-UX-05 — Double-submission protection is a client responsibility here**
Given SM-FAIL-06/SM-CONC-04 confirm the server has no idempotency key, the mobile "Create Store"
button must disable itself on first tap and show a loading state — call out explicitly to the
mobile-agent scope since the backend provides no dedupe safety net.

---

## 4. Edge-case scenarios (§5 checklist — the ones teams miss)

**EDGE-01 — Empty/zero: creating a store on an account with `max_stores` entitlement row present
but `value=0`**
Same as SM-BND-10 — re-flagged here because "explicit zero" vs "missing row → treated as zero"
(EDGE-06) are two different underlying causes with the identical externally-observable error;
worth a dedicated test to make sure both are actually reachable/seeded distinctly in test data.

**EDGE-02 — First-run: the very first store ever created for a brand-new account, immediately
after signup, before any bootstrap snapshot has been fetched**
Expected result: creation still succeeds and returns its own embedded snapshot even though the
client never called `GET /me/bootstrap` first — confirm `SnapshotService.getOrBuild` doesn't
assume a prior bootstrap call happened.

**EDGE-03 — Maximum/overflow: unicode and emoji in `name`/`address`**
Input: `name: "🏪 माँ दुर्गा जनरल स्टोर"` (emoji + Devanagari, well under 120 chars but
multi-byte). Expected result: 201; stored and returned byte-correct (Zod's `.max(120)` counts
JS string length/UTF-16 code units, not grapheme clusters — verify an input with many
multi-code-unit emoji near the 120 boundary doesn't surprise-fail or surprise-pass relative to
what the client counted as "120 characters").

**EDGE-04 — Duplicate/repeat: identical store name reused**
Covered by SM-CONC-04/SM-NEG-03's sibling — re-flagged: there is **no** business rule anywhere
in this code preventing two stores (same account, or even same owner across two accounts) from
sharing an identical name, GSTIN, phone, or email. If product intent is "GSTIN should be unique
per account" or "no duplicate store names," that's an **unimplemented rule** — confirm with
product (Open Questions) rather than assuming it's out of scope.

**EDGE-05 — Long/unusual input: leading/trailing whitespace never trimmed**
Input: `name: "  Ganesh Supermarket  "`. Expected result (current code): stored with the
whitespace intact (no `.trim()` in the Zod schema or the repository insert) — likely a real
data-quality bug (search/display will show inconsistent padding); flag as a fix candidate.
Also: `name: " "` (single space) passes `.min(1)` and creates a store with an effectively blank
name — see SM-BND-01's real-world implication.

**EDGE-06 — Permission/subscription change mid-flow: plan downgraded to a lower `max_stores`
*while* the create-store request is in flight**
Preconditions: request reads the pre-check limit as `5` (old plan), but the downgrade commits
(new limit `2`, already at `3` active stores) microseconds before this request's transaction
takes the account row lock.
Expected result: the **in-transaction recheck** (not just the pre-check) must use the
now-downgraded limit, since `EntitlementService.get()` is called again inside the transaction
after `lockAccount` — confirm the downgrade's own write also takes a lock or at least commits
before this transaction's recheck reads a consistent value (see SM-CONC-03 for the deeper
version of this same question).

**EDGE-07 — Abandonment: client creates a store, then the app is killed before the response
(and its embedded snapshot) is processed**
Expected result: the store is already durably committed server-side; on next app launch the
client must discover the new store via a normal bootstrap call — confirm there's no
client-side "pending create" state that could be lost and never reconciled (mobile-side, flagged
for the mobile agent, not this backend module, but worth stating the contract explicitly: the
server has no notion of a "pending" store, only committed-or-nothing).

**EDGE-08 — Out-of-order: `setup-status` polled before the creation's cache invalidation has
propagated**
Preconditions: store just created; `setup-status` called for it in the same second by the
creator, whose local Redis-cached "accessible stores" list write raced the read.
Expected result: `TenantGuard`'s `userStoreIds` read must reflect the just-created store —
since `rbac.invalidateUserStoreCache` runs synchronously before the `POST /stores` response is
returned, any subsequent request (necessarily after the response) should see a consistent,
already-invalidated cache. Verify there's no async/fire-and-forget gap.

**EDGE-09 — Connectivity: mobile client goes offline immediately after firing `POST /stores`,
before the response arrives**
Same underlying risk as SM-FAIL-06 — reconfirm the client cannot tell success from failure
without a subsequent bootstrap/list call, and must not blindly retry (would double-create, per
EDGE-04's lack of dedupe).

**EDGE-10 — State edge: querying `setup-status` for a `locked` store**
Preconditions: store is `locked=true` (downgrade). Caller still has `Store.view`.
Expected result: since `setup-status` is a `GET` and `SubscriptionStatusGuard`'s `isLocked`
check only fires for **writes**, reads on a locked store should still succeed — confirm
`getSetupStatus` doesn't unexpectedly special-case locked stores (it doesn't appear to in the
code read) and returns real data even while locked.

**EDGE-11 — Device/platform: extremely slow/low-end device timing out mid-`POST /stores`**
Expected result: client-side timeout before the server's transaction completes — the server
still completes and commits regardless of whether the client is still listening; a client
retry after its own timeout re-hits EDGE-04/SM-FAIL-06's duplicate-creation risk.

**EDGE-12 — GSTIN entity-code letter (real GSTINs sometimes use a letter, not only a digit, for
the 13th character when an entity has >9 registrations on one PAN)**
Input: a real-world GSTIN whose entity code is a letter, e.g. `27AAPFU0939FAZ5` (hypothetical
per spec, entity code 'A' instead of a digit). Expected: the current regex hardcodes `\d` for
that position, so any account with more than 9 registrations under one PAN in one state can
**never** register a valid GSTIN here — a second facet of Bug-2, worth its own confirmation with
product/tax-compliance since it's a real (if rare) production scenario.

**EDGE-13 — First-run/migration: an account whose subscription predates the
`reconciliation_status` column (backfilled default `'none'`)**
Expected result: `'none'` never matches the `'pending'` block, so pre-migration accounts are
unaffected — confirm the backfill migration actually defaulted every existing row to `'none'`
and not `NULL` (a `NULL` would fail the `eq(..., 'pending')` comparison silently either way, but
worth confirming column has a `NOT NULL DEFAULT` in the schema).

---

## 5. Coverage summary matrix

| Requirement / Rule / Transition | Satisfied case(s) | Violated case(s) | Gap? |
|---|---|---|---|
| BR1 Ownership gate | SM-HP-01, SM-PERM-01 | SM-BR-01, SM-BR-02, SM-PERM-02, SM-PERM-03 | none |
| BR2 Subscription write-gate — paused | SM-BR-06 (via active) | SM-BR-03 | none |
| BR2 — expired | n/a (blocked state) | SM-BR-04 | none |
| BR2 — access window closed | SM-BR-06 | SM-BR-05, SM-BND-12 | none |
| BR2 — reconciliation pending | n/a | SM-BR-07 | none |
| BR2 — no subscription row | SM-BR-08 (allowed through this gate) | — (blocked downstream by BR3 instead) | note asymmetry, Q1 |
| BR3 max_stores gate | SM-HP-02, SM-BR-10, SM-BR-11, SM-BR-12, SM-BR-13, SM-BND-11 | SM-BR-09, SM-BND-10, EDGE-01 | none |
| BR3 TOCTOU (in-tx recheck) | SM-CONC-02 | SM-CONC-01 | none |
| BR4 Atomicity | SM-HP-01 | SM-FAIL-01, SM-FAIL-07, SM-FAIL-08, SM-FAIL-09 | none |
| BR5 First-store trial start | SM-HP-01, SM-ST-06 | SM-HP-02 (must NOT restart) | none |
| BR6 Cache/snapshot invalidation | SM-HP-01, EDGE-08 | SM-FAIL-02, SM-FAIL-03 | see Q2 (unhandled throw?) |
| BR7 GSTIN format | SM-BND-13 | SM-BR-14 | **SM-BR-15/EDGE-12: regex itself appears broken — Bug-2** |
| BR8 Field validation | SM-HP-03, SM-BND-01/03/06/08 | SM-BND-02/04/05/07/09, SM-NEG-02, SM-BR-16 | EDGE-05 (no trim) is a gap |
| BR9 Setup-status computation | SM-HP-05 | SM-HP-04 (all-false state) | none |
| BR10 Tenant isolation (404 parity) | — | SM-NEG-08, SM-NEG-09, SM-PERM-06 | none |
| BR11 Reads bypass write-gate | EDGE-10 | n/a (nothing to violate — it's a bypass rule) | none |
| State: create | SM-ST-01 | n/a (no illegal "create" input state) | none |
| State: locked exclusion | SM-ST-03, SM-BR-12 | n/a | none |
| State: deleted exclusion | SM-ST-04, SM-BR-13 | SM-ST-05 (verify TenantGuard also excludes deleted) | **possible gap — confirm** |
| Concurrency: create-vs-create at limit | SM-CONC-02 | SM-CONC-01 | none |
| Concurrency: create-vs-downgrade-lock | — | SM-CONC-03 | **open — confirm lockMany takes account lock** |
| Idempotency / duplicate submission | — | SM-CONC-04, SM-FAIL-06, EDGE-04, EDGE-09 | **gap — no server-side dedupe; must be client-mitigated** |

**Gaps identified (no code path currently addresses these):**
1. No idempotency key / dedupe on `POST /stores` — double-submit or retry-after-timeout creates
   duplicate stores (EDGE-04, EDGE-09, SM-FAIL-06, SM-CONC-04).
2. No uniqueness constraint on `stores.name` or `stores.gst_number` per account — confirm
   whether product wants one.
3. `name`/`address`/`phone` are never trimmed — leading/trailing whitespace persists (EDGE-05).
4. Unverified whether `TenantGuard.resolveAccessibleStore` filters out soft-deleted stores
   (SM-ST-05) — this file's repository wasn't in scope to confirm; flag for the RBAC module's own
   QA pass.
5. Unverified whether the downgrade-lock path (`lockMany`) takes the same `accounts` row lock as
   store creation, closing the same TOCTOU class of race (SM-CONC-03).

---

## 6. Priority roll-up (run these first)

**Critical — run before anything else:**
1. **SM-BR-15 / Bug-2** — verify real GSTINs are actually accepted or confirm the regex bug with
   a live request. This alone can block every merchant with a valid GSTIN from ever completing
   store setup.
2. **SM-HP-01 / Bug-1** — verify `POST /stores` actually returns 201 at all through the real
   guard chain (not just via a direct service-level unit test). If the guard-ordering issue
   described in §7 is real, **the endpoint is completely broken in production** regardless of
   every other rule being correctly implemented in the service.
3. SM-BR-01, SM-BR-03, SM-BR-04, SM-BR-07, SM-BR-09 — the core deny-paths (ownership, suspended,
   expired, reconciliation-pending, at-limit).
4. SM-CONC-01 — the TOCTOU race on the last available store slot; a failure here means paying
   customers can be over-provisioned past their plan.
5. SM-FAIL-01/07/08/09 — transactional atomicity; a partial store (e.g. store row without its
   owner role) would leave an account owner locked out of their own new store.

**High — next:**
- SM-BR-05/BR-12/BR-13 (trial-start correctness, locked/deleted exclusion from the limit)
- SM-PERM-02/03 (store-level privilege never substitutes for account ownership)
- SM-NEG-08/09 (tenant-isolation 404 parity)
- SM-CONC-04/EDGE-04 (duplicate-submission gap — confirm severity with product)

**Medium/Low:** boundary length checks (SM-BND-*), UX contract checks (SM-UX-*), cosmetic
rounding (SM-BND-14), unicode/emoji handling (EDGE-03).

---

## 7. Open questions

**Q0 — Bug-1 (Critical, needs immediate dev confirmation): does `POST /stores` actually work at
all today?**
`StoreController.create()` is decorated `@StoreContext('none')`. `TenantGuard.canActivate`
returns `true` immediately for `source === 'none'` **without ever writing `request.context`**
(only a real scope populates it — `tenant.guard.ts:70`, gated by the `if (!source || source ===
'none') return true;` short-circuit above it). `SubscriptionStatusGuard.canActivate` then runs
(it's in the controller's class-level `@UseGuards(...)`, applying to every method including
`create`) and unconditionally does:
```ts
const accountId = this.resolveAccountId(req); // reads req.context?.accountId
if (!accountId) throw new ForbiddenException('STORE_CONTEXT_MISSING');
```
— **before** it even checks whether the method is a read or is `@AllowExpiredSubscription`. Since
`create()` has neither a real `@StoreContext` scope nor `@AllowExpiredSubscription`, `req.context`
is `undefined` and this throws on **every single call**, success or not. `StoreService`'s own
`assertAccountCanWrite` comment even says outright: *"same contract as SubscriptionStatusGuard,
which can't run on this store-unscoped route"* — strongly suggesting the original author
believed/intended this guard to be skipped here, which the code as written does not actually do.
I found no interceptor, middleware, or other guard anywhere in the backend that populates
`request.context` ahead of `SubscriptionStatusGuard` for an account-level route, and no existing
integration/e2e test exercises `POST /stores` through the real HTTP guard chain (only isolated
unit/service tests exist). **This needs to be run against a live server today** to confirm
whether it's actually broken, or whether something outside the files reviewed compensates for
it (e.g. a different guard registration in a bootstrap/module file not covered by this review).
If confirmed broken, the fix is presumably either exempting this route from
`SubscriptionStatusGuard` (e.g. its own `@UseGuards` override without that guard, replaced by the
service's `assertAccountCanWrite`, which already fully covers the same rules) or teaching
`SubscriptionStatusGuard` to resolve the account id directly from the principal/JWT when there's
no store context.

**Q1 — Bug-2: GSTIN regex.** `GSTIN_REGEX` in `create-store.dto.ts` is
`^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]Z[0-9A-Z]$` — 16 required characters. Real GSTINs are 15
characters (`state(2) + PAN(10) + entityCode(1) + 'Z'(1) + checksum(1)`). Verified against
several real/reference GSTINs (e.g. `29AAAPL1234C1Z5`, `27AAPFU0939F1ZV`,
`07AABCU9603R1ZM`) — **none** match. The regex appears to have one extra `[A-Z]` group before
the literal `Z`. Please confirm with whoever owns GSTIN validation whether this was ever tested
against a real GSTIN, and whether the intended pattern is
`^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$` (15 chars, entity code alphanumeric) instead.

**Q2 — Is `assertAccountCanWrite`'s "no subscription row → allow through" behavior actually
reachable in a meaningful way**, given `EntitlementService.get()` treats the same missing-row
condition as `max_stores = 0`? If so, the two code paths agree on the outcome (blocked) but via
different error codes depending on exactly *which* row is missing (`account_subscriptions` vs.
`plan_entitlements`) — worth confirming the client handles both `SUBSCRIPTION_*` and
`STORE_LIMIT_REACHED` gracefully for what is, from the user's perspective, the same
"my account isn't set up right" situation.

**Q3 — Post-commit cache invalidation failure handling** (`rbac.invalidateUserStoreCache`,
`snapshot.invalidate`): are these calls wrapped in a try/catch anywhere upstream (e.g. in
`UnitOfWork` or a global interceptor) so that a Redis failure *after* a successful DB commit
never surfaces as a 500 to the client for what is otherwise a fully successful store creation?
The snapshot *rebuild* (`getOrBuild`) is explicitly wrapped in `try/catch` in the code read, but
`invalidateUserStoreCache`/`snapshot.invalidate` immediately before it are not visibly wrapped in
`store.service.ts` — confirm whether they have internal resilience or need it added.

**Q4 — Is `stores.is_active` intentionally unused by this entire module?** It exists in the
schema with a `true` default but is never set, read, or filtered on anywhere in
`store.controller.ts`/`service.ts`/`repository.ts`. If it's meant to be a "soft off/on" switch
distinct from `locked`/`deleted_at`, no code path currently exposes or enforces it.

**Q5 — Product-intent confirmation for uniqueness**: should `stores.name` and/or
`stores.gst_number` be unique per account (or globally, for GSTIN)? Today neither is
constrained at the DB or application level (EDGE-04).

**Q6 — Should `POST /stores` be idempotent** (e.g. via a client-supplied idempotency key or
request-id), given mobile clients on flaky connections are its primary caller and a
timeout-then-retry is a realistic, not hypothetical, sequence (SM-FAIL-06, EDGE-09)?

**Q7 — Confirm the "store-open gate" mentioned in the task is out of scope for this backend
module** (per Assumption A1) — i.e., there is no planned backend concept of a store being
"open"/"closed" for transacting (as distinct from `locked`/`is_active`/`deleted_at`), and the
commit-history reference is purely the mobile app's local-DB readiness gate.