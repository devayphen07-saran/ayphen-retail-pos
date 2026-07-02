# Subscription & Billing — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** plans, billing, lifecycle, grace, expiry, downgrade, feature gating, freshness,
> and the offline write-gate — every flow detailed end to end.
> **Model:** The subscription belongs to the **Account**, not to any individual user. One user
> logs in, creates their first store, and the account + subscription are auto-created behind the
> scenes. All stores, locations, devices, and billing live under that one account.
> **Companion:** offline-expiry handshake lives in
> [device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1).

---

## Table of Contents

1. [Overview & Core Principles](#1-overview--core-principles)
2. [The Account Model](#2-the-account-model)
3. [Plan Catalog & Tiers](#3-plan-catalog--tiers)
4. [Subscription Status — States & Meaning](#4-subscription-status--states--meaning)
5. [Status State Machine](#5-status-state-machine)
6. [Grace Period & access_valid_until](#6-grace-period--access_valid_until)
7. [Enforcement — Reads vs Writes](#7-enforcement--reads-vs-writes)
8. [S1 — Signup, Profile & First Store (Trial Auto-Start)](#8-s1--signup-profile--first-store-trial-auto-start)
9. [S2 — Upgrade / Checkout (Razorpay)](#9-s2--upgrade--checkout-razorpay)
10. [S3 — Auto-Renewal](#10-s3--auto-renewal)
11. [S4 — Payment Failure → Grace → Lapse](#11-s4--payment-failure--grace--lapse)
12. [S5 — Cancel (At Period End)](#12-s5--cancel-at-period-end)
13. [S6 — Reactivate](#13-s6--reactivate)
14. [S7 — Downgrade](#14-s7--downgrade)
15. [S8 — Expiry — All Stores Read-Only](#15-s8--expiry--all-stores-read-only)
16. [S9 — Ownership & Role Change](#16-s9--ownership--role-change)
17. [S10 — Staff Limit](#17-s10--staff-limit)
18. [S11 — Location Limit](#18-s11--location-limit)
19. [Subscription Freshness](#19-subscription-freshness)
20. [Feature Gating](#20-feature-gating)
21. [Error Contracts](#21-error-contracts)
22. [Banners & Severity](#22-banners--severity)
23. [Offline Behaviour](#23-offline-behaviour)
24. [RBAC](#24-rbac)
25. [Screens](#25-screens)
26. [Business Rules](#26-business-rules)
27. [Validation Matrix](#27-validation-matrix)
28. [Real-World Scenarios](#28-real-world-scenarios)
29. [Backend Changes Required](#29-backend-changes-required)
    - Phase 0: Account Entity (Foundation) — items 1–7
    - Phase 1: Enforcement & Freshness — items 8–14 (includes audit outbox)
    - Phase 2: Billing Endpoints — items 15–18
    - Phase 2: Resource Limit Gates — items 19–23 (atomic enforcement pattern)
    - Phase 2: Account & Store Management — items 24–29
    - Phase 3: History — items 30–31
    - Seed Corrections — items 32–36
    - Additional Gap Items — items 37–42

---

## 1. Overview & Core Principles

The Subscription module is the **commercial entitlement** layer. It decides what a business can
do — how many stores, locations, devices, and staff it can have, which features are unlocked —
and whether those stores can **transact** (write). It is deliberately **separate from
authorization** (RBAC / permission snapshot). RBAC says *"this user may create a product";*
subscription says *"this account is paid up and may write."*

> **Subscription data is NOT in the permission snapshot (C2).** The `PermissionSnapshot` / `StoreSnapshot` contains only RBAC data (roles, permissions, offline constraints). Subscription state (`status`, `access_valid_until`, plan features) is delivered separately via `GET /me/subscription` and tracked via the `X-Subscription-Version` header. This separation ensures that a plan change does not invalidate the permission snapshot, and a permission change does not require a subscription re-fetch. These are independent version channels.

> **Resolution path (C7):** When a mobile client needs to read `access_valid_until`, the lookup chain is: `request.user (MobilePrincipal) → stores.account_fk → account_subscription.access_valid_until`. This is a 3-hop read (JWT → DB for store → DB for account_subscription). `SubscriptionStatusGuard` caches the result per `accountId` in Redis (5-min TTL) to collapse this to a cache hit on the hot path.

### The Complete Mental Model

```
👤 USER: Raj Kumar (one person, one phone number)
   │
   │ belongs to (via account_users)
   ▼
🏢 ACCOUNT (auto-created when first store is created)
   │  account_number: "ACC-A3F2B1"  ← auto-generated, for support reference
   │  name: "Raj Kumar's Business"  ← auto from user.name, editable, INTERNAL ONLY
   │
   ├─ 💳 ONE SUBSCRIPTION (covers every store under this account)
   │     status: trialing / active / past_due / cancelled / paused
   │     access_valid_until: ← single timestamp that drives ALL gating
   │
   └─ 🏪 STORES (each is an independent business unit)
         ├─ Store 1: "Raj Fashion"
         │    name: "Raj Fashion"          ← printed on customer invoices
         │    gst_number: "33AABC..."      ← printed on customer invoices
         │    address: "T Nagar, Chennai"  ← printed on customer invoices
         │    phone: "+91 9876543210"      ← printed on customer invoices
         │    invoice_prefix: "RF"         ← per-store invoice sequence
         │    invoice_counter: 0           ← RF-2026-00001, RF-2026-00002, ...
         │    │
         │    ├─ 📍 Head Office (auto-created, slot 1, immune to locking)
         │    ├─ 📍 T Nagar Branch
         │    ├─ 💻 Device 1 (iPad)
         │    └─ 💻 Device 2 (iPad)
         │
         └─ Store 2: "Raj Electronics"
              name: "Raj Electronics"      ← different name on invoices
              gst_number: "33XYZA..."      ← different GST on invoices
              invoice_prefix: "RE"         ← own separate invoice sequence
              │
              ├─ 📍 Head Office (auto-created, slot 1)
              └─ 💻 Device 1 (iPad)
```

### Four Non-Negotiable Principles

1. **Reads are never blocked.** Only writes are gated. A lapsed shop can always view its
   history, reports, and inventory — it just cannot make new sales.
2. **Trial starts when the first store is created**, not at signup. The 15-day clock begins
   when the user has a store to sell from.
3. **Account name is internal only.** It never appears on customer receipts or invoices.
   Store name, store GST, and store address go on invoices.
4. **Lock, never delete.** Downgrading or lapsing locks data as read-only. Nothing is ever
   deleted by a subscription change.

---

## 2. The Account Model

### Why Not Attach the Subscription to the User?

Attaching a subscription to a user row breaks the moment anyone asks for: ownership transfer,
co-owners, an accountant who pays but doesn't manage stores, or a business where the CEO owns
the company but a finance manager handles billing. Every one of these requires painful data
migration if billing is coupled to a person.

The Account model solves all of this. Stores, subscriptions, devices, and billing history all
live on the account. Users are just members with roles.

### What the Account Is (and Is Not)

```
Account
│
├── account_subscription    ← ONE subscription; covers ALL stores
│
├── account_users           ← members with roles
│     ├── owner             ← full control + billing
│     ├── co_owner          ← billing + store management
│     ├── manager           ← store management only
│     ├── cashier           ← POS only
│     └── accountant        ← billing view + pay only
│
└── Stores                  ← each carries its own invoice fields
      ├── Store A
      │     ├── name, gst_number, address, phone  ← customer invoice fields
      │     ├── Head Office (auto, slot 1)
      │     ├── Branches
      │     └── Devices
      └── Store B
            ├── name, gst_number, address, phone  ← own separate invoice fields
            ├── Head Office (auto, slot 1)
            └── Devices
```

The account itself holds only: `account_number` (for support), `name` (internal display label),
and `razorpay_customer_id` (for Ayphen's billing of the account). **GST number, address, phone,
and email belong on each store** — because each store issues its own invoices independently.

### Owner Change Example

Today owner = Raj; tomorrow owner = Kumar. What changes?

```diff
- account_users(user=Raj,   role='owner')
+ account_users(user=Raj,   role='co_owner')
+ account_users(user=Kumar, role='owner')
```

Subscription, stores, devices, invoice history — untouched. Two row updates.

### Store Invoice vs Ayphen Subscription Invoice

| Document | Who generates it | Fields used | Purpose |
|---|---|---|---|
| Customer receipt / POS invoice | Each store independently | `stores.name`, `stores.gst_number`, `stores.address`, `stores.phone` | Customer gets this after purchase |
| Ayphen subscription invoice | Ayphen bills the account | Account billing contact (owner name + phone) | Raj's bill from Ayphen for the plan |

The account name **"Raj Kumar's Business"** and account number **"ACC-A3F2B1"** appear only in
Ayphen's own billing emails and on the subscription invoice screen — never on a POS sale receipt.

---

## 3. Plan Catalog & Tiers

One `account_subscription` per account. The plan controls two distinct categories of limits.

### 3A. Entitlements — Quantitative Limits

Stored in `plan_entitlements` table (integer value; `NULL` = unlimited).

| Entitlement key | Scope | Free | Basic | Premium | Professional | Enterprise |
|---|---|:---:|:---:|:---:|:---:|:---:|
| `max_stores` | Account | 1 | 1 | 2 | 5 | ∞ |
| `max_locations_per_store` | Per store | 1 | 1 | 3 | 5 | ∞ |
| `max_devices_per_store` | Per store | 1 | 3 | 5 | 10 | ∞ |
| `max_users_per_store` | Per store | 2 | 5 | 10 | ∞ | ∞ |
| `max_products` | Per store | 50 | ∞ | ∞ | ∞ | ∞ |

**Critical notes:**
- `max_locations_per_store` is **inclusive of Head Office**. A value of `1` = Head Office only,
  no branches. A value of `3` = Head Office + 2 branches.
- `max_devices_per_store` is per store — Store A's device count does not affect Store B.
- `NULL` = unlimited (no check performed). Missing row = treat as `0` (blocked).
- Enforcement uses strict less-than: `currentCount < limit` (not `<=`).

### 3B. Features — Boolean Capabilities

Stored in `plan_features` table (boolean `enabled`).

| Feature key | Free | Basic | Premium | Professional | Enterprise |
|---|:---:|:---:|:---:|:---:|:---:|
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

`multi_location` must always be `true` on every plan where `max_locations_per_store > 1`.
They must never contradict each other.

### 3C. Pricing

| Plan | Monthly | Annual (≈17% off) |
|---|---|---|
| Free | ₹0 | — |
| Basic | ₹499 | ₹4,999 |
| Premium | ₹999 | ₹9,999 |
| Professional | ₹1,499 | ₹14,999 |
| Enterprise | ₹4,999 | — |

### 3D. Why Two Tables (Not One)

A single `plan_feature(key, kind, value_integer, value_boolean)` table leaves one column always
NULL. The reader must branch on `kind` to pick the right column, and a seed bug silently passes
validation. Two tables enforce the contract at the schema level:

- `plan_entitlements` always has an integer (or NULL for unlimited). Check: count vs integer.
- `plan_features` always has a boolean. Check: `=== true`.

The validation logic, the UI components, and the error messages are all different for entitlements
vs features. Keeping them separate prevents any ambiguity.

---

## 4. Subscription Status — States & Meaning

| Status | Meaning | Writes | Reads |
|---|---|:---:|:---:|
| `trialing` | In 15-day trial; full access | ✅ | ✅ |
| `active` | Paid and current | ✅ | ✅ |
| `free` | Free tier, or no subscription row (fallback) | ✅ within free limits | ✅ |
| `past_due` + in grace | Payment failed; within 7-day grace window | ✅ + warning | ✅ |
| `past_due` + grace over | Grace elapsed; access window closed | ❌ 402 | ✅ |
| `cancelled` + before period end | Cancelled but paid period still running | ✅ + notice | ✅ |
| `cancelled` + period over | Paid period elapsed | ❌ 402 | ✅ |
| `expired` (derived) | `cancelled` + period over — synthesised by snapshot | ❌ | ✅ |
| `paused` | Admin / abuse suspension | ❌ 403 | ✅ |

**The rule:** writes are blocked only when `NOW >= access_valid_until` (or `status = paused`).
Reads are never blocked under any status.

---

## 5. Status State Machine

```
User signs up (phone + OTP)
   │
   ▼
Profile: enters name only
   │
   ▼
Creates FIRST STORE
   │
   ▼ ── ATOMIC TRANSACTION ──────────────────────────────────────────┐
   │    Account auto-created (ACC-XXXXX)                             │
   │    account_users (role: owner)                                  │
   │    account_subscription (status: trialing, trial_ends_at +15d)  │
   │    Store row (name, GST, address, phone, invoice fields)        │
   │    Head Office location (is_primary=true, display_order=0)      │
   └─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────┐
│ trialing │  15 days from store creation
└────┬─────┘
     │
     ├─────────────────────────────────── Upgrades (pays) ──────────▶ ┌────────┐
     │                                                                  │ active │◀─── auto-renew ✓
     ├─────────────────────────────────── Trial ends, no payment ────▶ │        │
     │                                    (cron: trialing→cancelled)   └───┬────┘
     │                                                                      │
     │                                                      ┌───────────────┤
     │                                                      │               │
     │                                                  cancels        payment fails
     │                                                      │               │
     │                                                      ▼               ▼
     │                                               ┌──────────┐    ┌──────────┐
     │                                               │cancelled │    │ past_due │ (7-day grace)
     │                                               └────┬─────┘    └────┬─────┘
     │                                                    │               │
     │                                              period ends      grace ends,
     │                                                    │          still unpaid
     │                                                    ▼               ▼
     │                                             write-blocked    write-blocked
     │                                             (402) reads ✅   (402) reads ✅
     │
     └─────────────────────────────────── Picks free plan ─────────▶ ┌──────┐
                                                                       │ free │
                                                                       └──────┘

Admin suspend at any time → ┌────────┐
                             │ paused │ (403 full write block, reads ✅)
                             └────────┘

All transitions are account-level — applies to every store under the account simultaneously.
```

---

## 6. Grace Period & access_valid_until

### The Single Field That Drives Everything

```
access_valid_until = MAX(current_period_end, past_due_grace_until)
```

This one timestamp is the source of truth for all gating — server-side and device-side (offline).
Every device caches it. When `NOW >= access_valid_until`, writes are blocked.

### Grace Period Rules

- **Grace = 7 days** (`GRACE_DAYS`). Applies only to `past_due`. Not 1 day — too short for
  Indian retail (UPI failures, weekends, festival seasons).
- **Never gradual.** Degradation is binary: in-window = full access; window closed = read-only.
  There is no partial access or feature-level degradation during grace.
- **Escalating reminders:** Day 0 (payment failed), Day 3 (follow-up), Day 6 (urgent).
- **For `paused`:** `access_valid_until` is set to `null` or `NOW` — immediate full block.

---

## 7. Enforcement — Reads vs Writes

Two enforcement layers — client-side is optimistic, server-side is authoritative:

**Layer 1 — Client-side (optimistic gate):**
- Disables write buttons in the UI based on cached subscription snapshot.
- Shows banners and modals based on cached status.
- Reads the cached `access_valid_until` to gate offline writes on the device.

**Layer 2 — Server-side (authoritative gate):**
- `SubscriptionStatusGuard` re-checks on every store-scoped write request.
- The client can never be more permissive than the server.
- A cached state saying "active" does not override a server-side 402.

| HTTP Method | Gated? |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | **Never blocked** |
| `POST`, `PUT`, `PATCH`, `DELETE` | Blocked when entitlement window is closed |

**Server error codes on blocked writes:**

| Condition | HTTP | Error Code (lowercase) |
|---|---|---|
| Grace over / period over / expired | 402 | `subscription_payment_required` |
| Paused (admin) | 403 | `subscription_suspended` |
| Feature not in plan | 403 | `subscription_feature_limit_reached` |
| Store cap exceeded | 403 | `STORE_LIMIT_REACHED` |
| Location cap exceeded | 403 | `LOCATION_LIMIT_REACHED` |
| Device cap exceeded | 403 | `DEVICE_LIMIT_REACHED` |
| Staff cap exceeded | 403 | `USER_LIMIT_REACHED` |
| Product cap exceeded | 403 | `PRODUCT_LIMIT_REACHED` |

### Tiered Authorization for Critical Actions

Not all write mutations are equal. The simple `access_valid_until` check is sufficient for ordinary
creates (a new sale, a stock movement). But **critical / destructive actions** require a stricter
approach because the damage from an unauthorized action cannot be undone.

**Tier 1 — Ordinary mutations (point-in-time OK):**
Sales, cash movements, product views, stock queries, session updates. A cashier's legitimate
2:55 PM sale must still sync even if the subscription lapses at 3:00 PM — `client_modified_at <=
access_valid_until` is the right gate here. Re-checking live at sync time would incorrectly reject
genuine pre-lapse work.

**Tier 2 — Critical / destructive mutations (always re-check live at sync):**
Refunds, voids, price overrides, ownership transfers, device registrations, member removals,
subscription cancellations. For these, the server must re-validate the actor's current permission
**at sync time**, not just at the time the action was queued. If the actor's role was revoked
between queue time and sync time, the action is rejected with `PERMISSION_CHANGED_SINCE_QUEUE`.

Tier 2 mutations should also be decorated `@OnlineOnly()` on the client — the app must not allow
them to be queued offline in the first place. If the device is offline when a Tier 2 action is
attempted, show "This action requires a connection" and block locally before queuing.

**Tier 0 — Blocked principal (voids the entire queue):**
If the syncing device is blocked (`devices.is_blocked = true`), or the user is deleted / suspended
at sync time, the entire mutation batch is rejected with `DEVICE_BLOCKED` or `USER_SUSPENDED`. No
point-in-time check is run. Nothing in the queue is accepted.

```
On POST /sync/delta:

  1. If device.is_blocked OR user.deleted_at IS NOT NULL OR user.status != 'active':
       → reject all mutations: DEVICE_BLOCKED / USER_SUSPENDED
       (Tier 0 — queue entirely void)

  2. For each mutation where mutation.tier = 'critical':
       → re-check actor's permission at NOW()
       → if permission revoked since queue time: reject that mutation with PERMISSION_CHANGED_SINCE_QUEUE
       → if subscription lapsed: reject with SUBSCRIPTION_LAPSED_AT_WRITE
       (Tier 2 — live re-check)

  3. For each mutation where mutation.tier = 'normal':
       → if mutation.client_modified_at > account_subscription.access_valid_until: reject with SUBSCRIPTION_LAPSED_AT_WRITE
       → else: accept
       (Tier 1 — point-in-time)
```

> **Why not re-check everything live?** Because it would break the offline model. A genuine sale
> made at 11:50 AM by a cashier whose subscription lapsed at 12:00 PM would be rejected even though
> the cashier was authorized at the time of sale. Point-in-time is correct for Tier 1. Live
> re-check is correct only for Tier 2 where the action is destructive and must never be applied on
> stale authority.

---

## 8. S1 — Signup, Profile & First Store (Trial Auto-Start)

This is the most important flow. The account and subscription are **not** created at signup.
They are created atomically when the user creates their first store.

### Step 1: OTP Login

User enters phone number → receives OTP → enters OTP.

```
POST /auth/otp/request
Body: { phone: "+91 9876543210" }

POST /auth/otp/verify
Body: { phone: "+91 9876543210", otp: "123456" }
```

Backend creates **only** a `users` row:

```sql
INSERT INTO users (id, phone, name)
VALUES (uuid(), '+91 9876543210', null);
```

Returns JWT. No account created. No subscription. No trial. Trial has not started.

**State after Step 1:**
```
users.id = usr-001
users.phone = +91 9876543210
users.name = null
account = NONE
subscription = NONE
trial = NOT STARTED
```

### Step 2: Profile Setup

App shows a profile screen. User enters their name.

```
PATCH /me/profile
Body: { name: "Raj Kumar" }
```

Backend updates `users.name`. Still no account.

**State after Step 2:**
```
users.name = "Raj Kumar"
account = NONE
subscription = NONE
trial = NOT STARTED
```

### Step 3: Create First Store — ATOMIC TRANSACTION

App shows the store creation screen. User fills in store details.

```
POST /stores
Body: {
  name:        "Raj Fashion",
  address:     "T Nagar, Chennai - 600017",
  phone:       "+91 9876543210",
  gst_number:  "33AABC1234F1Z5",      ← optional at creation; can be added later
  invoice_prefix: "RF"                 ← default "INV" if not provided
}
```

Backend executes a **single atomic transaction** that creates everything.

> **Race condition guard (F9):** A double-tap or network retry from the same user must not create two accounts. Before the inserts, acquire a Postgres advisory lock keyed on the user's UUID:
> ```sql
> SELECT pg_try_advisory_xact_lock(hashint8(user_id::text))
> ```
> If the lock is not acquired (another transaction for this user is in flight), return `409 STORE_CREATION_IN_PROGRESS`. Inside the lock, re-check whether an account already exists before inserting.

```sql
BEGIN;

-- Advisory lock: prevents concurrent first-store creation for the same user.
-- pg_try_advisory_xact_lock is scoped to the transaction — auto-released on commit/rollback.
SELECT pg_try_advisory_xact_lock(hashint8('usr-001'));
-- If returns false → ROLLBACK and return 409 STORE_CREATION_IN_PROGRESS

-- 1. Auto-create the ACCOUNT
INSERT INTO accounts (id, account_number, name, razorpay_customer_id, created_at)
VALUES (
  uuid(),
  generate_account_number(),          -- e.g. 'ACC-A3F2B1' (random, unique, URL-safe)
  'Raj Kumar' || '''s Business',      -- auto from users.name; user can rename later
  null,                               -- set when first payment is made
  NOW()
);
-- account.name is INTERNAL ONLY — never on customer invoices

-- 2. Link user to account as owner
INSERT INTO account_users (id, account_fk, user_fk, role)
VALUES (uuid(), new_account_id, 'usr-001', 'owner');

-- 3. Create subscription — TRIAL STARTS HERE (not at signup)
INSERT INTO account_subscription (
  id, account_fk, plan_fk, status,
  trial_ends_at,
  access_valid_until,
  has_used_trial,
  subscription_version,
  created_at
) VALUES (
  uuid(),
  new_account_id,
  FREE_TRIAL_PLAN_ID,
  'trialing',
  NOW() + INTERVAL '15 days',   -- trial clock starts at store creation
  NOW() + INTERVAL '15 days',   -- access valid until trial ends
  true,                          -- has_used_trial: cannot re-trial by downgrading
  1,
  NOW()
);

-- 4. Create the STORE (with all customer invoice fields)
INSERT INTO stores (
  id, account_fk,
  name,                         -- "Raj Fashion" ← on customer invoices
  address,                      -- "T Nagar, Chennai" ← on customer invoices
  phone,                        -- "+91 9876543210" ← on customer invoices
  gst_number,                   -- "33AABC1234F1Z5" ← on customer invoices
  invoice_prefix,               -- "RF" ← per-store invoice numbering
  invoice_counter,              -- 0 → increments: RF-2026-00001, RF-2026-00002
  locked,
  created_at
) VALUES (
  uuid(), new_account_id,
  'Raj Fashion', 'T Nagar, Chennai', '+91 9876543210', '33AABC1234F1Z5',
  'RF', 0, false, NOW()
);

-- 5. Auto-create HEAD OFFICE location (always slot 1, immune to locking)
INSERT INTO locations (
  id, store_fk, name, is_primary, display_order, locked, created_at
) VALUES (
  uuid(), new_store_id,
  'Head Office',
  true,   -- is_primary: true = Head Office; can never be locked or deleted
  0,      -- always slot 0 (display position 1)
  false,
  NOW()
);

COMMIT;
```

**State after Step 3:**
```
Account:      ACC-A3F2B1 / "Raj Kumar's Business"
              INTERNAL — user sees this in account settings only
              NEVER on customer receipts

Subscription: status=trialing
              trial_ends_at = store_created_at + 15 days
              access_valid_until = trial_ends_at
              has_used_trial = true
              subscription_version = 1

Store 1:      "Raj Fashion"
              GST: 33AABC1234F1Z5       ← customer invoices
              Address: T Nagar, Chennai  ← customer invoices
              Phone: +91 9876543210      ← customer invoices
              invoice_prefix: RF
              invoice_counter: 0

Locations:    Head Office (is_primary=true, display_order=0, locked=false)
              ← slot 1 of max_locations_per_store consumed

Trial active: 15 days from NOW ✅
Full access:  all features unlocked ✅
```

### What Happens on Subsequent Store Creations

When the user creates a second, third, etc. store (later, after upgrading their plan), there is
no account creation step — the account already exists.

```
POST /stores
Body: { name: "Raj Electronics", gst_number: "33XYZA5678R1Z9", ... }
```

Backend:
1. Check: `activeStoreCount(account) < plan.max_stores`. If not → 403 `STORE_LIMIT_REACHED`.
2. If allowed → atomic mini-transaction:
   - Create `stores` row with same `account_fk`.
   - Create `locations` row (Head Office, is_primary=true, display_order=0).
3. Return new store. Subscription unchanged.

Each store has its own GST, address, phone, and invoice sequence — completely independent.

```
Invoice from Store 1:                  Invoice from Store 2:
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ RAJ FASHION                  │       │ RAJ ELECTRONICS              │
│ T Nagar, Chennai 600017      │       │ Velachery, Chennai 600042    │
│ GST: 33AABC1234F1Z5          │       │ GST: 33XYZA5678R1Z9          │
│ Invoice: RF-2026-00001       │       │ Invoice: RE-2026-00001       │
└──────────────────────────────┘       └──────────────────────────────┘
Account name "ACC-A3F2B1" or
"Raj Kumar's Business" appears
NOWHERE on these documents.
```

---

## 9. S2 — Upgrade / Checkout (Razorpay)

**Who can trigger:** owner, co_owner, or accountant (step-up auth required before checkout).

### Full Upgrade Flow

```
User taps "Upgrade" (from trial banner, trial-ended modal, or settings)
  │
  ▼
GET /subscription/plans           ← cached 24h; returns all active plans
  │
  ▼
Plan picker screen:
  ┌───────────────────────────────────┐
  │ BASIC  ₹499/month                 │
  │ 1 store · 1 location · 3 devices  │
  │ [Select]                          │
  ├───────────────────────────────────┤
  │ PREMIUM  ₹999/month ⭐            │
  │ 2 stores · 3 locations · 5 devs   │
  │ Multi-location · Reports          │
  │ [Select]                          │
  ├───────────────────────────────────┤
  │ PROFESSIONAL  ₹1,499/month        │
  │ 5 stores · 5 locations · 10 devs  │
  │ [Select]                          │
  └───────────────────────────────────┘
  │
  ▼ User selects Premium
  │
  ▼
STEP-UP AUTH (OTP re-verification)
  Protects billing actions from accidental or unauthorised changes.
  Only owner / co_owner / accountant can pass.
  │
  ▼
POST /me/account/subscription/checkout
Body: { plan_code: "premium_monthly" }
  │
  ▼
BACKEND:
  Creates Razorpay order for ₹999
  Sets razorpay_customer_id on account if not already set
  Returns:
  {
    razorpay_key:  "rzp_live_xxx",
    order_id:      "order_abc123",
    amount:        99900,          ← paise
    currency:      "INR",
    plan_name:     "Premium Monthly",
    prefill: {
      name:    "Raj Kumar",        ← users.name (NOT account label)
      contact: "+91 9876543210"    ← users.phone
    }
  }
  │
  ▼
CLIENT launches Razorpay SDK
  ┌─────────────────────────┐
  │  Pay ₹999               │
  │  ○ UPI                  │
  │  ○ Card                 │
  │  ○ Net Banking          │
  │  [Pay Now]              │
  └─────────────────────────┘
  │
  ├─ PAYMENT SUCCESS:
  │    Razorpay returns { razorpay_payment_id, razorpay_order_id, razorpay_signature }
  │    │
  │    ▼
  │   POST /me/account/subscription/verify
  │   Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
  │    │
  │    ▼
  │   BACKEND:
  │     Verify Razorpay signature (HMAC-SHA256)
  │     Call activateFromPayment():
  │       account_subscription.status               = 'active'
  │       account_subscription.plan_fk              = premium_monthly
  │       account_subscription.current_period_start = NOW()
  │       account_subscription.current_period_end   = NOW() + 30 days
  │       account_subscription.access_valid_until   = current_period_end
  │       account_subscription.subscription_version++
  │     Create Ayphen billing invoice record
  │     Send "Payment confirmed" email to owner
  │    │
  │    ▼
  │   CLIENT detects X-Subscription-Version changed
  │   GET /me/subscription → update Redux + SQLite cache
  │   Banner clears ✅
  │   All Premium features and limits unlocked ✅
  │   User can now create up to 2 stores, 3 locations/store, 5 devices/store
  │
  ├─ PAYMENT CANCELLED (user dismissed Razorpay):
  │    No state change. Return to checkout screen.
  │
  └─ PAYMENT FAILED (card declined, insufficient funds, etc.):
       Razorpay shows failure reason on its own screen.
       No state change on account_subscription.
       User can retry.
```

**Idempotency:** a retried `verify` or a webhook that already applied the change will not
double-charge or double-advance the period — the backend checks `razorpay_order_id` uniqueness.
Gating the client bootstrap on `subscription_version` advancement prevents redundant re-bootstraps.

**Razorpay webhook as authoritative backstop (F3):** The `POST /me/account/subscription/verify` call requires step-up (5-min window). If the user spends more than 5 minutes on the Razorpay payment page, their step-up session expires before the verify call. The Razorpay `payment.captured` webhook is the backstop: it fires server-to-server and activates the subscription regardless of client session state. Never require step-up validation on the webhook endpoint — it is server-to-server and authenticated via HMAC-SHA256 signature only.

```
Webhook path (authoritative):
POST /webhooks/razorpay
  ├─ Verify HMAC-SHA256 signature with X-Razorpay-Signature header
  ├─ payment.captured → SubscriptionService.activateFromWebhook(orderId)
  │    ← NO step-up check — webhook is server-to-server
  └─ subscription activated regardless of client session state
```

---

## 10. S3 — Auto-Renewal

At `current_period_end`, Razorpay automatically charges the saved payment method.

```
current_period_end arrives
  │
  ├─ RAZORPAY CHARGES SUCCESSFULLY:
  │    Webhook: payment.captured → POST /webhooks/razorpay
  │    BACKEND:
  │      current_period_start = NOW()
  │      current_period_end   = NOW() + billingPeriodDays
  │      access_valid_until   = new current_period_end
  │      subscription_version++
  │    Create invoice record
  │    Send "Renewal confirmed" email
  │    No user action needed ✅
  │
  └─ RAZORPAY CHARGE FAILS (card declined, expired, etc.):
       Webhook: payment.failed → POST /webhooks/razorpay
       BACKEND:
         status               = 'past_due'
         past_due_grace_until = NOW() + 7 days
         access_valid_until   = past_due_grace_until
         subscription_version++
       Send "Payment failed" email + SMS to owner
       Enter S4 (grace period flow)
```

---

## 11. S4 — Payment Failure → Grace → Lapse

```
Renewal fails → status = past_due
  │
  ├─ access_valid_until = current_period_end + 7 days
  ├─ subscription_version++
  ├─ X-Subscription-Version header updated on next response
  └─ All clients detect version change → fetch /me/subscription → show warning banner

DAY 0 (failure day):
  All stores: FULL ACCESS ✅ (grace window open)
  Banner: ⚠️ WARNING "Payment failed — update card to keep selling (7 days left)"
  Email + SMS sent to owner

DAY 3:
  All stores: FULL ACCESS ✅
  Banner: ⚠️ WARNING "Payment failed — 4 days left to renew"
  Reminder email + SMS

DAY 6:
  All stores: FULL ACCESS ✅
  Banner: 🔴 CRITICAL "Last chance — account goes read-only tomorrow"
  Urgent email + push notification

DAY 7 (00:00) — Grace ends:
  Reconciliation cron detects: past_due_grace_until < NOW()
  access_valid_until is now in the past
  subscription_version++
  │
  ▼
  ALL STORES under the account → READ-ONLY:
    ✅ Cashier can view sales history
    ✅ Cashier can view inventory levels
    ✅ Cashier can print past invoices
    ✅ Manager can view reports
    ❌ Cannot make new sales         → 402 subscription_payment_required
    ❌ Cannot add products           → 402
    ❌ Cannot edit inventory         → 402
    ❌ Cannot register new devices   → 402
  Nothing deleted ✅
  Devices not revoked ✅

  Modal shown on next write attempt:
  "Your subscription has expired.
   Renew to continue selling."
  [Renew Now]  [View Reports]

RECOVERY (any time during or after grace):
  Owner pays via S2 flow (checkout + verify)
  BACKEND:
    status = 'active'
    current_period_end = NOW() + billingPeriodDays
    access_valid_until = current_period_end
    subscription_version++
  All stores unblock on next online refresh ✅
  Offline devices unblock when they next come online ✅
```

---

## 12. S5 — Cancel (At Period End)

**Endpoint:** `POST /me/subscription/cancel` ✅ Built.
**Auth:** owner or co_owner only; step-up OTP required.

### 3-Step Cancellation Flow

```
STEP 1 — Reason (for analytics)
  ┌──────────────────────────────────────┐
  │ Why are you cancelling?              │
  │ ○ Too expensive                      │
  │ ○ Missing features I need            │
  │ ○ Closing the business               │
  │ ○ Switching to a competitor          │
  │ ○ Other                              │
  │ [Continue]                           │
  └──────────────────────────────────────┘

STEP 2 — Timing
  ┌──────────────────────────────────────┐
  │ When should cancellation take effect?│
  │                                      │
  │ ⦿ At end of current period (default) │
  │   "Keep access until Feb 15, 2027"   │
  │   Recommended — you've paid for it   │
  │                                      │
  │ ○ Immediately                        │
  │   Lose access today; no refund       │
  │ [Continue]                           │
  └──────────────────────────────────────┘

STEP 3 — Step-up auth + Confirm
  ┌──────────────────────────────────────┐
  │ Enter OTP to confirm cancellation    │
  │ [ 1 ][ 2 ][ 3 ][ 4 ][ 5 ][ 6 ]     │
  │                                      │
  │ Your access continues until Feb 15.  │
  │ You can reactivate anytime.          │
  │                                      │
  │ [Confirm Cancel]  [Keep Subscription]│
  └──────────────────────────────────────┘
```

```
POST /me/subscription/cancel
Body: { reason: "too_expensive", cancel_at_period_end: true }

BACKEND:
  account_subscription.cancel_at_period_end = true
  status STAYS 'active' (!) — user paid for the period
  subscription_version++
```

**During remaining paid period:**
- Full access continues ✅
- Info banner: "Access ends Feb 15, 2027 — Reactivate anytime"

**At `current_period_end` (cron):**
```
Reconciliation cron detects:
  cancel_at_period_end = true AND current_period_end < NOW()
  │
  ▼
  status = 'cancelled'
  subscription_version++
  │
  ▼
  ALL stores under account → READ-ONLY (same as S8)
  Reads still work ✅
  Nothing deleted ✅
  Banner: "Subscription ended — Reactivate to continue selling"
```

**Never cancel immediately by default.** The business paid for the period.
**Never delete any data** on cancellation.

---

## 13. S6 — Reactivate

**Endpoint:** `POST /me/subscription/reactivate` ✅ Built.
**Auth:** owner or co_owner only.

### Case A — Before Period End (Changed Mind)

```
Status: active + cancel_at_period_end = true

Owner taps "Reactivate" in subscription settings
  │
  ▼
POST /me/subscription/reactivate

BACKEND:
  cancel_at_period_end = false
  status stays 'active'
  subscription_version++

Result:
  Cancellation reversed ✅
  No charge ✅
  Banner clears ✅
```

### Case B — After Period End (Coming Back)

```
Status: cancelled (period over) / expired

Owner taps "Reactivate"
  │
  ▼
Full payment flow (same as S2):
  POST /me/account/subscription/checkout
  Razorpay payment
  POST /me/account/subscription/verify

BACKEND:
  status = 'active'
  current_period_start = NOW()
  current_period_end = NOW() + billingPeriodDays
  access_valid_until = current_period_end
  cancel_at_period_end = false
  subscription_version++

Result:
  All stores REACTIVATED ✅
  All locked stores AUTO-UNLOCKED ✅
  All locked locations AUTO-UNLOCKED ✅
  Nothing was deleted — everything restored ✅
```

---

## 14. S7 — Downgrade

**Trigger:** owner selects a lower-tier plan (fewer stores, locations, or devices).

### The Downgrade Guarantee: Lock, Never Delete

This is a hard invariant. Downgrading **never destroys data**.

| Resource | On Downgrade | Recovery |
|---|---|---|
| Stores over `max_stores` | `store.locked = true` — read-only | Auto-unlock on upgrade |
| Locations over `max_locations_per_store` | `location.locked = true` — read-only | Auto-unlock on upgrade or owner removes them |
| Head Office | **Immune — never locked** (`is_primary = true`) | Not applicable |
| Devices over `max_devices_per_store` | Existing keep working; new blocked | Auto-expire in 30 days, or owner removes |
| Staff over `max_users_per_store` | Existing keep access; new invites blocked | Owner removes members |
| Products over `max_products` | Existing kept; new creates blocked | Owner archives products |
| Features on lower tier | Existing data retained; UI gated | Visible again on upgrade |

### Downgrade Flow

```
Owner on Premium (2 stores, 3 loc, 5 devices)
Selects Basic (1 store, 1 loc, 3 devices)
  │
  ▼
WARNING MODAL:
  "Downgrading to Basic will:
   • Keep your chosen store active
   • Lock your other store (read-only, not deleted)
   • Lock extra locations (Head Office always stays active)
   • Let existing devices keep working (new ones blocked)
   Your data is always safe."
  [Continue] [Keep Current Plan]
  │
  ▼
STEP 1 — Choose which store to keep
  ⦿ Raj Fashion (Store 1)       ← Owner picks
  ○ Raj Electronics (Store 2)
  [Continue]
  ┌─────────────────────────────────────────────────────────┐
  │ Owner always chooses. System never auto-picks a store.  │
  └─────────────────────────────────────────────────────────┘
  │
  ▼
STEP 2 — Force final sync of stores being locked
  "Syncing Raj Electronics before locking..."
  All pending offline sales from Store 2 are synced to server.
  No sales lost.
  │
  ▼
STEP 3 — Payment (lower amount via Razorpay)
  │
  ▼
BACKEND APPLIES DOWNGRADE:
  plan updated to basic
  max_stores = 1, max_locations_per_store = 1, max_devices_per_store = 3

  Store 2 (Raj Electronics):
    stores.locked = true
    → opens read-only; "Upgrade to reactivate this store"
    → staff in Store 2 keep membership, go read-only
    → does NOT count against max_stores

  Store 1 (Raj Fashion) — kept active:
    Location: Head Office → ACTIVE ✅ (is_primary=true, IMMUNE to locking)
    Location: T Nagar Branch → locations.locked = true (over limit of 1)
    Location: Anna Nagar Branch → locations.locked = true (over limit of 1)
    Devices (5 existing) → keep working ✅ (existing are never blocked)
    New device registrations → BLOCKED (403 DEVICE_LIMIT_REACHED)
    Existing devices → auto-expire in 30 days (trimmed to 3)

  subscription_version++

RESULT STATE:
  ┌──────────────────────────────────────────┐
  │ Plan: Basic                              │
  │                                          │
  │ Store 1: Raj Fashion ✅ ACTIVE           │
  │   ├─ Head Office (ACTIVE) ✅             │
  │   │   └─ IMMUNE to locking always       │
  │   ├─ T Nagar Branch 🔒 READ-ONLY        │
  │   └─ Anna Nagar Branch 🔒 READ-ONLY     │
  │       ↑ cashiers can view, not sell      │
  │                                          │
  │ Store 2: Raj Electronics 🔒 READ-ONLY   │
  │   ├─ Head Office (read-only)             │
  │   └─ Velachery Branch (read-only)        │
  │   All data preserved ✅                  │
  │   "Upgrade to reactivate" banner         │
  └──────────────────────────────────────────┘
```

**On re-upgrade:**
- All locked stores auto-unlock
- All locked locations auto-unlock
- Nothing was deleted

---

## 15. S8 — Expiry — All Stores Read-Only

**Trigger:** subscription lapses (past_due grace-over, or cancelled period-over).

```
access_valid_until < NOW()
  │
  ▼
ALL stores under the account → READ-ONLY simultaneously

For every store:
  ✅ Can open the store
  ✅ Can view all sales history
  ✅ Can view all inventory
  ✅ Can print / export past invoices
  ✅ Can view reports
  ❌ Cannot make new sales         → 402 subscription_payment_required
  ❌ Cannot edit inventory         → 402
  ❌ Cannot add products           → 402
  ❌ Cannot register new devices   → 402

Devices: NOT revoked
Data: NOT deleted
Staff access: NOT removed (read-only)

Special case — paused (admin/abuse):
  Status = paused → 403 subscription_suspended
  Full block on all writes
  Reads still work ✅
  "Account suspended — contact support"
```

Recovery: any successful payment → all stores unblock immediately on next refresh.

---

## 16. S9 — Ownership & Role Change

### Case A — Role Change (Most Common)

The account owns everything. Changing who runs the account is just an `account_users` update.

```
Before: account_users(user=Raj,   role='owner')
After:  account_users(user=Raj,   role='co_owner')
        account_users(user=Kumar, role='owner')
```

Subscription, stores, devices, invoice history — all untouched. Backend work: 2 row updates.

### Case B — Full Account Transfer

The `accounts` row transfers to a new controlling entity. All stores, subscriptions, and history
remain under the same `account.id`. Only the ownership record changes.

### Case C — Store Splits to New Account

If a store is spun off into a separate legal entity:

1. Create new `accounts` row.
2. Set `stores.account_fk = new_account_id`.
3. New account gets its own `account_subscription` starting at `free` / trial.
4. Check: does the new account's plan allow this store? If `newAccount.storeCount >= max_stores`
   → store is immediately locked until new account upgrades.
5. Old account's `max_stores` frees one slot.
6. `subscription_version++` for both accounts.

---

## 17. S10 — Staff Limit

**Trigger:** owner invites a new user to a store.
**Scope:** per store — resolved via `store → account_subscription → plan_entitlements(max_users_per_store)`.

```
POST /stores/:id/invitations
Body: { email: "cashier@example.com", role: "cashier" }
  │
  ▼
BACKEND CHECK:
  activeStaffCount(store) = ?
  plan.max_users_per_store = ?

  If activeStaffCount >= max_users_per_store:
    → 403 USER_LIMIT_REACHED
    { limit: 5, active: 5 }
    "Your plan allows 5 staff per store. Upgrade or remove a member."

  If max_users_per_store = NULL (Enterprise):
    → unlimited, always allowed

  If allowed:
    → send invitation
    → on accept: staff count increments

On downgrade with excess staff:
  Existing staff KEEP their access (never auto-removed)
  New invitations BLOCKED (403 USER_LIMIT_REACHED)
  Owner must remove members to get under the cap
```

---

## 18. S11 — Location Limit

**Trigger:** owner adds a branch location to a store.
**Scope:** per store — resolved via `store → account_subscription → plan_entitlements(max_locations_per_store)`.

```
POST /stores/:id/locations
Body: { name: "T Nagar Branch", address: "T Nagar, Chennai" }
  │
  ▼
BACKEND CHECK:
  currentLocationCount(store) = ?
  plan.max_locations_per_store = ?

  If currentLocationCount >= max_locations_per_store:
    → 403 LOCATION_LIMIT_REACHED
    { limit: 3, current: 3 }
    "Your plan allows 3 locations per store. Upgrade to add branches."

  If max_locations_per_store = NULL (Enterprise):
    → unlimited, always allowed

  If plan.features.multi_location = false:
    → show FeatureLockedModal BEFORE API call (client-side gate)
    → "Multi-location is not available on your plan. Upgrade to Premium or higher."

  If allowed:
    → create location row
    → currentLocationCount increments

Head Office rules:
  Created automatically at store creation (is_primary=true, display_order=0)
  Always counts as slot 1 of max_locations_per_store
  Cannot be deleted while the store exists
  Cannot be locked on downgrade (immune)
  Cannot be renamed to a non-Head-Office name through normal UI

On downgrade with excess locations:
  Head Office: ALWAYS ACTIVE ✅ (immune, is_primary=true)
  Over-limit branches: location.locked = true (read-only)
  Owner removes branches to get under cap, or upgrades to unlock
  Never auto-deleted
```

---

## 19. Subscription Freshness

Subscription changes on a different cadence to permissions (payments, webhooks, scheduled cron),
so it has its own independent version counter — separate from `permissions_version`.

### The Freshness Mechanism

Every authenticated server response includes:

```
X-Subscription-Version: 12
```

Client protocol on every response:

```
1. Read X-Subscription-Version: <n>
2. If n > cached_version:
     GET /me/subscription
     Update Redux state
     Update SQLite cache (for offline use)
     Refresh banner
     Update cached access_valid_until
     subscription_version = n
3. Read X-Subscription-Warning header (if present):
     "past_due:grace_until_2026-07-08T00:00:00Z"
     → update warning banner + cached access_valid_until
4. On 402 or 403 subscription error:
     → re-fetch GET /me/subscription (authoritative)
5. After successful payment verify:
     → re-fetch GET /me/subscription
```

### Real Stale Window — Do Not Overstate the Guarantee

The freshness mechanism does **not** provide instant propagation. The actual stale window before a
device sees a subscription change is bounded by the server-side caches:

| Cache layer | TTL | Effect |
|---|---|---|
| `SubscriptionStatusGuard` Redis cache | 5 min | A renewed subscription may still be blocked on write requests for up to 5 min after payment until the cache key expires or is invalidated by `subscription_version++` logic |
| Session Redis cache (`session:{id}`) | 30 s | `access_valid_until` is not in the session cache — subscription is looked up separately |
| Client Redux / SQLite cache | Until `X-Subscription-Version` bump detected | Client stays on old state until it makes any API call and sees the version bump |

**Do not write or say "busted on the very first request"** — this is only true on a cold cache
path. On the hot path (Redis hit), the stale window is the cache TTL. The correct claim is:
*"within one cache-TTL window (≤5 min) of any API call, the client will detect the version bump
and re-fetch."*

To minimise the window on billing-critical actions (upgrade, cancel), invalidate the
subscription Redis cache key immediately after `subscription_version++` in the transaction — do not
wait for TTL expiry.

### What Bumps subscription_version

| Event | Who bumps |
|---|---|
| Trial starts (first store created) | Store creation transaction |
| Payment success (upgrade / renewal) | Payment verify handler |
| Payment failure (renewal) | Razorpay webhook handler |
| Cancel at period end set or cleared | Cancel / reactivate endpoint |
| Trial ends (trialing → cancelled) | Reconciliation cron |
| Period ends (active → past_due) | Reconciliation cron |
| Grace ends (past_due write-blocked) | Reconciliation cron |
| Plan change (upgrade / downgrade) | Payment verify handler |

Every bump **must** also delete the subscription Redis cache key for the account so that the next
`SubscriptionStatusGuard` call reads from DB and returns the new version header to the client.

### Versioned Subscription Cache Key

Use the `subscription_version` value in the cache key so that a version bump naturally makes the
old cached entry unreferenced — no explicit `DEL` needed, and there is no race between "write new
state" and "delete old cache key" being two separate operations.

```
Cache key:  sub:{accountId}:v{subscriptionVersion}
TTL:        300 s (5 min)
Invalidation: bump subscription_version → old key naturally expires; new key populated on next read
```

Compare to the old single-key pattern (`sub:{accountId}`) which required an explicit `DEL` after
every transition and had a race window between the `UPDATE` and the `DEL`. The versioned key
eliminates that race entirely.

### Reconciliation Cron (Critical Gap — Must Build)

Webhooks fire on events (payment captured, payment failed). But **time-based transitions have no
event** — a trial just ends when the clock reaches `trial_ends_at`. The cron fills this gap.

```
Runs every 5 minutes:

For each account_subscription WHERE status IN ('trialing', 'active', 'past_due'):

  IF status = 'trialing' AND trial_ends_at < NOW():
    BEGIN;
      status = 'cancelled'
      access_valid_until = trial_ends_at   -- already in the past; write-blocked immediately
      subscription_version++
      DELETE FROM sub_cache WHERE account_fk = account_id  -- or: key expires naturally via versioned key
    COMMIT;
    → emit subscription.lapsed event (for banner delivery)

  IF status = 'active' AND current_period_end < NOW():
    BEGIN;
      status = 'past_due'
      past_due_grace_until = current_period_end + 7 days
      access_valid_until = past_due_grace_until
      subscription_version++
    COMMIT;
    → emit subscription.payment_failed event

  IF status = 'past_due' AND past_due_grace_until < NOW():
    -- access_valid_until already in the past (set when status → past_due).
    -- Write-block is already enforced. Just bump version so devices detect the final state.
    BEGIN;
      subscription_version++
    COMMIT;
    → emit subscription.grace_ended event

  IF status = 'cancelled' AND cancel_at_period_end = true AND current_period_end < NOW():
    -- Final confirmation: period ended, write-block already enforced via access_valid_until.
    -- This is a double-check; cancellation flow already sets access_valid_until = current_period_end.
    BEGIN;
      subscription_version++
    COMMIT;
```

> **Each cron transition must be atomic and idempotent.** Use `WHERE status = 'trialing' AND
> trial_ends_at < NOW()` as the predicate so a double-run is a no-op. Never use application-level
> read-then-write for the transition — do it in a single `UPDATE … WHERE` to avoid lost-update
> races between cron instances.

### GET /me/subscription Response Shape

```json
{
  "subscription_version": 12,
  "status": "active",
  "plan_code": "premium_monthly",
  "plan_name": "Premium",
  "billing_frequency": "monthly",
  "current_period_end": "2026-08-01T00:00:00Z",
  "trial_ends_at": null,
  "access_valid_until": "2026-08-01T00:00:00Z",
  "days_remaining_in_period": 30,
  "cancel_at_period_end": false,
  "show_upgrade_banner": false,
  "banner_severity": "none",
  "plan": {
    "entitlements": {
      "max_stores": 2,
      "max_locations_per_store": 3,
      "max_devices_per_store": 5,
      "max_users_per_store": 10,
      "max_products": null
    },
    "features": {
      "gst_invoicing": true,
      "offline_mode": true,
      "barcode_scanning": true,
      "inventory_management": true,
      "multi_location": true,
      "advanced_reports": true,
      "loyalty_program": true,
      "api_access": false,
      "white_label": false,
      "priority_support": false
    }
  }
}
```

---

## 20. Feature Gating

### Two Types of Checks — Never Mixed

**Entitlement check (integer count vs limit):**

```typescript
function canCreate(key: EntitlementKey, currentCount: number): boolean {
  const limit = subscription.plan.entitlements[key];
  if (limit === null) return true;          // null = unlimited, always allowed
  return currentCount < limit;              // strict less-than
}

// Examples:
canCreate('max_stores', 2)               // Premium allows 2, currently 2 → false (at limit)
canCreate('max_locations_per_store', 1)  // Premium allows 3, currently 1 → true
canCreate('max_devices_per_store', 5)    // Enterprise allows null → true
```

**Feature check (boolean gate):**

```typescript
function hasFeature(key: FeatureKey): boolean {
  return subscription.plan.features[key] === true;
}

// Examples:
hasFeature('multi_location')    // Premium → true
hasFeature('api_access')        // Premium → false (Enterprise only)
hasFeature('offline_mode')      // all plans → true
```

### UI Components

**`EntitlementGate`** — wraps UI that creates something with a limit:

```
Usage: 2 / 3 locations  [+ Add Branch]
                        ↑ button enabled until at limit

Usage: 3 / 3 locations  [Upgrade for More Locations]
                        ↑ button replaced with upgrade CTA
```

**`FeatureGate`** — wraps UI for a boolean-gated feature:

```
Plan has multi_location = true  → show "Add Branch" button normally
Plan has multi_location = false → show locked overlay or hide button
                                   Tap → FeatureLockedModal fires
```

**`FeatureLockedModal`** — fires when:
- User taps a gated UI element (`FeatureGate`)
- API returns `403 subscription_feature_limit_reached` (with `error.details.feature` key)

```
┌──────────────────────────────────────┐
│ 🔒 Advanced Reports                  │
│                                      │
│ Advanced reports are included in     │
│ Premium and higher plans.            │
│                                      │
│ Your current plan: Basic             │
│                                      │
│ [  View Plans  ]   [  Not Now  ]     │
└──────────────────────────────────────┘
```

> **Critical:** The interceptor must match **lowercase** wire codes:
> `subscription_suspended`, `subscription_feature_limit_reached`.
> Not uppercase. Mismatched casing = modal never fires.

---

## 21. Error Contracts

All error responses follow the same envelope:

```json
{
  "success": false,
  "error": {
    "code": "subscription_payment_required",
    "message": "Your subscription has expired. Please renew to continue.",
    "details": {
      "limit": 5,
      "current": 5
    }
  }
}
```

**Branch on `response.status` for transport, then on `error.code` (lowercase) for semantics.**

| HTTP | `error.code` (always lowercase) | Meaning | Client Action |
|---|---|---|---|
| 402 | `subscription_payment_required` | Grace over / period over / expired | Block writes → show renewal modal (reads still work) |
| 403 | `subscription_suspended` | Paused by admin | Show suspended overlay → "contact support" |
| 403 | `subscription_feature_limit_reached` | Feature not in plan (`details.feature`) | `FeatureLockedModal` → view plans |
| 403 | `STORE_LIMIT_REACHED` | `max_stores` hit (`details.limit`, `details.current`) | Upgrade CTA |
| 403 | `LOCATION_LIMIT_REACHED` | `max_locations_per_store` hit | Upgrade CTA |
| 403 | `DEVICE_LIMIT_REACHED` | `max_devices_per_store` hit | Upgrade CTA or remove a device |
| 403 | `USER_LIMIT_REACHED` | `max_users_per_store` hit | Upgrade or remove a member |
| 403 | `PRODUCT_LIMIT_REACHED` | `max_products` hit | Upgrade or archive products |
| header | `X-Subscription-Warning: past_due:grace_until_…` | In grace period | Show warning banner |
| header | `X-Subscription-Warning: cancelled:ends_at_…` | Cancellation pending | Show info banner |

---

## 22. Banners & Severity

Server computes and returns `banner_severity` and `show_upgrade_banner` in `GET /me/subscription`.

| Status / Condition | Severity | Banner Text | Dismissible |
|---|---|---|---|
| trialing, ≥ 4 days left | info | "Trial ends in X days — upgrade to keep selling" | Yes (per session) |
| trialing, ≤ 3 days left | warning | "Trial ends in X days — upgrade now" | No |
| trialing, ≤ 1 day left | critical | "Trial ends today — upgrade now" | No |
| Trial ended (write-blocked) | critical | "Trial ended — choose a plan to continue" | No |
| past_due (in grace), > 3 days left | warning | "Payment failed — X days to renew" | No |
| past_due (in grace), ≤ 3 days left | critical | "Last X days — renew now to keep selling" | No |
| past_due (grace over) | critical | "Subscription expired — renew to sell" | No |
| cancelled (before period end) | info | "Access ends {date} — reactivate anytime" | Yes (per session) |
| cancelled (period over) | critical | "Subscription ended — reactivate to sell" | No |
| paused | critical | "Account suspended — contact support" | No |
| active, on free plan | info | "On Free plan — upgrade for more features" | Yes (per session) |

`SubscriptionBanner` renders at the top of every store-scoped tab (not just settings).

---

## 23. Offline Behaviour

The device caches `access_valid_until` from `GET /me/subscription`. This single timestamp
drives all offline write gating — no server call needed.

| Scenario | Device Behaviour | On Sync |
|---|---|---|
| Active, goes offline | Sells normally; sales queued locally | Sales accepted — `modified_at <= access_valid_until` |
| Lapses while offline (still in grace) | Sells normally; `NOW < cached access_valid_until` | Sales accepted — stamped before grace end |
| Lapses while offline (grace over) | Device blocks new sales when `NOW >= cached access_valid_until` | Pre-lapse sales accepted; post-lapse rejected with `SUBSCRIPTION_LAPSED_AT_WRITE` |
| Renews while device offline | Device stays read-only | On next online refresh: detects `X-Subscription-Version` bump → fetches new `access_valid_until` → unblocks |
| Reads while lapsed | Always allowed | Not applicable |

**Sync delta check (server-side) — tiered:**

The sync endpoint applies the three-tier model defined in §7:

```
POST /sync/delta
Body: { mutations: [{ id, tier, client_modified_at, type, payload }] }

Step 1 — Tier 0: blocked principal check (applies to the entire batch)
  if device.is_blocked:
    → reject all: DEVICE_BLOCKED
  if user.deleted_at IS NOT NULL OR user.status != 'active':
    → reject all: USER_SUSPENDED

Step 2 — Tier 2: critical mutations (live re-check at sync time)
  for each mutation where tier = 'critical':
    re-fetch actor's role in account_users at NOW()
    if role changed or revoked since mutation.client_modified_at:
      → reject this mutation: PERMISSION_CHANGED_SINCE_QUEUE
    if NOW() > account_subscription.access_valid_until:
      → reject this mutation: SUBSCRIPTION_LAPSED_AT_WRITE

Step 3 — Tier 1: normal mutations (point-in-time check)
  for each mutation where tier = 'normal':
    if mutation.client_modified_at > account_subscription.access_valid_until:
      → reject: SUBSCRIPTION_LAPSED_AT_WRITE
    else:
      → accept (sale was made before lapse)
```

Tier classification (baked into the client at mutation-queue time):

| Mutation type | Tier |
|---|---|
| Sale / cash movement / product read | 1 (normal) |
| Stock adjustment (routine) | 1 (normal) |
| Refund / void / price override | 2 (critical) |
| Device registration | 2 (critical) |
| Member invite / removal | 2 (critical) |
| Ownership / role change | 2 (critical) |
| Subscription cancel / upgrade | 2 (critical) — must also be @OnlineOnly |

This ensures a cashier's genuine pre-lapse sale is never lost, while a refund queued by a
since-revoked manager is rejected cleanly regardless of `client_modified_at`.

> **Tamper-resistant `access_valid_until` (Rec7 — 📋 Planned):** The current design stores
> `access_valid_until` in plain JSON in `GET /me/subscription` and in the client's SQLite cache.
> A sophisticated attacker could modify the local SQLite to extend `access_valid_until`. To harden
> this, the server should deliver `access_valid_until` as an **Ed25519-signed token** with a 24h
> TTL, and offline write-gating should verify the Ed25519 signature before trusting the timestamp.
>
> ```ts
> // Signed by server Ed25519 private key; client verifies with the embedded public key
> {
>   access_valid_until: "2026-08-01T00:00:00Z",
>   account_id:         "acc-uuid",
>   issued_at:          "2026-07-01T12:00:00Z",
>   expires_at:         "2026-07-02T12:00:00Z"   // 24h window; device must refresh
> }
> // + Ed25519 signature over the canonical JSON (keys sorted)
> ```
>
> **Why Ed25519 and not HMAC-SHA256?** The client stores only the server's Ed25519 public key
> (embedded in the app bundle). No shared secret ships to the device. HMAC would require shipping
> the secret key to every device — defeating the tamper-resistance entirely. Ed25519 signs on the
> server, verifies on the device with the public key only.
>
> Until this is implemented, the server-side check at sync time (`POST /sync/delta`) is the
> authoritative gate — client-side gating is UX only. A tampered SQLite only lets a cashier sell
> from their local device; the sync will reject post-lapse mutations server-side.

---

## 24. RBAC

Roles live in `account_users.role`. All roles are account-level.

| Action | Owner | Co-owner | Accountant | Manager | Cashier |
|---|:---:|:---:|:---:|:---:|:---:|
| View subscription status and plan | ✓ | ✓ | ✓ | ✓ | ✓ |
| View plans & pricing | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upgrade / pay (checkout + verify) | ✓ | ✓ | ✓¹ | ✗ | ✗ |
| Cancel subscription | ✓ | ✓ | ✗ | ✗ | ✗ |
| Reactivate subscription | ✓ | ✓ | ✗ | ✗ | ✗ |
| Update payment method | ✓ | ✓ | ✓¹ | ✗ | ✗ |
| View Ayphen subscription invoices | ✓ | ✓ | ✓ | ✗ | ✗ |
| Choose stores to keep on downgrade | ✓ | ✓ | ✗ | ✗ | ✗ |
| Manage account members (invite / remove) | ✓ | ✓ | ✗ | ✗ | ✗ |
| Change account display name | ✓ | ✓ | ✗ | ✗ | ✗ |
| Transfer ownership (change owner role) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Edit store invoice fields (name, GST, address) | ✓ | ✓ | ✗ | ✓ | ✗ |

> ¹ Accountant can pay and update payment method but cannot cancel, reactivate, or choose which
> stores to keep on downgrade — those decisions require an owner or co-owner.

**All billing actions require step-up auth** (re-verify OTP) even for logged-in users.

---

## 25. Screens

All subscription and billing screens live under **account settings**, not store settings.

| Screen | Route | Purpose |
|---|---|---|
| Account settings | `account/settings` | Edit account display name only (internal label) |
| Store settings | `stores/:id/settings` | Edit store name, GST, address, phone, invoice prefix (invoice fields) |
| Account members | `account/members` | List, invite, change role, remove members |
| Subscription status | `account/subscription` | Current plan card, status, days remaining, action buttons |
| Plans list | `account/subscription/plans` | Full plan catalog, monthly / annual toggle, current plan highlighted |
| Plan detail | `account/subscription/plans/:code` | Feature comparison, upgrade CTA |
| Feature-locked modal | `feature-locked` (modal) | Tapped a locked feature or API returned 403 |
| Subscription-ended modal | `subscription-ended` (modal) | Shown on 402 write attempt; variant by status (past_due / cancelled / expired) |
| Checkout | `account/subscription/checkout` | Order summary + Razorpay integration |
| Cancel | `account/subscription/cancel` | 3-step cancellation flow |
| Downgrade — pick stores | `account/subscription/downgrade` | Owner picks which store(s) to keep |
| Ayphen invoices (P3) | `account/subscription/invoices` | Ayphen's plan invoices (not customer sales receipts) |
| Subscription events (P3) | `account/subscription/events` | Status transition history |

`SubscriptionBanner` renders at the **top of every store-scoped tab** (POS, inventory, reports,
settings). Severity-driven; `info` banners are dismissible per session only.

### Loading States

| Flow | Treatment |
|---|---|
| Subscription status screen | Render from cache instantly; skeleton only on cold fetch |
| Plans list / detail | Section skeleton; 24h cache means usually instant |
| Upgrade → checkout | Button spinner → step-up OTP → spinner → Razorpay SDK takeover |
| Verify after payment | Brief block while `/verify` confirms → re-fetch → unlock |
| Cancel / reactivate | Button spinner with step-up; not full-screen |
| Freshness pull on version bump | Silent background fetch; swap banner without disrupting UX |
| Trial / grace banner | Banner shown immediately; not a loader |
| Write blocked (402 / 403) | Modal or banner; reads keep working behind it |
| Feature-locked | `FeatureLockedModal` immediately; no loader |

---

## 26. Business Rules

| ID | Rule |
|---|---|
| BR-001 | The **Account** is the top-level tenant. One subscription covers all stores, locations, devices, and users under it. |
| BR-002 | **Reads are never blocked.** Only writes are gated. A lapsed account can always view history, reports, and inventory. |
| BR-003 | **Trial starts at first store creation**, not at signup. `trial_ends_at = store_created_at + 15 days`. A user who signs up but never creates a store does not consume their trial. |
| BR-004 | **Account and subscription are created atomically in the first store creation transaction.** They are not created at signup or at any other point. |
| BR-005 | **Account name is internal only.** Auto-generated as `user.name + "'s Business"`. Editable in account settings. Never printed on customer invoices or receipts. |
| BR-006 | **Store-level fields drive customer invoices.** `stores.name`, `stores.gst_number`, `stores.address`, `stores.phone` are on every customer receipt. Each store has its own independent invoice sequence (`invoice_prefix` + `invoice_counter`). |
| BR-007 | **One subscription per account** covers all stores. There is no per-store subscription. |
| BR-008 | `access_valid_until = MAX(current_period_end, past_due_grace_until)`. This single timestamp drives all write gating — both server-side and on-device offline. |
| BR-009 | **Grace = 7 days** (`GRACE_DAYS`), for `past_due` only. Degradation is binary: in-window = full; window closed = read-only. Never gradual. |
| BR-010 | **Downgrade = lock, never delete.** Excess stores → `store.locked = true`. Excess locations → `location.locked = true`. Existing devices keep working. Everything restores on upgrade. No data is ever deleted by a subscription change. |
| BR-011 | **Head Office is immune to locking.** `is_primary = true` locations cannot be set to `locked = true` by any downgrade or expiry flow. |
| BR-012 | **Head Office counts as slot 1** of `max_locations_per_store`. A plan with `max_locations_per_store = 1` means Head Office only — no branches. |
| BR-013 | Head Office is created atomically at store creation and cannot be deleted while the store exists. |
| BR-014 | Each store's entitlement limits are **independent**. Store A being at 5/5 locations does not affect Store B. |
| BR-015 | `has_used_trial = true` is set at account creation (first store). Prevents re-trialing by downgrading and re-selecting a plan. |
| BR-016 | `subscription_version` is independent of `permissions_version`. They bump from different events. |
| BR-017 | `subscription_version` bumps on every transition including time-based ones (reconciliation cron). All devices in the account share the same version — there is no per-store or per-user freshness channel. |
| BR-018 | Offline sales with `client_modified_at <= access_valid_until` are accepted on sync. Later ones are rejected with `SUBSCRIPTION_LAPSED_AT_WRITE`. |
| BR-019 | Client error codes are always **lowercase** (`subscription_payment_required`, not `SUBSCRIPTION_PAYMENT_REQUIRED`). Server `402/403` is authoritative over any cached state. |
| BR-020 | Billing actions (upgrade, cancel, update-payment) require owner / co_owner / accountant role + step-up OTP. |
| BR-021 | Downgrade with excess stores: owner/co_owner **chooses** which stores to keep. System never auto-picks. |
| BR-022 | Downgrade with excess locations: Head Office stays active; over-limit branches are `locked = true`. |
| BR-023 | Downgrade with excess devices: existing devices keep working; new registrations blocked; auto-expire trims in 30 days. |
| BR-024 | Downgrade with excess staff: existing staff keep access; new invitations blocked. |
| BR-025 | `multi_location` feature flag must be `true` on every plan where `max_locations_per_store > 1`. They must never contradict each other. |
| BR-026 | No `account_subscription` row → fallback to `free` status (not an error). |
| BR-027 | A **locked** store (downgrade) opens read-only with an "Upgrade to reactivate" banner. It does not fall through to a 404 or default screen. |
| BR-028 | **Billing prefill** uses `user.name` and `user.phone` — not the account label. |
| BR-029 | All entitlement limits use strict less-than enforcement: `currentCount < limit`. Not `<=`. |
| BR-030 | `max_locations_per_store` must be ≥ 1 in the seed. Setting it to `0` is a data error — the store would be created with a Head Office that already violates its own limit. |

---

## 27. Validation Matrix

| Trigger | Server Check | Result |
|---|---|---|
| Any write, grace over | `NOW >= access_valid_until AND status != paused` | 402 `subscription_payment_required` |
| Any write, paused | `status = 'paused'` | 403 `subscription_suspended` |
| Tap gated feature | `plan_features[key] != true` (client-side) | `FeatureLockedModal` before API call |
| API returns feature blocked | `plan_features[key] != true` (server-side) | 403 `subscription_feature_limit_reached` with `details.feature` |
| Create store | `activeStoreCount(account) >= max_stores` | 403 `STORE_LIMIT_REACHED` `{ limit, current }` |
| Create location | `locationCount(store) >= max_locations_per_store` | 403 `LOCATION_LIMIT_REACHED` `{ limit, current }` |
| Tap "Add Location" on single-location plan | `multi_location = false` or `max_locations_per_store = 1` | `FeatureLockedModal` client-side |
| Register device | `deviceCount(store) >= max_devices_per_store` | 403 `DEVICE_LIMIT_REACHED` `{ limit, current }` |
| Invite staff | `staffCount(store) >= max_users_per_store` | 403 `USER_LIMIT_REACHED` `{ limit, active }` |
| Create product | `productCount(store) >= max_products` | 403 `PRODUCT_LIMIT_REACHED` `{ limit, current }` |
| Open locked store | `store.locked = true` | Open read-only + "Upgrade to reactivate" banner |
| Open locked location | `location.locked = true` | Open read-only; writes blocked |
| Offline sale attempt | `NOW >= cached access_valid_until` (device-side) | Block locally; show read-only banner |
| Sync offline sale (pre-lapse) | `mutation.modified_at <= access_valid_until` | Accept |
| Sync offline sale (post-lapse) | `mutation.modified_at > access_valid_until` | Reject `SUBSCRIPTION_LAPSED_AT_WRITE` |
| Any response | `X-Subscription-Version > cached_version` | `GET /me/subscription`; refresh state |

---

## 28. Real-World Scenarios

**R1 — New user, trial countdown.**
Raj signs up, enters his name, creates "Raj Fashion". Trial starts (15 days). Day 1: info banner
"Trial ends in 14 days". Day 12: warning "3 days left". Day 14: critical "Trial ends today". Day 15:
trial ends — writes blocked. Raj pays → active. Banner clears. Full access restored.

**R2 — UPI renewal fails on Friday evening.**
Raj's card is declined at 11 PM Friday. Status → `past_due`, 7-day grace starts. Cashiers sell
all weekend normally. Owner sees "Payment failed — 7 days to renew" banner. Monday morning: Raj
updates his card → payment succeeds → active. No disruption. A 1-day grace would have blocked
all Saturday and Sunday sales.

**R3 — Owner ignores grace period.**
Day 7 of grace arrives. All stores go read-only. Cashiers can view stock and print past invoices
but cannot make new sales. Banner: "Renew to continue selling." Raj pays → all stores unblock on
next refresh. No data lost.

**R4 — Cashier offline when subscription lapses.**
Cashier (iPad) goes offline at 9 AM. Account lapses at noon (grace ended). Cashier sells from
9 AM – 11:59 AM → those sales are stamped before `access_valid_until`. iPad's cached
`access_valid_until` is noon; at noon the iPad blocks new sales. Cashier comes online at 3 PM.
Server accepts 9–11:59 AM sales (before lapse). 12:01 PM onward: rejected `SUBSCRIPTION_LAPSED_AT_WRITE`.
No genuine sales lost; no free selling after lapse.

**R5 — Downgrade from Premium (2 stores) to Basic (1 store).**
Raj has Store 1 (Raj Fashion) and Store 2 (Raj Electronics). He picks Store 1 to keep. Store 2
is synced and locked (read-only). Raj can still view Store 2's history and reports. Re-upgrades
a month later → Store 2 auto-unlocks. Nothing was deleted.

**R6 — Cashier taps Advanced Reports on Basic plan.**
Cashier taps "Reports" → "Advanced Reports" tab. Client checks `plan.features.advanced_reports = false`
before any API call. `FeatureLockedModal` appears: "Advanced Reports require Premium or higher."
[View Plans] button. No API call wasted.

**R7 — Owner pays on Phone A; cashier on Phone B still sees expired.**
Raj pays on his personal iPhone. Phone B (cashier's iPad) still shows "Expired" — it hasn't
synced yet. Cashier makes any API call (e.g., fetches inventory). Server responds with
`X-Subscription-Version: 8` (was 7). Phone B detects the mismatch → `GET /me/subscription` →
status = active → banner clears → cashier can sell again. Automatic, no manual refresh needed.

**R8 — Owner leaves the company.**
Raj was the owner. Kumar takes over. Two `account_users` row updates: Raj → `co_owner`,
Kumar → `owner`. Subscription, stores, devices, all invoice history — untouched.
Total backend work: 2 row updates, 0 data migrations.

**R9 — Accountant pays the monthly renewal.**
Add Kumar (accountant) to `account_users` with `role = 'accountant'`. Kumar can log in, view
Ayphen invoices, and pay the monthly bill — without access to store management. Owner still
cancels and manages stores. Clean separation.

**R10 — Store 1 has separate GST from Store 2.**
Raj Fashion GST: `33AABC1234F1Z5`. Raj Electronics GST: `33XYZA5678R1Z9`. Customer at Raj
Fashion gets a receipt headed "RAJ FASHION — GST 33AABC…". Customer at Raj Electronics gets
"RAJ ELECTRONICS — GST 33XYZA…". Account name "Raj Kumar's Business" appears on neither.
Invoice sequences are independent: RF-2026-00001 for Fashion, RE-2026-00001 for Electronics.

**R11 — Renew after lapse while devices offline.**
Account lapsed on Jan 31. Owner pays on Feb 5 (online, via phone). `subscription_version` bumps
to 9. Store's iPads are offline until Feb 7. On Feb 7 when they come online, next API call sees
`X-Subscription-Version: 9` (cached 8) → fetch `/me/subscription` → new `access_valid_until`
cached → iPads unblock automatically. No manual action needed on devices.

---

## 29. Backend Changes Required

### Phase 0 — Account Entity (Foundation)

Everything else depends on this. Ship this before anything else.

1. **Create `accounts` table:**
   `id uuid PK`, `account_number text UNIQUE NOT NULL` (auto-generated e.g. "ACC-A3F2B1"),
   `name text NOT NULL` (auto from `users.name + "'s Business"`, editable, internal only),
   `razorpay_customer_id text`, `created_at timestamptz`.
   **Do NOT add `gst_number` or `billing_address`** — those belong on stores.

2. **Create `account_users` table:**
   `id uuid PK`, `account_fk uuid → accounts.id`, `user_fk uuid → users.id`,
   `role text` (`owner | co_owner | manager | cashier | accountant`),
   `UNIQUE (account_fk, user_fk)`.

3. **Create `account_subscription` table:**
   `id uuid PK`, `account_fk uuid → accounts.id UNIQUE`, `plan_fk uuid`, `status text`,
   `trial_ends_at timestamptz`, `current_period_start timestamptz`,
   `current_period_end timestamptz`, `past_due_grace_until timestamptz`,
   `access_valid_until timestamptz`, `cancel_at_period_end boolean default false`,
   `subscription_version integer default 0`, `has_used_trial boolean default false`,
   `created_at timestamptz`.

4. **Update `stores` table:**
   Add: `account_fk uuid → accounts.id`, `gst_number text`, `address text`, `phone text`,
   `email text`, `invoice_prefix text`, `invoice_counter integer default 0`,
   `locked boolean default false`.
   Derive `account_fk` from existing `stores.owner_user_fk` via the new account row.
   Then **drop `owner_user_fk`**.

5. **Update `locations` table:**
   Add: `locked boolean default false` (distinct from `archived`).

6. **Drop `store_subscription` table (C3 — migration required).** All subscription reads move to `account_subscription` via `stores.account_fk → account_subscription`. The `store_subscription` table was the old model where each store had its own subscription — this is wrong; subscription belongs to the account, not the store. Any code that reads from `store_subscription` (including `SubscriptionStatusGuard` and device limit enforcement) MUST be migrated to read from `account_subscription` via `stores.account_fk`.

7. **Rewrite `POST /stores` transaction:**
   - First store ever for this user: atomically create `account` + `account_users(owner)` +
     `account_subscription(status=trialing, trial_ends_at=NOW()+15d, has_used_trial=true)` +
     `store` + `location(Head Office, is_primary=true, display_order=0)` in one transaction.
   - Subsequent stores: just create `store` + `location(Head Office)` under the existing account.
     Check `activeStoreCount(account) < max_stores` before allowing.

### Phase 1 — Enforcement & Freshness

8. **`SubscriptionStatusGuard`** reads `account_subscription` via
   `request.store.account_fk → account_subscription`. Not `store_subscription`.
   - Cache key: `sub:{accountId}:v{subscriptionVersion}` (versioned — see §19). TTL 300s.
   - On guard hit, inject `X-Subscription-Version: <n>` and, if applicable,
     `X-Subscription-Warning: past_due:grace_until_<ISO>` into the response headers.
   - Guard must enforce both **status** (`access_valid_until`) **and** the relevant
     **resource limit** for the route being called. A single guard pass for a `POST /stores`
     request checks both "is the subscription active?" and "is `activeStoreCount < max_stores`?"
     in the same DB read — not as two separate guard layers. This avoids TOCTOU between the
     limit-check guard and the actual insert. The pattern:
     ```ts
     // Inside SubscriptionStatusGuard.canActivate() for store-creation routes:
     const [sub, storeCount] = await Promise.all([
       this.getSubscription(accountId),
       this.db.select({ cnt: count() }).from(stores).where(eq(stores.accountFk, accountId)),
     ]);
     if (storeCount.cnt >= (sub.plan.entitlements.max_stores ?? Infinity))
       throw new ForbiddenException({ code: 'STORE_LIMIT_REACHED', limit: max_stores, current: storeCount.cnt });
     ```
   - The actual `INSERT` must then use `INSERT … SELECT … WHERE activeCount < max_stores`
     atomically (or a `SELECT FOR UPDATE` on the count row) so the limit holds under concurrent
     requests. Never rely on the guard alone to enforce counts — two simultaneous requests can
     both pass the guard and both insert.

9. ✅ **BUILT** — `subscription_version` bump logic exists. Remaining: ensure every bump also
   deletes (or uses the versioned key pattern from §19) the subscription Redis cache key for the
   account so the new version header is emitted on the very next response.

10. ✅ **BUILT** — `X-Subscription-Version` header on every authenticated response.

11. ✅ **BUILT** — `GET /me/subscription` returns full payload: `status`, `access_valid_until`,
    `banner_severity`, `subscription_version`, plan entitlements, plan features.

12. **Reconciliation cron** — runs every 5 min; handles all time-based transitions (see §19 for
    full pseudocode and atomicity requirements):
    `trialing → cancelled` at `trial_ends_at`;
    `active → past_due` at `current_period_end`;
    grace-over version bump at `past_due_grace_until`;
    bumps `subscription_version` on every transition.
    Each transition is a single atomic `UPDATE … WHERE` — never read-then-write at application
    level. Must be idempotent: a double-run produces the same final state.

13. **Sync delta check** — `POST /sync/delta` applies the three-tier model (§7 and §23):
    - Tier 0: blocked device or suspended user → reject entire batch.
    - Tier 2: critical mutations (refund, void, role change, etc.) → live permission re-check at
      sync time; `PERMISSION_CHANGED_SINCE_QUEUE` if role revoked; `SUBSCRIPTION_LAPSED_AT_WRITE`
      if subscription lapsed at NOW().
    - Tier 1: normal mutations → point-in-time check:
      `client_modified_at > access_valid_until` → `SUBSCRIPTION_LAPSED_AT_WRITE`.

14. **Audit logging — outbox pattern, not synchronous hard-fail.**
    Do not call `await auditLog.insert(...)` inline inside the request handler and let DB
    failures surface as 500s to the client. This makes availability depend on the audit subsystem.
    Instead:
    - **Critical events** (payment success/failure, subscription cancel/upgrade, role change,
      ownership transfer, refund/void): write to a `subscription_audit_outbox` table inside the
      same transaction as the domain write. A background worker drains the outbox to the final
      `audit_logs` table. If the domain transaction commits, the audit row is guaranteed (same TX).
      If the audit worker is down, the outbox row survives and is retried — the client request
      was not affected.
    - **Routine events** (ordinary permission denials, read checks): log best-effort via a
      fire-and-forget queue (Redis stream). A denial that fails to audit should never fail the
      user's request. Alert on audit-write failure rate rather than propagating it to callers.

    ```sql
    -- Outbox table (created in Phase 1 migration)
    CREATE TABLE subscription_audit_outbox (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_fk  uuid NOT NULL REFERENCES accounts(id),
      event_type  text NOT NULL,
      payload     jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT NOW(),
      processed_at timestamptz          -- null = pending
    );
    ```

### Phase 2 — Billing Endpoints

14. **`POST /me/account/subscription/checkout`** — account-scoped. Creates Razorpay order.
    `prefill.name = user.name`, `prefill.contact = user.phone`.

15. **`POST /me/account/subscription/verify`** — validates Razorpay signature, calls
    `activateFromPayment()`, bumps `subscription_version`.

16. ✅ **BUILT** — `POST /me/subscription/cancel` — sets `cancel_at_period_end = true`.

17. ✅ **BUILT** — `POST /me/subscription/reactivate` — clears `cancel_at_period_end` or re-bills.

18. **`PATCH /me/account/subscription/payment-method`** — updates Razorpay card token.

### Phase 2 — Resource Limit Gates

All limit gates must be enforced **atomically at the DB layer**, not just in the guard.
The guard check + the INSERT are two separate operations — two concurrent requests can both pass the
guard and both insert, exceeding the limit. The correct pattern for each gate:

```sql
-- Pattern: conditional insert that fails atomically if the count is at limit
INSERT INTO stores (id, account_fk, ...)
SELECT gen_random_uuid(), $accountFk, ...
WHERE (
  SELECT COUNT(*) FROM stores
  WHERE account_fk = $accountFk AND deleted_at IS NULL AND locked = false
) < $maxStores;
-- If 0 rows inserted → limit was at cap → application throws STORE_LIMIT_REACHED
```

Alternatively, acquire a `SELECT FOR UPDATE` on a `store_counts` summary row (if maintained) before
the INSERT. Either approach prevents the race; choose based on write volume.

19. **`max_stores` gate** at `POST /stores`:
    `activeStoreCount(account) >= plan.max_stores` → 403 `STORE_LIMIT_REACHED` `{ limit, current }`.
    Enforce atomically via conditional INSERT (pattern above). `NULL` = unlimited; skip check.

20. **`max_locations_per_store` gate** at `POST /stores/:id/locations`:
    `locationCount(store) >= plan.max_locations_per_store` → 403 `LOCATION_LIMIT_REACHED` `{ limit, current }`.
    Head Office auto-created in store-create transaction (`is_primary=true, display_order=0`) and
    counts as slot 1. Check `plan.features.multi_location = true` before checking the count — if
    `multi_location = false`, return `subscription_feature_limit_reached` with `details.feature =
    'multi_location'` rather than `LOCATION_LIMIT_REACHED` (different modal on client).

21. **`max_users_per_store` gate** at `POST /stores/:id/invitations` and accept:
    `staffCount(store) >= plan.max_users_per_store` → 403 `USER_LIMIT_REACHED` `{ limit, active }`.
    Check at **both** invitation creation and invitation acceptance — the count may reach the limit
    between the time the invitation is sent and the time it is accepted.

22. **`max_products` gate** at `POST /stores/:id/products`:
    `productCount(store) >= plan.max_products` → 403 `PRODUCT_LIMIT_REACHED` `{ limit, current }`.
    `NULL` = unlimited. Count includes soft-deleted products only if the plan explicitly tracks
    total-ever; for active-product limits count only `deleted_at IS NULL`.

23. **Store-lock + location-lock state** — `stores.locked boolean` and `locations.locked boolean`.
    Locked resources open read-only. Head Office (`is_primary = true`) is **never** locked.
    On re-upgrade: auto-unlock all locked stores and locations under the account in a single
    `UPDATE stores SET locked = false WHERE account_fk = $accountFk AND locked = true` (and
    equivalent for locations). Head Office rows are implicitly skipped because `locked` was never
    set on them.

    Error code consistency note: `STORE_LIMIT_REACHED`, `LOCATION_LIMIT_REACHED`,
    `DEVICE_LIMIT_REACHED`, `USER_LIMIT_REACHED`, `PRODUCT_LIMIT_REACHED` are uppercase because
    they name a specific resource cap. `subscription_payment_required` and
    `subscription_suspended` and `subscription_feature_limit_reached` are lowercase because they
    are subscription-status events. **Do not mix the casing.** Client interceptors branch on exact
    string equality — a casing mismatch silently bypasses the modal.

### Phase 2 — Account & Store Management

24. **`GET /me/account/members`** — list `account_users` with roles.

25. **`POST /me/account/members/invite`** — invite user with a role.

26. **`PATCH /me/account/members/:userId/role`** — change member role (owner only).

27. **`DELETE /me/account/members/:userId`** — remove member (cannot remove last owner).

28. **`PATCH /me/account`** — update account display name only (internal label).

29. **`PATCH /stores/:id`** — update `name`, `address`, `phone`, `email`, `gst_number`,
    `invoice_prefix` (the store's customer invoice fields).

### Phase 3 — History

30. **`GET /me/account/subscription/events`** — cursor-paginated subscription event log.

31. **`GET /me/account/subscription/invoices`** — Ayphen's plan invoices with GST split;
    `GET /me/account/subscription/invoices/:id` for PDF download.

### Seed Corrections

32. Fix per-frequency upgrade/downgrade ladder. `basic_annual.upgradeToCode = premium_annual`;
    `professional_monthly.downgradeToCode = premium_monthly`. No annual plan points to a monthly code.

33. Add `enterprise_annual` plan or implement service logic for annual→enterprise upgrades.

34. Migrate from the old `plan_feature` table to two separate tables:
    - `plan_entitlements(plan_fk, key, value integer)` for all quantity keys.
    - `plan_features(plan_fk, key, enabled boolean)` for all boolean keys.
    - Drop old `plan_feature` table.
    - Seed-time assertions: `max_locations_per_store IS NULL OR value >= 1`;
      no key appears in both tables; `multi_location = true` wherever `max_locations_per_store > 1`.

35. Set `trialDays: 0` on all plan rows. Trial length comes from `TRIAL_DAYS` constant (= 15),
    not from the plan catalog. This prevents accidental re-trialing via plan selection.

36. Use `onConflictDoUpdate` (not `onConflictDoNothing`) on both entitlement/feature tables.
    Batch all rows for a table into one insert call.

### Additional Backend Requirements (Gaps Identified in Review)

37. **Mutation tier field on sync payload.** Add `tier: 'normal' | 'critical'` to every mutation
    object in `POST /sync/delta`. The client sets this at queue time based on the mutation type
    table in §23. The server reads it and applies the correct check (§7, §23). Without this field
    the server cannot distinguish a sale from a refund.

38. **`subscription_audit_outbox` table and worker.** Create the outbox table (DDL in §29.14),
    wire it into every critical subscription event handler (payment verify, cancel, reactivate,
    plan change, role change), and build the background drainer that moves outbox rows to
    `audit_logs` and marks `processed_at`. Alert on rows that are pending for more than 5 min.

39. **Versioned subscription cache key.** Replace the current `sub:{accountId}` Redis key with
    `sub:{accountId}:v{subscriptionVersion}` (§19). Remove all explicit `DEL` calls on the old
    key pattern — they are no longer needed and risk deleting the wrong key if a race occurs.

40. **`@OnlineOnly()` decorator for Tier 2 mutations.** Client-side decorator that checks
    `NetInfo.isConnected` before allowing the action. If offline, show "This action requires a
    connection" and return early without queuing. Prevents Tier 2 mutations from ever appearing in
    the sync queue where they require live re-check at sync time. Must be applied to:
    refund, void, price override, device registration, member invite/remove, role change,
    subscription cancel/upgrade.

41. **`X-Subscription-Warning` header.** `SubscriptionStatusGuard` must inject this header on
    every response when the account is in a warning state:
    ```
    X-Subscription-Warning: past_due:grace_until_2026-07-08T00:00:00Z
    X-Subscription-Warning: cancelled:ends_at_2026-08-01T00:00:00Z
    X-Subscription-Warning: trialing:ends_at_2026-07-16T00:00:00Z
    ```
    The client reads this on every response (step 3 in §19 freshness protocol) and updates the
    warning banner and cached `access_valid_until` immediately — without waiting for a version bump.
    This ensures the grace-period countdown banner updates on every API call, not just on
    subscription re-fetches.

42. **`has_used_trial` guard in first-store transaction.** Before creating a new account in the
    first-store transaction (§8 Step 3), check whether any existing `account_users` row already
    links this user to an account (handles the race guard via advisory lock, §8.F9). Also ensure
    the new `account_subscription` row sets `has_used_trial = true` at creation so a user who
    cancels and attempts to re-sign-up cannot start a second trial. Enforce at DB level:
    `CHECK (has_used_trial = true OR status = 'trialing')` on `account_subscriptions` is too
    permissive — instead enforce in application logic: if `has_used_trial = true`, new
    subscriptions for this account start at `status = 'free'`, not `'trialing'`.

---

*End of Subscription & Billing PRD*