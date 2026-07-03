# Subscription & Billing — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** plans, billing, lifecycle, grace, expiry, downgrade, feature gating, freshness, and the
> offline write-gate — every flow detailed.
> **Model:** **Account (Organization)** — the subscription belongs to the **Account**, not to any
> individual user. Users belong to the account; stores, locations, devices, and billing all live
> under the account. A user's role inside the account determines what they can manage.
> **Companion:** the offline-expiry handshake lives in
> [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1).
> Unsettled choices are marked **DECISION**; current-vs-target backend gaps marked **GAP**.

---

## Table of contents
1. [Overview](#1-overview)
2. [The Account entity — why not user-owned](#2-the-account-entity--why-not-user-owned)
2A. [Account model — what the plan grants](#2a-account-model--what-the-plan-grants)
2B. [Database structure](#2b-database-structure)
3. [Plan catalog & tiers](#3-plan-catalog--tiers)
4. [Subscription status — states & meaning](#4-subscription-status--states--meaning)
5. [Status state machine](#5-status-state-machine)
6. [Grace period & `access_valid_until`](#6-grace-period--access_valid_until)
7. [Enforcement — reads vs writes](#7-enforcement--reads-vs-writes)
8. [S1 — Trial start](#8-s1--trial-start)
9. [S2 — Upgrade / checkout (Razorpay)](#9-s2--upgrade--checkout-razorpay)
10. [S3 — Renewal](#10-s3--renewal)
11. [S4 — Payment failure → past_due → grace → lapse](#11-s4--payment-failure--past_due--grace--lapse)
12. [S5 — Cancel (at period end)](#12-s5--cancel-at-period-end)
13. [S6 — Reactivate](#13-s6--reactivate)
14. [S7 — Downgrade (fewer stores / locations / devices)](#14-s7--downgrade-fewer-stores--locations--devices)
15. [S8 — Expiry → all stores read-only](#15-s8--expiry--all-stores-read-only)
15B. [S9 — Ownership / role change (account_users)](#15b-s9--ownership--role-change-account_users)
15C. [S10 — Staff limit (`max_users_per_store`)](#15c-s10--staff-limit-max_users_per_store)
15D. [S11 — Location limit (`max_locations_per_store`)](#15d-s11--location-limit-max_locations_per_store)
16. [Subscription freshness — how the client learns status](#16-subscription-freshness--how-the-client-learns-status)
17. [Feature gating](#17-feature-gating)
18. [Error contracts](#18-error-contracts)
19. [Banners & severity](#19-banners--severity)
20. [Offline behaviour](#20-offline-behaviour)
21. [RBAC](#21-rbac)
22. [Screens](#22-screens)
22B. [Loading states (per flow)](#22b-loading-states-per-flow)
23. [Business rules](#23-business-rules)
24. [Validation matrix](#24-validation-matrix)
25. [Real-world scenarios](#25-real-world-scenarios)
26. [Design issues & decisions](#26-design-issues--decisions)
27. [Backend changes required](#27-backend-changes-required)
28. [Phase 2 / Phase 3 — deferred](#28-phase-2--phase-3--deferred)

---

## 1. Overview

The Subscription module is the **commercial entitlement** layer: it decides what a business account
can do (how many stores, locations, devices, staff, which features) and whether those stores can
**transact**. It is deliberately **separate from authorization** (RBAC / permission snapshot) — see
[§26 D-SUB-01](#26-design-issues--decisions). Authorization says *"this user may create a product";*
subscription says *"this account is paid up and may write."*

The **Account** is the top-level business entity — think of it as the company ("ABC Super Market Pvt Ltd").
Users, stores, billing, and the subscription all belong to the account. No single user owns the
subscription; the account does. This is the standard multi-tenant SaaS architecture and it makes
every future enterprise feature — multiple owners, billing contacts, ownership transfer, franchises —
a configuration change rather than a schema redesign.

**It enables:** trial on signup · plan catalog & upgrade (Razorpay) · renewal & payment-failure
handling with grace · cancel/reactivate · downgrade with non-destructive store/location/device locking ·
feature gating · and an **offline-first write-gate** so a lapsed account neither loses real sales nor
sells indefinitely for free.

**Core principle:** **reads are never blocked; only writes are gated.** A shop can always view its
own data (history, reports, exports) even when lapsed.

---

## 2. The Account entity — why not user-owned

Attaching a subscription directly to a user creates problems the moment customers ask for:
ownership transfer, co-owners, an accountant who pays but doesn't manage stores, or a company whose
CEO owns the business but a finance manager handles billing. Every one of these requires awkward
data migration if the subscription lives on a user row.

**The Account model solves all of these cleanly:**

```
Account (Organization / Tenant)
│
├── account_subscription        ← subscription belongs here, not to any user
│
├── account_users               ← users belong to the account, with roles
│     ├── role: owner
│     ├── role: co_owner
│     ├── role: manager
│     ├── role: cashier
│     └── role: accountant
│
├── Stores
│     ├── Store A
│     │     ├── Head Office     ← auto-created, always slot 1
│     │     ├── Branch Chennai
│     │     ├── Devices
│     │     └── Staff assignments
│     └── Store B
│           ├── Head Office
│           └── Devices
│
├── Billing (Razorpay customer, invoices, payment methods)
│
└── Organization Settings (GST number, billing address, name)
```

**Owner change example.** Today owner = Raj; tomorrow owner = Kumar. What changes?

```diff
- account_users(user=Raj, role='owner')
+ account_users(user=Kumar, role='owner')
```

Nothing else moves. Subscription, stores, devices, invoices, payment history — all remain on the
account unchanged.

**Why this is the correct model (and not the alternative):**
- `user_subscription` couples billing to a person → impossible to transfer cleanly.
- Per-store subscription (`store_subscription`) multiplies billing rows → impossible to enforce a
  single account-wide plan.
- `account_subscription` is the single source of truth for what the entire business is entitled to.

---

## 2A. Account model — what the plan grants

One `account_subscription` per account. The plan defines two distinct categories:

### Entitlements — quantitative limits (`plan_entitlements` table, integer)

| Entitlement key | Scope | Free | Basic | Premium | Professional | Enterprise |
|---|---|---|---|---|---|---|
| `max_stores` | **Account** | 1 | 1 | 2 | 5 | ∞ |
| `max_locations_per_store` | **Store** | 1 | 1 | 3 | 5 | ∞ |
| `max_devices_per_store` | **Store** | 1 | 3 | 5 | 10 | ∞ |
| `max_users_per_store` | **Store** | 2 | 5 | 10 | ∞ | ∞ |
| `max_products` | **Store** | 50 | ∞ | ∞ | ∞ | ∞ |

> `NULL` = unlimited. Enforcement: `currentCount < limit` (strict less-than). A present row with
> `value = NULL` means unlimited; a missing row means the feature is unavailable for that plan.

### Features — boolean capabilities (`plan_features` table, boolean)

| Feature key | Free | Basic | Premium | Professional | Enterprise |
|---|---|---|---|---|---|
| `gst_invoicing` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `offline_mode` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `barcode_scanning` | ✗ | ✓ | ✓ | ✓ | ✓ |
| `inventory_management` | ✗ | ✓ | ✓ | ✓ | ✓ |
| `multi_location` | ✗ | ✗ | ✓ | ✓ | ✓ |
| `advanced_reports` | ✗ | ✗ | ✓ | ✓ | ✓ |
| `loyalty_program` | ✗ | ✗ | ✓ | ✓ | ✓ |
| `api_access` | ✗ | ✗ | ✗ | ✗ | ✓ |
| `white_label` | ✗ | ✗ | ✗ | ✗ | ✓ |
| `priority_support` | ✗ | ✗ | ✗ | ✗ | ✓ |

> `true` = enabled; `false` or missing row = locked.
> `multi_location` must always match `max_locations_per_store > 1` (never contradict each other).

### Why the split matters

**Validation is different by category:**
- **Entitlement check:** `currentCount < plan_entitlements[key]` — count vs integer limit.
- **Feature check:** `plan_features[key] === true` — boolean gate only.

Mixing them in a single flat `features` object forces the reader to guess the type, creates
`FEATURE_TYPES` hacks, and makes the `FeatureGate` component more complex than it needs to be.

**UI is different by category:**
- Entitlement limits: "You've used 3/5 locations — upgrade for more."
- Feature locks: "Advanced reports are not included in your plan — upgrade to unlock."

**Status and grace/expiry** are on `account_subscription` itself, not in either table.

- **One bill per account.** `max_stores` is the account cap (enforced at store-create,
  [device-management.md F0](./device-management.md#5b-f0--store-creation-gate-account-max_stores)).
- **"3 locations" means 3 _per store_**, inclusive of the **Head Office** auto-provisioned
  at store creation. A plan with `max_locations_per_store = 1` is single-location-only.
- **"5 devices" means 5 _per store_** (enforced at `/access`,
  [device-management.md F2](./device-management.md#7-f2--store-access--device-limit-check)).
- **Each store's limits are independent** — Store A at 5/5 locations does not reduce Store B's budget.

---

## 2B. Database structure

**Target schema** (replaces `user_subscription` + `store_subscription`):

```sql
-- Top-level tenant / organization
accounts
  id              uuid PK
  name            text          -- "ABC Super Market Pvt Ltd"
  gst_number      text
  billing_address jsonb
  razorpay_customer_id text
  created_at      timestamptz

-- One subscription per account (replaces user_subscription + store_subscription)
account_subscription
  id              uuid PK
  account_fk      uuid → accounts.id   UNIQUE  -- one plan per account
  plan_fk         uuid → subscription_plan.id
  status          text    -- trialing | active | past_due | free | cancelled | paused
  trial_ends_at   timestamptz
  current_period_start timestamptz
  current_period_end   timestamptz
  past_due_grace_until timestamptz
  access_valid_until   timestamptz  -- max(current_period_end, past_due_grace_until)
  cancel_at_period_end boolean default false
  subscription_version integer default 0  -- freshness counter, bumped on every transition
  has_used_trial  boolean default false
  created_at      timestamptz

-- M:M users ↔ accounts with roles
account_users
  id          uuid PK
  account_fk  uuid → accounts.id
  user_fk     uuid → users.id
  role        text  -- 'owner' | 'co_owner' | 'manager' | 'cashier' | 'accountant'
  UNIQUE (account_fk, user_fk)

-- Stores belong to the account (NOT to a user)
stores
  id          uuid PK
  account_fk  uuid → accounts.id   ← replaces owner_user_fk
  name        text
  locked      boolean default false  -- true when store is over-cap on downgrade
  ...

-- (drop store_subscription entirely)

-- Quantitative limits per plan (replaces mixed plan_feature numeric rows)
plan_entitlements
  id          uuid PK
  plan_fk     uuid → subscription_plan.id
  key         text  -- 'max_stores' | 'max_locations_per_store' | 'max_devices_per_store'
                    --   | 'max_users_per_store' | 'max_products'
  value       integer  -- NULL = unlimited
  UNIQUE (plan_fk, key)

-- Boolean capabilities per plan (replaces mixed plan_feature boolean rows)
plan_features
  id          uuid PK
  plan_fk     uuid → subscription_plan.id
  key         text  -- 'gst_invoicing' | 'offline_mode' | 'barcode_scanning'
                    --   | 'inventory_management' | 'multi_location' | 'advanced_reports'
                    --   | 'loyalty_program' | 'api_access' | 'white_label' | 'priority_support'
  enabled     boolean
  UNIQUE (plan_fk, key)
```

> **Why two tables, not one with a `kind` column?**
> A single `plan_feature(key, kind, value_integer, value_boolean)` table has two nullable columns
> where only one is ever populated — the reader must branch on `kind` to pick the right column, and
> a seed bug (wrong column populated) silently passes validation. Two tables enforce the contract at
> the schema level: `plan_entitlements` always has an integer (or null for unlimited),
> `plan_features` always has a boolean. No ambiguity, no runtime type dispatch.

**Migration from current state:**
1. Create `accounts` — one row per existing owner-user.
2. Create `account_users` — copy existing owner role.
3. Add `stores.account_fk` — derive from existing `stores.owner_user_fk` via the new account row.
4. Create `account_subscription` — copy rows from `user_subscription`.
5. Drop `store_subscription`, `stores.owner_user_fk`, `user_subscription`.

**GAP:** all five migration steps are pending ([§27](#27-backend-changes-required)).

---

## 3. Plan catalog & tiers

**Endpoints (exist):** `GET /subscription/plans` (active, available-for-new; cache 24h),
`GET /subscription/plans/:code`.

`SubscriptionPlanDto`: `code, name, description, pricePaise, currency, billingFrequency
('free'|'monthly'|'annual'|'one_time'), billingPeriodDays, trialDays, features, isActive,
availableForNew, upgradeToCode, downgradeToCode, displayOrder`.

**Seeded catalog (as implemented — `seedSubscriptionPlans`).** Each paid tier has a **monthly + annual**
variant (annual ≈ 17% off); Enterprise is **monthly-only today** (see §3.1).

**Entitlements** (`plan_entitlements`):

| Tier | Monthly | Annual | `max_stores` | `max_locations` /store | `max_devices` /store | `max_users` /store | `max_products` /store |
|---|---|---|---|---|---|---|---|
| **Free** | ₹0 | — | 1 | 1 | 1 | 2 | 50 |
| **Basic** | ₹499 | ₹4,999 | 1 | 1 | 3 | 5 | ∞ |
| **Premium** | ₹999 | ₹9,999 | 2 | 3 | 5 | 10 | ∞ |
| **Professional** | ₹1,499 | ₹14,999 | 5 | 5 | 10 | ∞ | ∞ |
| **Enterprise** | ₹4,999 | — | ∞ | ∞ | ∞ | ∞ | ∞ |

> `∞` = `NULL` in `plan_entitlements.value` (unlimited). `max_locations` is **inclusive of Head
> Office** — a value of `1` means no branches; `3` means Head Office + 2 branches.

**Features** (`plan_features`, `enabled = true` if checked):

| Feature key | Free | Basic | Premium | Professional | Enterprise |
|---|---|---|---|---|---|
| `gst_invoicing` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `offline_mode` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `barcode_scanning` | — | ✓ | ✓ | ✓ | ✓ |
| `inventory_management` | — | ✓ | ✓ | ✓ | ✓ |
| `multi_location` | — | — | ✓ | ✓ | ✓ |
| `advanced_reports` | — | — | ✓ | ✓ | ✓ |
| `loyalty_program` | — | — | ✓ | ✓ | ✓ |
| `api_access` | — | — | — | — | ✓ |
| `white_label` | — | — | — | — | ✓ |
| `priority_support` | — | — | — | — | ✓ |

*(All prices/limits are seeded config — not hardcoded. `NULL` entitlement = unlimited.)*

> **⚠️ DECISION — `Premium` vs `Professional` overlap.** Both are **2 stores + advanced reports + loyalty**;
> Premium is just cheaper (₹999) with fewer devices (5) and capped users (10), Professional (₹1,499) adds
> 10 devices + unlimited users/products. Customers can't easily tell them apart. **Pick one:** either keep
> the 5-tier ladder (this table) and own the distinction in marketing copy, **or** drop `Premium` and make
> the trial default + mid tier `Professional` (or `Basic`). The backend **trial default is
> `premium_monthly`** (`SUBSCRIPTION_PLAN_CODES.PREMIUM_MONTHLY`), so dropping Premium requires
> re-pointing the trial seed (§8). Until decided, the catalog stays 5-tier.

### 3.1 Plan-config rules (seed correctness)
These are the rules the seed (`plan_entitlements` + `plan_features` + `subscription_plan`) must satisfy:

1. **Upgrade/downgrade ladder is per-frequency and complete** — never skip a tier or cross billing
   frequency. Monthly: `free → basic_monthly → premium_monthly → professional_monthly → enterprise_monthly`.
   Annual must mirror it: `free → basic_annual → premium_annual → professional_annual → enterprise_annual`.
   (Bugs to fix: `basic_annual.upgradeToCode` must be `premium_annual` not `professional_annual`;
   `professional_monthly.downgradeToCode` must be `premium_monthly` not `basic_monthly`;
   `professional_annual.upgradeToCode` must not point at a **monthly** code.)
2. **Enterprise Annual** — add `enterprise_annual` so annual customers have an in-frequency upgrade target,
   **or** keep Enterprise monthly-only and resolve the annual→enterprise upgrade in service logic (don't
   store a monthly code as the "upgrade" from an annual plan).
3. **`trialDays` is decoupled from the catalog.** Set `trialDays: 0` on **all** plans; trial length comes
   from a **service constant** (`TRIAL_DAYS`) and the `account_subscription.has_used_trial` flag — so
   a fresh trial can't be re-triggered by upgrading/downgrading. *(Caveat: the current trial bootstrap
   reads `plan.trialDays` from the default trial plan, so this change must land together with the
   service-constant + has_used_trial change, else the trial becomes 0 days.)*
4. **Entitlement reader contract.** `plan_entitlements` rows have an integer `value`.
   `value = NULL` means **unlimited** (no check). A **missing row** means the entitlement is
   unavailable (treat as `0` — blocked). Reader: `const limit = row?.value ?? 0; if (limit !== null && count >= limit) REJECT`.
5. **Feature reader contract.** `plan_features` rows have a boolean `enabled`.
   `enabled = true` → allowed. `enabled = false` or missing row → locked.
   Never store a feature's name in `plan_entitlements` or vice-versa — the two tables have
   non-overlapping key sets. Add a seed-time assertion: no key appears in both tables.
6. **Re-seed is idempotent AND updating.** Both `plan_entitlements` and `plan_features` have a
   `UNIQUE (plan_fk, key)` index. Use `onConflictDoUpdate` (not `onConflictDoNothing`) so a
   re-run updates changed values. Batch all rows per table into **one** insert call.
7. **`max_locations_per_store` must be ≥ 1.** Head Office is pre-provisioned at store-create and
   consumes one slot; enforcement uses `currentLocationCount < limit` (strict less-than, not `<=`).
   Setting this to `0` in the seed is a data error — the store is created with a Head Office that
   already violates its own limit. Add a seed assertion: `value IS NULL OR value >= 1`.
   `multi_location` in `plan_features` must be `true` on every plan where
   `plan_entitlements(max_locations_per_store).value > 1`. Seed must assert these are consistent.

---

## 4. Subscription status — states & meaning

Enum (verified): `trialing | active | past_due | free | cancelled | paused` (+ derived `expired`).

| Status | Meaning | Writes | Reads |
|---|---|---|---|
| `trialing` | In trial window | ✅ | ✅ |
| `active` | Paid & current | ✅ | ✅ |
| `free` | Free tier (or no subscription row → fallback) | ✅ (within free limits) | ✅ |
| `past_due` (in grace) | Payment failed, within 7-day grace | ✅ + warning | ✅ |
| `past_due` (grace over) | Grace elapsed | ❌ **402** | ✅ |
| `cancelled` (before period end) | Cancelled, still in paid period | ✅ + notice | ✅ |
| `cancelled` (period over) | Period elapsed | ❌ **402** | ✅ |
| `expired` (derived) | `cancelled` + period elapsed (snapshot synthesises) | ❌ | ✅ |
| `paused` | Admin/abuse suspension | ❌ **403** | ✅ |

**Rule:** writes blocked only after the entitlement window closes; **reads always allowed.**

---

## 5. Status state machine

```
                 signup/create-store
                       │
                       ▼
                  ┌──────────┐  pick free      ┌──────┐
                  │ trialing │ ───────────────▶ │ free │
                  └────┬─────┘                  └──┬───┘
            pay/upgrade│       trial ends, no pay   │ upgrade
                       ▼            (→ cancelled)    ▼
                  ┌────────┐ ◀───────────────── ┌────────┐
       renew ✓ ─▶ │ active │   payment fails    │ active │
                  └───┬────┘ ─────────────────▶ ┌──────────┐
              cancel  │                          │ past_due │ (grace 7d)
                      ▼                          └────┬─────┘
                 ┌──────────┐  period ends            │ grace ends (unpaid)
                 │cancelled │ ──────────▶ expired      ▼
                 └──────────┘            (write-blocked) write-blocked
       admin suspend ──────────────────▶ ┌────────┐
                                          │ paused │ (full block)
                                          └────────┘
```

Transitions are **account-level** — one plan governs all stores under the account. A single status change (e.g. `active → past_due`) applies simultaneously to every store the account owns.

---

## 6. Grace period & `access_valid_until`

- **Grace = 7 days** (`GRACE_DAYS`), only for `past_due`. **Not 1 day** — too short for Indian retail
  (UPI failures, weekends, festivals). Escalating reminders at day 0 / 3 / 6.
- **Never gradual.** Degradation is **binary**: in-window = full; window closed = read-only.
- **The single field that drives offline gating** —
  `access_valid_until = max(current_period_end, past_due_grace_until)` (null/now for `paused`).
  This is what the device caches to gate writes offline; see
  [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1).

---

## 7. Enforcement — reads vs writes

Two layers (mirrors the auth model):
1. **Client-side optimistic gate** — banner + write-UI gating off the cached subscription snapshot.
2. **Server-side authoritative gate** — `SubscriptionStatusGuard` re-checks on every **store-scoped
   write**; the client can never be more permissive than the server.

| Method | Gated? |
|---|---|
| `GET / HEAD / OPTIONS` (reads) | **Never blocked** |
| `POST / PUT / PATCH / DELETE` (writes) | Blocked when the entitlement window is closed |

Server outcomes on a blocked write:
- past_due grace-over / cancelled period-over / expired → **402 `subscription_payment_required`**
- paused → **403 `subscription_suspended`**
- feature limit hit → **403 `subscription_feature_limit_reached`** (`error.details.feature` set)
- store cap hit → **403 `STORE_LIMIT_REACHED`** (`error.details.{ limit, current }`)
- location cap hit → **403 `LOCATION_LIMIT_REACHED`** (`error.details.{ limit, current }`)
- device cap hit → **403 `DEVICE_LIMIT_REACHED`** (`error.details.{ limit, current }`)
- staff cap hit → **403 `USER_LIMIT_REACHED`** (`error.details.{ limit, current }`)

---

## 8. S1 — Trial start

**Trigger:** user signs up.
**Steps:**
1. `POST /auth/signup` → **Account created** atomically in the same transaction:
   - `accounts` row (name from signup form, or placeholder "My Business").
   - `account_users` row (`role = 'owner'`).
   - `account_subscription` row (`status = 'trialing'`, `trial_ends_at = now + TRIAL_DAYS`,
     `access_valid_until = trial_ends_at`, `has_used_trial = true`).
2. User creates first **Store** (required to reach POS):
   - `stores` row with `account_fk` (not user FK).
   - **Head Office location** provisioned atomically inside the store-create transaction
     (`is_primary = true`, `display_order = 0`) — consumes 1 slot of `max_locations_per_store`.
     The store always has exactly one location on creation.
3. Full access to the trial plan's features; `show_upgrade_banner` drives the countdown banner (§19).
**Routing:** lands in POS; trial banner visible. No payment required to start.
**Note:** `has_used_trial = true` is set at account creation — not at plan selection. This prevents
gaming the trial by downgrading and re-trialing.

---

## 9. S2 — Upgrade / checkout (Razorpay)

**Endpoints (current — store-scoped):**
- `POST /stores/:storeId/subscription/checkout` → `POST /stores/:storeId/subscription/verify`

**GAP:** Checkout and verify remain store-scoped. Account-scoped `POST /me/account/subscription/checkout|verify`
are NOT built — this is listed as §27 items 13–14 (Phase 2).

**Flow:**
1. Plans list → plan detail → "Upgrade" → **step-up auth** (sensitive action; owner/co_owner only).
2. `checkout` → server creates a Razorpay order linked to `account_subscription`; returns
   `{ razorpay_key, order_id, amount, currency, plan_name, prefill }`.
   - `prefill` uses the account's billing contact (owner or designated accountant), not the
     currently logged-in user's personal details.
3. Client launches Razorpay SDK.
4. On success → `verify` (server validates Razorpay signature, calls `activateFromPayment()`).
5. Server: `account_subscription.status = 'active'`,
   `current_period_end = now + billingPeriodDays`, **bump `subscription_version`** (§16).
6. Client: **`GET /me/account/subscription` → bootstrap *only if* `subscription_version` advanced.**
   A successful `verify` almost always advances it, but gating the heavier bootstrap on the version
   check keeps payment idempotent — a retried `verify` or a webhook that already applied the change
   does not force a redundant re-bootstrap. The cheap GET clears the banner and unlocks features;
   bootstrap runs behind it only when needed
   ([mobile-09 §2.8](./mobile-09-client-services-and-invariants.md)).
**Cancel mid-flow:** returns to checkout unchanged. **Card declined:** failure screen with the
Razorpay error reason; no state change on `account_subscription`.

---

## 10. S3 — Renewal

**Auto-renew** at `current_period_end` (Razorpay subscription / scheduled charge):
- Success → `current_period_end` advances; `subscriptionVersion` bumped; no user action.
- Failure → `status='past_due'`, `access_valid_until = current_period_end + 7d`; enter S4.

---

## 11. S4 — Payment failure → past_due → grace → lapse

```
Renewal fails
  → status=past_due, access_valid_until = period_end + 7d, subscriptionVersion++
  → Day 0..7 GRACE: full access; warning banner; X-Subscription-Warning: past_due:grace_until_…
     reminders day 0 / 3 / 6; owner can update card (S2 path) to recover → active
  → Day 7 grace ends, still unpaid:
     → all stores READ-ONLY (writes→402); reads OK; nothing deleted
     → offline devices stop allowing new sales once cached access_valid_until passes (device §30)
```
**Recovery any time during/after grace:** successful payment → `active`, `access_valid_until`
extended, `subscriptionVersion++` → devices unblock on next online refresh.

---

## 12. S5 — Cancel (at period end)

**Endpoint:** `POST /me/subscription/cancel` — ✅ **BUILT** (verified api-reference §6).
**Who can call:** owner or co_owner only (step-up auth required).
**Flow (3-step):** reason → timing (cancel at period end, default) → confirm.
- Sets `account_subscription.cancel_at_period_end = true`; `status` stays `active` until
  `current_period_end`, then cron transitions → `cancelled`.
- During the remaining period: full access + "Access ends {date}" notice.
- After period end: write-blocked (402); reads OK; data retained. **Never delete data.**
**Never cancel immediately by default** — the business paid for the period.

---

## 13. S6 — Reactivate

**Endpoint:** `POST /me/subscription/reactivate` — ✅ **BUILT** (verified api-reference §6).
**Who can call:** owner or co_owner only.
- From `cancelled` (before period end): clear `cancel_at_period_end` → back to `active` (no charge,
  `subscription_version++`).
- From `cancelled`/`expired` (after period end): Razorpay charge via S2 path → `active`.
- Reactivation **restores** all locked stores, locations, and devices automatically — nothing was
  deleted during the lapse, only locked (see S7).

---

## 14. S7 — Downgrade (fewer stores / locations / devices)

**Trigger:** owner moves to a plan with lower `max_stores`, `max_locations_per_store`, and/or `max_devices_per_store`.

### The downgrade guarantee — read-only, never delete

This is a hard invariant. Downgrading a plan **never destroys data**:

| Resource | On downgrade | Recovery |
|---|---|---|
| Stores over `max_stores` | **Locked** (`store.locked=true`) — read-only | Unlocked automatically on upgrade |
| Locations over `max_locations_per_store` | **Locked** (`location.locked=true`) — read-only | Unlocked on upgrade or owner removes them |
| Devices over `max_devices_per_store` | **Existing keep working** — new blocked | Auto-expire in 30 days or owner removes them |
| Staff over `max_users_per_store` | **Existing keep access** — new invites blocked | Owner removes members to get under cap |
| Products over `max_products` | **Existing kept** — new creates blocked | Owner archives products to get under cap |
| Features disabled on lower tier | **Existing data retained** — UI gated | Visible again on upgrade |

The pattern is always: **lock or block new creation; never touch what already exists.**

### A. Fewer locations-per-store
- Existing locations **keep working**; **new** branch creation blocked until that store's count
  ≤ `max_locations_per_store`.
- **Head Office is immune** — it is `is_primary = true` and can never be locked or removed as part
  of a downgrade. Only additional branches are affected.
- Per-store banner: "4 locations active, plan allows 2 — branches beyond the limit are read-only."
- Over-limit branches: **read-only locked** (inventory/reports visible, sales and stock writes
  blocked); owner removes or consolidates them to get under the cap. **Never auto-delete.**

### B. Fewer devices-per-store
- Existing devices in each store **keep working**; **new** registrations blocked until that store's
  count ≤ `max_devices_per_store`; slots free via auto-expiry / manual removal.
- Per-store banner: "5 devices active, plan allows 3 per store — remove 2 or they expire in 30 days."
- (Detail: [device-management.md F14](./device-management.md#19-f14--subscription-downgrade-account-plan--lower-limits).)

### C. Fewer stores (`max_stores`)
1. Owner has more stores than the new cap → **owner chooses which to keep active**. Never auto-pick.
2. The rest → **read-only locked** (`store.locked=true`), data retained, "Upgrade to reactivate".
   **Never delete.**
3. **Drain first:** force a final sync of each locking store's offline queue (no lost sales).
4. Locked stores don't count against `max_stores`; excluded from new device claims.
5. **Staff** in locked stores keep membership but go **read-only**.
6. On **re-upgrade**, locked stores reactivate automatically.

---

## 15. S8 — Expiry → all stores read-only

**Trigger:** `account_subscription` lapses (past_due grace-over, or cancelled period-over).
1. **Grace (7d):** every store under the account has full access; warning banners.
2. **After grace:** **all stores under the account** go **read-only** — open + read OK,
   **writes blocked**; devices not revoked; nothing deleted; reads never blocked.
3. **Paused (admin):** full block (403, suspended overlay) across all stores — abuse only.
4. **Offline:** the [device §30 handshake](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)
   ensures no rung-up sale is lost and no indefinite free offline selling.

---

## 15B. S9 — Ownership / role change (account_users)

**How the Account model makes ownership change trivial:**

With the Account model, stores and subscriptions belong to the **account**, not to a user.
"Changing the owner" is just updating a role in `account_users`. Nothing else changes.

### Case A — Same account, role change (most common)
```
Before: account_users(user=Raj, role='owner')
After:  account_users(user=Raj, role='co_owner')
        account_users(user=Kumar, role='owner')
```
Subscription, stores, devices, invoices, payment history — untouched.

### Case B — Full account transfer (one business buys another)
Rare enterprise case. The `account` row itself transfers to a new controlling party.
All users, stores, and subscriptions remain under the same account row — only the account's
controlling ownership record changes.

### Case C — Store splits to a new account
If Store X is spun off into a separate business entity with its own Account:
1. Create new `accounts` row for the new entity.
2. Move `stores.account_fk = new_account_id`.
3. New account gets its own `account_subscription` (starts at `free` / trial).
4. **Pre-check:** does the new account's plan have room for this store? (`max_stores`).
   If not, store is immediately locked until the new account upgrades.
5. Old account's `max_stores` frees one slot.
6. **`store_device_access` rows persist** (device identities unchanged); slot limit now governed
   by new account's plan. If over-limit → F14-A (existing keep working, new blocked, auto-expiry trims).
7. **pv bump** for both accounts.

> **GAP:** store split to a new account is not implemented. The role-change path (Case A) works
> as long as all stores stay under the same account and only users change roles
> ([§27](#27-backend-changes-required)).

---

## 15C. S10 — Staff limit (`max_users_per_store`)

**Trigger:** an `account_user` is assigned to a store. **Scope:** per store
(`account_subscription → plan → max_users_per_store`). Parallel to F0 (store limit) and F3
(device limit).

### Rules
1. On `POST /stores/:id/invitations` (or accept), check
   `activeStaffCount(store) < plan.max_users_per_store`.
   Resolve via `stores.account_fk → account_subscription → plan_entitlements(max_users_per_store)`.
2. `>= limit` → **403 `USER_LIMIT_REACHED`** `{ limit, active }` → "Your plan allows {limit} staff
   per store. Upgrade or remove a member."
3. `max_users_per_store = NULL` (Enterprise) → unlimited.
4. **Downgrade with excess staff:** existing staff **keep access** (never auto-removed); **new**
   invites blocked until the count drops; account owner removes members to get under the cap.
5. The **invitee accepting** also claims a **device slot** (device F2) — the two limits are
   independent: a store can hit its device cap before its staff cap, or vice-versa.

> **GAP:** the staff-limit gate is not enforced today. Add the count check at invite/accept
> ([§27](#27-backend-changes-required)).

---

## 15D. S11 — Location limit (`max_locations_per_store`)

**Trigger:** owner adds a branch location to a store. **Scope:** per store (account plan's
`max_locations_per_store`). Parallel to F0 (store limit), device F3 (device limit), and S10 (staff limit).

### Rules
1. On `POST /stores/:id/locations`, check `currentLocationCount(store) < max_locations_per_store`.
2. `>= limit` → **403 `LOCATION_LIMIT_REACHED`** `{ limit, current }` → "Your plan allows
   {limit} location(s) per store. Upgrade to add branches."
3. `max_locations_per_store = NULL` (Enterprise) → unlimited.
4. **Head Office is always slot 1** — it is provisioned atomically at store creation (`is_primary = true`
   `display_order = 0`) and counts as 1. It cannot be deleted while the store exists.
5. **Downgrade with excess locations:** existing branches **keep working** (no auto-delete, no
   auto-lock of Head Office); **over-limit branches** are **read-only locked** until owner removes them
   or upgrades; Head Office is never affected. (Mirror S7-A.)
6. **`multi_location` feature flag:** automatically `true` on any plan where
   `max_locations_per_store > 1`. If `multi_location = false` the "Add Location" button is hidden
   and the feature-locked modal fires before the API call (§17).

> **GAP:** the location-limit gate is not enforced today. Add `max_locations_per_store` to the plan
> feature seed and the count check at `POST /stores/:id/locations`
> ([§27](#27-backend-changes-required)).

---

## 16. Subscription freshness — how the client learns status

> **The most important fix in this module.** Subscription must reach the device **independently of
> permissions**, because it changes on a different cadence (webhooks, cron, payments) and is
> account-scoped, not user-scoped.

**UPDATE — Core freshness is built (verified api-reference §6):**
- `GET /me/subscription` returns the full subscription payload including `subscription_version`,
  `access_valid_until`, `banner_severity`. ✅
- `GET /me/subscription/sv` (ETag poll) is available. ✅
- `X-Subscription-Version` header is emitted on every authenticated response. ✅
- `X-Subscription-Warning` header (grace period) is emitted by `SubscriptionStatusGuard`. ✅
- `subscription_lapsed_at_write` (402) is enforced in the guard. ✅

**Remaining gap:** subscription transitions (time-based — trial end, period end) still need a
**reconciliation cron** to bump `subscription_version`; webhook events alone miss scheduled transitions.

**Freshness channels:**
- **Account member** (any role) → `GET /me/subscription` (real path; NOT `/me/account/subscription`).
- **Stores in the account** → derived from `user_subscription` via the account link.

**Client refresh protocol (every authenticated response):**
1. Server sets `X-Subscription-Version: <n>` on **every** response (✅ built).
2. If the header value is higher than the client's cached version → pull
   `GET /me/account/subscription`, update Redux/SQLite, refresh banner.
3. Read `X-Subscription-Warning` header (grace period) → update banner + cached `access_valid_until`.
4. On `402/403` subscription error → re-fetch `GET /me/account/subscription` (authoritative).
5. After a successful payment (`verify`) → re-fetch.

**What the server bumps `subscription_version` on:**
- Any status transition (trialing→active, active→past_due, etc.)
- `cancel_at_period_end` set or cleared
- Reconciliation cron fires at `trial_ends_at` or `current_period_end`
- Webhook `payment.captured` activates or renews

**Authoritative truth = server `402/403`.** Cached state is optimistic (banners, write-UI gating);
the server guard is the backstop. Never block reads based on cached state alone.

---

## 17. Feature gating

The plan payload delivered by `GET /me/account/subscription` carries two separate objects:

```ts
plan: {
  entitlements: {            // from plan_entitlements — integer or null
    max_stores: number | null,
    max_locations_per_store: number | null,
    max_devices_per_store: number | null,
    max_users_per_store: number | null,
    max_products: number | null,
  },
  features: {               // from plan_features — boolean
    gst_invoicing: boolean,
    offline_mode: boolean,
    barcode_scanning: boolean,
    inventory_management: boolean,
    multi_location: boolean,
    advanced_reports: boolean,
    loyalty_program: boolean,
    api_access: boolean,
    white_label: boolean,
    priority_support: boolean,
  }
}
```

**Entitlement check (count vs limit):**
```ts
function canCreate(key: EntitlementKey, currentCount: number): boolean {
  const limit = plan.entitlements[key]
  return limit === null || currentCount < limit   // null = unlimited
}
```

**Feature check (boolean gate):**
```ts
function hasFeature(key: FeatureKey): boolean {
  return plan.features[key] === true
}
```

**UI components:**
- **`EntitlementGate`** — shows current usage vs limit; renders upgrade CTA when at limit.
  "You've used 3/5 locations — upgrade to add more."
- **`FeatureGate`** — boolean lock; renders locked-overlay or hides the element when `false`.
- **`FeatureLockedModal`** fires on: tapping a gated element (`FeatureGate`) **or** the API
  returning `403 subscription_feature_limit_reached` (`error.details.feature` identifies which key).

> **BUG to avoid:** the interceptor must match the **lowercase** wire codes
> `subscription_suspended` / `subscription_feature_limit_reached`, **not** uppercase.
> See [§26 D-SUB-02](#26-design-issues--decisions).

---

## 18. Error contracts

| HTTP | `error.code` (lowercase!) | Meaning | Client action |
|---|---|---|---|
| 402 | `subscription_payment_required` | past_due grace-over / cancelled period-over / expired | Block write UI → renew/billing flow (reads still work) |
| 403 | `subscription_suspended` | paused | Suspended overlay → "contact support" |
| 403 | `subscription_feature_limit_reached` | feature/limit hit (`details.feature`) | FeatureLockedModal → upgrade |
| (header) | `X-Subscription-Warning: past_due:grace_until_… / cancelled:ends_at_…` | in grace | Soft banner |

The error envelope is `{ success:false, error:{ code, message, details? } }`. Branch on
`response.status` for transport and `error.code` (lowercase) for semantics.

---

## 19. Banners & severity

Server-computed: `show_upgrade_banner`, `banner_severity ('none'|'info'|'warning'|'critical')`.

| Status | Severity | Banner |
|---|---|---|
| trialing, ≥4 days left | info (dismissible) | "Trial ends in X days" |
| trialing, ≤3 days | warning | "Trial ends in X days" |
| trialing, ≤1 day / ended | critical | "Trial ends today" / "Trial ended" |
| past_due (grace) | warning/critical | "Payment failed — renew in X days" |
| cancelled (in period) | info | "Access ends {date}" |
| paused | critical | "Store suspended" |
| free | info | "On Free plan" |

`info` banners dismissible per session; `warning`/`critical` not dismissible.

---

## 20. Offline behaviour

| Scenario | Behaviour |
|---|---|
| Subscription active, device offline | Sells normally; sales sync later. |
| Lapses while device offline (within grace) | Sells; sales accepted on sync (stamped before `access_valid_until`). |
| Lapses while device offline (after grace) | Device blocks **new** sales locally once cached `access_valid_until` passes; pre-lapse sales still accepted; post-lapse sales rejected `SUBSCRIPTION_LAPSED_AT_WRITE`. |
| Renews while device offline | Device stays read-only until next online refresh, then unblocks. |
| Reads while lapsed | **Always allowed.** |

Full mechanism: [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1).

---

## 21. RBAC

Roles live in `account_users.role`. All roles are account-level; store-level assignments
(who manages which store) are separate from billing access.

| Action | Owner | Co-owner | Accountant | Manager | Cashier |
|---|---|---|---|---|---|
| View subscription status | ✓ | ✓ | ✓ | ✓ | ✓ |
| View plans & pricing | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upgrade / checkout / pay | ✓ | ✓ | ✓¹ | ✗ | ✗ |
| Cancel / reactivate | ✓ | ✓ | ✗ | ✗ | ✗ |
| Update payment method | ✓ | ✓ | ✓¹ | ✗ | ✗ |
| View invoices & payment history | ✓ | ✓ | ✓ | ✗ | ✗ |
| Choose stores to keep on downgrade | ✓ | ✓ | ✗ | ✗ | ✗ |
| Manage account users (invite/remove) | ✓ | ✓ | ✗ | ✗ | ✗ |
| Change account owner | ✓ | ✗ | ✗ | ✗ | ✗ |

> ¹ Accountant can pay and update payment method but cannot cancel the subscription or select
> which stores to lock on downgrade — those decisions require an owner or co-owner.

**Billing actions require step-up auth** (re-authenticate before checkout/cancel/update-payment).
The account owner is the only role that can transfer ownership or permanently remove co-owners.

---

## 22. Screens

All subscription and billing screens live under account settings, not store settings — the
subscription belongs to the account.

| Screen | Route | Purpose |
|---|---|---|
| Business settings | `account/settings` | account name, GST number, billing address |
| Account members | `account/members` | list, invite, change role, remove |
| Subscription status | `account/subscription` | current plan, status card, days remaining, actions |
| Plans list | `account/subscription/plans` | catalog, current highlighted, annual/monthly toggle |
| Plan detail | `account/subscription/plans/[code]` | feature comparison, upgrade CTA |
| Feature-locked modal | `feature-locked` (modal) | tapped/blocked premium feature |
| Subscription-ended modal | `subscription-ended` (modal) | 402/403 on write (variant by status) |
| Checkout (P2) | `account/subscription/checkout` | order summary + Razorpay |
| Cancel (P2) | `account/subscription/cancel` | 3-step cancel |
| History / Invoices (P3) | `account/subscription/history`, `/invoices` | events + GST invoices |
| Downgrade — pick stores (P2) | `account/subscription/downgrade` | owner selects which stores to keep |

`SubscriptionBanner` renders at the top of every store-scoped tab (severity-driven, per-session
dismissible for `info` only).

### 22B. Loading states (per flow)

Treatments use the [mobile-08 §13](./mobile-08-loading-ux-states.md) vocabulary (**A–E**); rules live there.

| Flow | Treatment | Notes |
|---|---|---|
| Subscription status screen | **C** / instant | render from cached subscription; **C** skeleton only if fetching `/me/subscription` |
| Plans list / detail | **C** | section skeleton; cache 24h → usually instant |
| Upgrade → checkout (S2) | **E** button spinner → SDK | step-up → spinner on `checkout` → **Razorpay SDK takeover** |
| Verify after payment (S2) | **C** brief | short blocking while `/verify` confirms → re-fetch → unlock |
| Cancel / reactivate (S5/S6) | **E** button spinner | step-up + confirm; not full-screen |
| Banner (trial/grace) | **banner** (not a loader) | severity-driven; `info` dismissible |
| Write blocked (402/403) | **banner/modal** (not a loader) | "Renew" / suspended overlay; reads keep working |
| Feature-locked | **modal** (not a loader) | FeatureLockedModal |
| Freshness pull on version bump | **D** silent | re-fetch `/me/subscription` in background; swap banner silently |

---

## 23. Business rules

| ID | Rule |
|---|---|
| BR-SUB-001 | The **Account** is the top-level tenant. Subscription, billing, stores, and users all belong to the account — not to any individual user. |
| BR-SUB-002 | Reads are **never** blocked; only **writes** gated. |
| BR-SUB-003 | Grace = **7 days** (past_due only); degradation is binary (in-window = full; window closed = read-only), never gradual. |
| BR-SUB-004 | `access_valid_until = max(current_period_end, past_due_grace_until)` on `account_subscription`; drives offline write-gate on all devices under the account. |
| BR-SUB-005 | Expiry/downgrade: **read-only, never delete**; locked stores/locations/devices reactivate on upgrade. |
| BR-SUB-006 | Downgrade with excess stores: **owner/co_owner chooses** which to keep; drain offline queue before locking. |
| BR-SUB-007 | Downgrade with excess devices: existing keep working; new blocked; auto-expiry trims. |
| BR-SUB-008 | `account_subscription.subscription_version` is independent of `permissions_version`; they bump from different events. |
| BR-SUB-009 | `subscription_version` bumps on **every** transition including time-based (reconciliation cron). |
| BR-SUB-010 | Client matches **lowercase** error codes; server `402/403` is authoritative over any cached state. |
| BR-SUB-011 | Billing actions (upgrade, cancel, update-payment) require owner/co_owner/accountant role + step-up auth. Only owner may change roles or transfer ownership. |
| BR-SUB-012 | Offline sales stamped before `access_valid_until` are accepted on sync; later ones rejected `SUBSCRIPTION_LAPSED_AT_WRITE`. |
| BR-SUB-013 | No `account_subscription` row → fallback to `free` status (not an error). |
| BR-SUB-014 | "Changing the owner" is an `account_users` role update — stores, subscription, and billing remain on the same account row unchanged (S9 Case A). |
| BR-SUB-015 | `max_users_per_store` gates invites; existing staff never auto-removed on downgrade (S10). |
| BR-SUB-016 | A **locked** store (downgrade) opens **read-only**; a **revoked** store falls through to `default` (mobile §8B.5). |
| BR-SUB-017 | All users in the same account see the same `subscription_version`; there is no per-user or per-store freshness channel (§16). |
| BR-SUB-018 | Every store is provisioned with a **Head Office** location (`is_primary = true`) atomically at store-create; it counts as 1 slot against `max_locations_per_store` and cannot be deleted while the store exists. |
| BR-SUB-019 | `max_locations_per_store` gates new branch creation; Head Office is immune to downgrade locking; over-limit branches are read-only locked, **never auto-deleted**. |
| BR-SUB-020 | `multi_location` in `plan_features` must be consistent with `max_locations_per_store` in `plan_entitlements`; they must never contradict each other. Seed must assert this. |
| BR-SUB-021 | Account creation is atomic with signup: `accounts` + `account_users(role=owner)` + `account_subscription(status=trialing)` in one transaction. |
| BR-SUB-022 | `account_subscription.has_used_trial = true` is set at account creation, not at plan selection — prevents re-trialing by downgrading. |
| BR-SUB-023 | **Entitlements** (`plan_entitlements`) are quantitative integer limits; **features** (`plan_features`) are boolean capabilities. They live in separate tables with separate check logic. Never store a feature key in `plan_entitlements` or an entitlement key in `plan_features`. |
| BR-SUB-024 | **Downgrade guarantee — read-only, never delete.** Over-limit stores and locations are locked (read-only); over-limit devices keep working (new blocked); over-limit staff keep access (new invites blocked); over-limit products kept (new creates blocked). Everything restores on upgrade. No data is ever deleted by a subscription change. |

---

## 24. Validation matrix

| Trigger | Check | Result |
|---|---|---|
| Write while past_due grace-over | `now >= access_valid_until` | 402 → ended modal (variant=past_due) |
| Write while paused | status=paused | 403 → suspended overlay |
| Use gated feature | `feature` off / limit reached | 403 / FeatureLockedModal (`details.feature`) |
| Create store over cap | `ownedActive >= max_stores` | 403 STORE_LIMIT_REACHED → upgrade |
| Create location over cap | `currentLocations(store) >= max_locations_per_store` | 403 LOCATION_LIMIT_REACHED → upgrade (S11) |
| Open store, device over cap | per-store device count | 403 DEVICE_LIMIT_REACHED (device PRD F3) |
| Invite staff over cap | `activeStaff(store) >= max_users_per_store` | 403 USER_LIMIT_REACHED → upgrade/remove (S10) |
| Tap "Add Location" on single-location plan | `max_locations_per_store = 1` or `multi_location = false` | FeatureLockedModal → upgrade (client-side gate, S11) |
| Store split to new account, new account at cap | `newAccount.stores >= max_stores` | block → "upgrade new account first" (S9 Case C) |
| Open a LOCKED store (downgrade) | `store.locked=true` | open **read-only** + "Upgrade to reactivate" (don't fall to default) |
| Offline sale after grace | `now >= cached access_valid_until` | Block locally; read-only banner |
| Late-syncing offline sale | `client_modified_at <= access_valid_until` | Accept; else reject SUBSCRIPTION_LAPSED_AT_WRITE |
| Subscription changed online | `x-subscription-version` advanced | Re-fetch subscription, refresh banner |

---

## 25. Real-world scenarios

**R1 — Trial countdown.** New owner, trialing 14 days. Banner info→warning→critical as it nears 0.
Pays before end → active, banner clears.

**R2 — UPI renewal fails Friday evening.** → past_due, 7-day grace. Owner keeps selling all weekend
(grace), updates card Monday → active. No disruption. (1-day grace would have killed Saturday sales.)

**R3 — Owner ignores grace.** Day 7 → all stores read-only. Cashiers can still print past bills /
view stock, but can't make new sales. Banner "Renew to continue." Owner pays → unblocks.

**R4 — Lapse mid-sale, offline.** Cashier offline; account lapsed an hour ago. Sales rung up **before**
grace-end sync and are **accepted**; the device blocks the **next** sale once its cached
`access_valid_until` passes. No lost sales, no free selling.

**R5 — Downgrade Pro(2 stores)→Basic(1 store).** Owner has 2 stores. Picks 1 to keep; the other →
read-only locked after a final sync. Staff there go read-only. Re-upgrade later restores it.

**R6 — Feature tap on Free.** Cashier taps "Advanced Reports" → FeatureLockedModal "Upgrade to access
advanced reports" → View Plans.

**R7 — Stale banner bug (today's gap).** Owner pays on phone A; phone B still shows "expired" because
the snapshot only refreshes on pv bump. **Fix:** `subscription_version` header → phone B refreshes on
its next response (§16).

**R8 — Owner leaves the company.** Raj was the owner; Kumar takes over. With a user-owned
subscription this would require migrating the subscription, all invoices, and all payment history to
Kumar's user ID. With the Account model: update `account_users(user=Raj, role='co_owner')` +
`account_users(user=Kumar, role='owner')`. Everything on the account (subscription, stores, devices,
invoices) is untouched. Total backend work: two row updates.

**R9 — Accountant pays the renewal.** The company's accountant handles invoices. With a user-owned
subscription the accountant would need the owner's credentials. With the Account model: add
`account_users(user=accountant, role='accountant')`. The accountant can access billing screens,
view invoices, and process payments — without any store management access.

**R10 — Two co-founders, both need owner access.** Add both users to `account_users` with
`role='owner'`. Both can upgrade, cancel, and manage stores. The subscription still has exactly one
row in `account_subscription`. No duplication, no ambiguity about who "owns" the billing.

---

## 26. Design issues & decisions

| # | Issue | Resolution |
|---|---|---|
| D-SUB-01 🔴 | **Subscription coupled to the permission snapshot** → stale (not pv-driven). | **Separate it:** own `subscriptionVersion` + `GET /me/subscription`; same freshness protocol as permissions but independent (§16; design-doc §11 Phase 1). |
| D-SUB-02 🔴 | **Error-code casing bug** in the impl guide — interceptor checks UPPERCASE, wire is lowercase → suspended & feature-locked modals never fire. | Match **lowercase** `subscription_suspended` / `subscription_feature_limit_reached`. |
| D-SUB-03 🔴 | **Incomplete client write-block** (`useCanMutate` only checks `cancelled`). | Block on `cancelled | paused | expired` **and** past_due grace-over; server `402/403` is the backstop. |
| D-SUB-04 🔴 | **Offline sales on expiry** lost. | [device §30 handshake](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1) — point-in-time gating both sides. |
| D-SUB-05 🟠 | **Time-based transitions have no event** (trial/period end) → `subscription_version` won't bump. | Reconciliation **cron** bumps `subscription_version` at `trial_ends_at`/`current_period_end`. |
| D-SUB-06 🔴 | **No Account entity exists; subscription is per-store or per-user.** Store-scoped endpoints, `store_subscription` table, and `owner_user_fk` on stores all conflict with the account model. | Create `accounts`, `account_users`, `account_subscription`; migrate `stores.account_fk`; drop `store_subscription`; move billing endpoints to `/me/account/subscription/*` (§27). |
| D-SUB-07 🟡 | **Client-derived trial days** (clock skew). | Use server `days_remaining_in_period`; align clock via `x-server-time`. |
| D-SUB-08 🟡 | **402 variant copy** always "past_due". | Pick the modal variant from the cached status (past_due vs cancelled vs expired). |

---

## 27. Backend changes required

### Phase 0 — Account entity (foundational; everything else depends on this)

1. **Create `accounts` table** — `id`, `name`, `gst_number`, `billing_address jsonb`,
   `razorpay_customer_id`, `created_at`.

2. **Create `account_users` table** — `account_fk`, `user_fk`, `role` enum
   (`owner | co_owner | manager | cashier | accountant`); UNIQUE `(account_fk, user_fk)`.

3. **Create `account_subscription` table** — `account_fk UNIQUE`, `plan_fk`, `status`,
   `trial_ends_at`, `current_period_start`, `current_period_end`, `past_due_grace_until`,
   `access_valid_until`, `cancel_at_period_end`, `subscription_version int default 0`,
   `has_used_trial bool default false`.

4. **Migrate stores** — add `stores.account_fk → accounts.id`; derive from existing
   `stores.owner_user_fk` via the new account row; then **drop `owner_user_fk`**.

5. **Drop `store_subscription`** — all subscription reads move to `account_subscription`
   via `stores.account_fk → account_subscription`.

6. **`signup` transaction** — atomically create `account` + `account_users(role=owner)` +
   `account_subscription(status=trialing, has_used_trial=true)` in one DB transaction.

### Phase 1 — Subscription enforcement & freshness

7. **`SubscriptionStatusGuard` reads `account_subscription`** via
   `request.store.account_fk → account_subscription` (not `store_subscription`).

8. ✅ **BUILT** — `subscription_version` is present; bump logic exists for transitions.
   **Remaining:** ensure time-based transitions (trial end, period end) trigger the cron bump.

9. ✅ **BUILT** — `X-Subscription-Version` header set on authenticated responses by `SubscriptionStatusGuard`.

10. ✅ **BUILT** — `GET /me/subscription` returns the full payload (path is `/me/subscription`,
    NOT `/me/account/subscription`). Includes `access_valid_until`, `banner_severity`, `subscription_version`.

11. **Reconciliation cron** — runs every 5 min; transitions `trialing→cancelled` at `trial_ends_at`,
    `active→past_due` at `current_period_end`, `past_due→lapsed` at `past_due_grace_until`; bumps
    `subscription_version` on each transition.

12. **`access_valid_until` in sync delta** — `/sync/delta` checks
    `clientMutation.modified_at > account_subscription.access_valid_until → SUBSCRIPTION_LAPSED_AT_WRITE`.

### Phase 2 — Billing endpoints (account-scoped)

13. **`POST /me/account/subscription/checkout`** — creates Razorpay order against the account.
    `prefill` uses account billing contact (owner or designated accountant).

14. **`POST /me/account/subscription/verify`** — validates signature, calls `activateFromPayment()`,
    bumps `subscription_version`.

15. ✅ **BUILT — `POST /me/subscription/cancel`** — sets `cancel_at_period_end=true`; owner/co_owner only. (Path is `/me/subscription/cancel`, not `/me/account/subscription/cancel`.)

16. ✅ **BUILT — `POST /me/subscription/reactivate`** — clears `cancel_at_period_end` or re-bills. (Path is `/me/subscription/reactivate`.)

17. **`PATCH /me/account/subscription/payment-method`** — updates Razorpay card token.

### Phase 2 — Resource limit gates

18. **`max_stores` gate** — at `POST /stores`: resolve limit via
    `account_subscription → plan_entitlements(max_stores)`, count active stores under the account.
    Exceeds → **403 `STORE_LIMIT_REACHED`** `{ limit, current }`.

19. **`max_locations_per_store` gate** — at `POST /stores/:id/locations`:
    count existing locations for the store; compare against
    `account_subscription → plan_entitlements(max_locations_per_store)`.
    Exceeds → **403 `LOCATION_LIMIT_REACHED`** `{ limit, current }`.
    Head Office provisioned atomically in store-create transaction (`is_primary=true, display_order=0`).

20. **`max_users_per_store` gate** — at `POST /stores/:id/invitations` (and accept):
    count active staff for the store; compare against
    `plan_entitlements(max_users_per_store)`.
    Exceeds → **403 `USER_LIMIT_REACHED`** `{ limit, active }`.

21. **Store-lock + location-lock state** — `stores.locked boolean` and `locations.locked boolean`
    (distinct from `archived`). Locked resources open read-only. On re-upgrade, unlock all locked
    stores and locations under the account automatically.

22. **`max_products` gate** — at `POST /stores/:id/products` (and variants):
    count non-archived products in the store; compare against
    `plan_entitlements(max_products)`.
    Exceeds → **403 `PRODUCT_LIMIT_REACHED`** `{ limit, current }`.
    (Existing products are never deleted or hidden on downgrade — only new creates blocked.)

### Phase 2 — Account user management

23. **`GET /me/account/members`** — list `account_users` with roles.

24. **`POST /me/account/members/invite`** — invite a user to the account with a given role
    (owner-only for co_owner; owner/co_owner for other roles).

25. **`PATCH /me/account/members/:userId/role`** — change a member's role (owner-only).

26. **`DELETE /me/account/members/:userId`** — remove a member (owner/co_owner; cannot remove self
    if last owner).

27. **Account settings** — `PATCH /me/account` (name, GST number, billing address).

### Phase 3 — Invoice & event history

28. **`GET /me/account/subscription/events`** — cursor-paginated subscription event log
    (status transitions, payments, version bumps).

29. **`GET /me/account/subscription/invoices`** — list Razorpay invoices with GST split
    (CGST/SGST/IGST); `GET /me/account/subscription/invoices/:id` for detail + PDF download.

### Seed corrections (§3.1)

30. Fix the per-frequency upgrade/downgrade ladder (see §3.1 rules 1–2).
    Add `enterprise_annual` or implement monthly-only service logic.
31. **Migrate from `plan_feature` to two tables:**
    - Create `plan_entitlements(plan_fk, key, value integer)` for:
      `max_stores`, `max_locations_per_store`, `max_devices_per_store`, `max_users_per_store`, `max_products`.
      Values per tier: see §3 entitlements table. `NULL` = unlimited.
    - Create `plan_features(plan_fk, key, enabled boolean)` for:
      `gst_invoicing`, `offline_mode`, `barcode_scanning`, `inventory_management`, `multi_location`,
      `advanced_reports`, `loyalty_program`, `api_access`, `white_label`, `priority_support`.
      Values per tier: see §3 features table.
    - Drop the old `plan_feature` table (or migrate its rows into the two new tables).
    - Add seed-time assertions: `max_locations_per_store IS NULL OR value >= 1`;
      no key appears in both tables; `multi_location` matches `max_locations_per_store > 1`.
32. Set `trialDays: 0` on all plans; use `TRIAL_DAYS` constant + `has_used_trial` flag.
33. `onConflictDoUpdate` (not `onConflictDoNothing`) on both new tables; batch inserts.
34. Resolve **Premium vs Professional** tier DECISION (§3).

---

## 28. Phase 2 / Phase 3 — deferred

**Phase 0 (foundational — must ship before everything else):**
Account entity migration (§27 items 1–6) · `SubscriptionStatusGuard` reads `account_subscription`
(§27 #7) · `subscription_version` + header + `GET /me/subscription` (§27 #8–10 ✅ BUILT).

**Phase 1 (enforcement & freshness):**
Reconciliation cron (§27 #11) · sync delta point-in-time check (§27 #12) · `max_stores` gate
(§27 #18) · store-lock state (§27 #21) · seed corrections (§27 #30–34).

**Phase 2 (billing UI + full limits):**
Razorpay checkout/verify account-scoped (§27 #13–14) · cancel 3-step (§27 #15) · reactivate
(§27 #16) · update payment method (§27 #17) · location limit gate (§27 #19) · staff limit gate
(§27 #20) · `max_products` gate (§27 #22) · account member management screens + API (§27 #23–27) ·
downgrade store-picker screen.

**Phase 3 (history & team):**
`GET /me/account/subscription/events` cursor-paginated (§27 #28) ·
`GET /me/account/subscription/invoices` with GST split (CGST/SGST/IGST) + PDF (§27 #29) ·
account settings screen (§27 #27).

**Later:** proration on mid-cycle upgrade · annual/monthly toggle with savings display ·
dunning emails/SMS (Razorpay Smart Collect) · accountant role billing-contact designation ·
usage-based metering · parent company / franchise account linking.
