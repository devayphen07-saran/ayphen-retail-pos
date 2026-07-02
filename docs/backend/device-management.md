# Device Management — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** every device flow, screen, rule, edge case, and failure mode — each flow detailed.
> **Source of truth:** backend is authoritative. The device backend (`store_device_access`
> table, `/devices/*` and `/stores/:id/devices/*` endpoints, daily expiry cron) **already exists**
> — this PRD describes correct end-to-end behaviour. Unsettled product choices are marked **DECISION**.

---

## Table of contents
1. [Overview & scope](#1-overview--scope)
2. [The subscription & limit model — Account model](#2-the-subscription--limit-model--account-model)
3. [Entities & data model](#3-entities--data-model)
4. [Device trust levels](#4-device-trust-levels)
5. [Plan limits](#5-plan-limits)
5B. [F0 — Store creation gate (account `max_stores`)](#5b-f0--store-creation-gate-account-max_stores)
6. [F1 — Device registration (at login)](#6-f1--device-registration-at-login)
7. [F2 — Store access & device-limit check](#7-f2--store-access--device-limit-check)
8. [F3 — Device limit reached](#8-f3--device-limit-reached)
9. [F4 — Manage store devices](#9-f4--manage-store-devices)
10. [F5 — Remove device from store](#10-f5--remove-device-from-store)
11. [F6 — Removed-device experience](#11-f6--removed-device-experience)
12. [F7 — My Devices (user-level)](#12-f7--my-devices-user-level)
13. [F8 — Block stolen / lost device](#13-f8--block-stolen--lost-device)
14. [F9 — Unblock device](#14-f9--unblock-device)
15. [F10 — Auto-expiry of inactive devices](#15-f10--auto-expiry-of-inactive-devices)
15B. [F10B — Device-slot lease (heartbeat · release · crash reclaim)](#15b-f10b--device-slot-lease-heartbeat--explicit-release)
16. [F11 — Re-registration (app reinstall)](#16-f11--re-registration-app-reinstall)
17. [F12 — Push token management](#17-f12--push-token-management)
18. [F13 — Multi-device sync impact](#18-f13--multi-device-sync-impact)
19. [F14 — Subscription downgrade → devices over limit](#19-f14--subscription-downgrade--devices-over-limit)
20. [F15 — Subscription expiry → device behaviour](#20-f15--subscription-expiry--device-behaviour)
21. [F16 — Offline behaviour (all cases)](#21-f16--offline-behaviour-all-cases)
22. [Navigation](#22-navigation)
22B. [Loading states (per flow)](#22b-loading-states-per-flow)
23. [RBAC matrix](#23-rbac-matrix)
24. [Business rules](#24-business-rules)
25. [Validation matrix](#25-validation-matrix)
26. [Real-world scenarios](#26-real-world-scenarios)
27. [Design issues & decisions](#27-design-issues--decisions)
28. [Dos & don'ts](#28-dos--donts)
29. [Phase 2 — deferred](#29-phase-2--deferred)
30. [Offline-expiry write-gating handshake (resolves D1)](#30-offline-expiry-write-gating-handshake-resolves-d1)

---

## 1. Overview & scope

Device Management controls **which physical phones/tablets can access each store** and gives
owners tools to see, label, remove, and block devices. In an Indian kirana context a "device" is
the cashier's billing phone, the owner's personal phone, or a counter tablet.

**It enables:**
- Invisible device registration on first login (Ed25519 key pair → trusted device identity).
- A device limit (from the subscription plan) that blocks new devices when slots are full.
- Owner visibility & control over every device touching their store (label, remove).
- Emergency block of a stolen/lost device — kills all sessions and store access instantly.
- Automatic freeing of slots when a device goes unused for 30 days.

**Out of scope (Phase 1):**
- Device-level operation gating (all registered devices do whatever the user's role allows).
- Geofencing, remote wipe, device groups/tagging, configurable expiry window, device transfer.
- **Push-driven device notifications** — see [§27](#27-design-issues--decisions): no push sender
  is wired today, so device-state changes propagate via the **next API call / sync**, not push.

---

## 2. The subscription & limit model — Account model

The **Account** is the top-level business entity. One `account_subscription` governs every store
under the account. Device limits are enforced **per store** — not per account. This is the model
the rest of this PRD assumes.

### 2.1 What the plan grants
The **Account** holds one `account_subscription`. The plan defines:

| Plan feature | Scope | Example (Mid) |
|---|---|---|
| `max_stores` | **Account** — how many stores the account may run | 2 |
| `max_locations_per_store` | **Store** — branch slots each store gets (head office = 1) | 3 |
| `max_devices_per_store` | **Store** — device slots **each** store gets independently | 5 |
| `max_users_per_store` | **Store** — staff per store | 10 |
| status / grace / expiry | **Account** — one status governs all stores under the account | — |

> **"5 devices" always means 5 devices _per store_, never 5 total.** Store A full (5/5) does not
> affect Store B's device budget. "2 stores" is the account cap.

### 2.2 What's enforced where

| Concern | Level | Mechanism |
|---|---|---|
| Subscription / billing / payment | **Account** | one `account_subscription` per account |
| `max_stores` | **Account** | checked at `POST /stores` via `stores.account_fk → account_subscription` (F0) |
| `max_locations_per_store` | **Store** | checked at `POST /stores/:id/locations` (subscription §15D) |
| Expiry / grace / read-only | **Account** | applied to **all stores** under the account at once (F15) |
| **Device limit (count + slot claim)** | **Store** | `COUNT(store_device_access WHERE store_fk=this AND status='active') < max_devices_per_store` at `/access` (F2) — **unchanged from the built backend** |
| Staff / invites | **Store** | each store staffed independently (`max_users_per_store`) |
| Device identity (registration) | **User/device** | one phone, many stores (F1) |

### 2.3 Why per-store device limit (vs rejected alternatives)

- **Per-store subscription (rejected):** each store a separate plan → a 2-store owner pays twice;
  no account-level `max_stores` cap; doesn't match "one plan for my business."
- **Per-account device pool (rejected):** "5 devices total across 2 stores" is operationally
  broken — the owner's 2 phones leave 3 slots for **all** staff in **all** stores combined.
  A global device count also fights offline-first: stores sync independently, so a global count
  requires online coordination on every slot claim across stores.
- **Account subscription + per-store device limit (chosen):** the account pays once and gets
  a `max_stores` cap; each store independently gets its own `max_devices_per_store` budget.
  The device limit stays **locally enforceable** (no cross-store count), which the offline-first
  POS requires. The existing device backend (`store_device_access` table) is unchanged.
  This is how Shopify POS, Square, and Toast multi-location billing work.

### 2.4 The `max_devices_per_store` value (`maxDevices`) used throughout

Everywhere below:
- **`maxDevices`** = `account_subscription → plan_entitlements(max_devices_per_store)` for the
  account that owns the store being accessed.
- **`activeDeviceCount`** = `COUNT(store_device_access WHERE store_fk=thisStore AND status='active')`.

There is no account-wide device count. The plan is resolved via
`store.account_fk → account_subscription → plan_entitlements`.

---

## 3. Entities & data model

### 3.1 The three entities
```
User (person)
  ├── owns devices (1 user → many devices)        → table: device
  │     • Samsung Galaxy M34 (owner's phone)
  │     • iPad Air (counter tablet)
  │     • [blocked] Redmi Note 12 (stolen)
  └── has store access (per store)                → table: store_device_access
        • Sharma Kirana (Owner): Galaxy, iPad, Priya's iPhone  (3/3)
        • Kumar Traders (Manager): Galaxy                       (1/N)
```

### 3.2 Key relationships
- **A device belongs to a USER** (`device.user_fk`); the **limit is enforced per STORE**
  (`store_device_access`).
- **One phone can access multiple stores** — counted **independently per store** (§2): the
  same phone consumes one slot in each store it accesses, against that store's `max_devices_per_store`.
- **Registration ≠ slot.** Registration creates the device *identity*; a **store slot** is consumed
  only when the device actually accesses a store.

### 3.3 Tables (already exist — do NOT recreate)
**`device`** — crypto key pair, platform/model/os/app version, `attestation_verified`,
`is_trusted`, `is_blocked`, push token, `last_seen_at`. One row per physical device per user.

**`device_session`** — active sessions per device with step-up, expiry, revocation.

**`store_device_access`** — the device↔store link enforcing the limit:
`id, guuid, store_fk, device_fk, user_fk, status('active'|'revoked'|'expired'), device_label,
first_accessed_at, last_accessed_at, revoked_at, revoked_by,
revoked_reason('owner_removed'|'stolen'|'auto_expired'|'plan_downgrade'), row_version,
created_at, modified_at`. Unique index: one `active` row per `(store, device)`.

---

## 4. Device trust levels

| Level | Flags | Meaning | Phase 1 behaviour |
|---|---|---|---|
| **Registered** | `attestation_verified=false, is_trusted=false` | Has a key pair. Minimum. | Full access |
| **Attested** | `attestation_verified=true` | Passed Play Integrity / App Attest. | Full access — attestation **logged, not enforced** |
| **Trusted** | `is_trusted=true` | Owner marked trusted. | Full access — flag stored for Phase 2 |
| **Blocked** | `is_blocked=true` | Compromised/stolen. | All sessions killed; cannot auth; cannot sync |

**Phase 1:** non-blocked devices treated identically. **Do not enforce attestation** — many Indian
budget Android phones fail Play Integrity (custom ROMs / unlocked bootloaders); log it, never block.
`is_trusted` gating is Phase 2.

---

## 5. Plan limits

`maxDevices` = `plan_entitlements(max_devices_per_store)` on the `account_subscription` owned by the
account that owns the store. `NULL` = unlimited.

| Plan (= tier) | `max_devices_per_store` | `max_locations_per_store` | `max_stores` | Typical use |
|---|---|---|---|---|
| Free | 1 | 1 | 1 | Owner's phone only, single location |
| Basic | 3 | 1 | 1 | Owner + 2 cashiers, single location |
| Premium | 5 | 3 | 2 | Two counters / small chain, up to 2 branches |
| Professional | 10 | 5 | 5 | Multi-counter, up to 4 branches per store |
| Enterprise | `NULL` (∞) | `NULL` (∞) | `NULL` (∞) | Chain |

> These mirror the seeded catalog ([subscription §3](./subscription.md#3-plan-catalog--tiers)).
> **GAP:** the backend currently reads `max_devices` from `store_subscription` — must be pointed at
> `account_subscription → plan_entitlements(max_devices_per_store)` (subscription §27 item 7).

The device limit is enforced **at store access** (F2), not at registration; `max_stores` is enforced
at store-create (F0).

---

## 5B. F0 — Store creation gate (account `max_stores`)

**Trigger:** user taps "Create store". **Actor:** owner or co_owner.
**Scope:** account-level — caps how many stores the **account** runs.

### Steps
1. Client → `POST /stores`.
2. **Backend:**
   1. Resolve `auth.user → account_users → account → account_subscription → plan_entitlements(max_stores)`
      → `maxStores`.
   2. `activeStoreCount = COUNT(stores WHERE account_fk=account AND NOT locked AND NOT archived)`.
   3. `maxStores=NULL` (Enterprise) → create.
   4. `activeStoreCount < maxStores` → create store atomically:
      - `stores` row with `account_fk`.
      - **Head Office location** provisioned in the same transaction (`is_primary=true, display_order=0`).
      - Provisions role, default-pin, walk-in customer, tax slabs, register.
   5. `activeStoreCount >= maxStores` → **403 `STORE_LIMIT_REACHED`** `{ limit, active }` →
      client shows "Your plan allows {limit} stores. Upgrade to add more."
3. **Locked stores do NOT count** against `max_stores` (a store locked by downgrade is read-only,
   not active — see F15/F14). Re-activating one (on upgrade) re-counts it.

### Rules
- `max_stores` is **account-level**; `max_devices_per_store` is **store-level** (F2). They are
  independent limits.
- Downgrading the plan never deletes a store — excess stores become **read-only locked** (F14).

---

## 6. F1 — Device registration (at login)

**Trigger:** user logs in on a device for the first time (OTP login).
**Actor:** any user. **Visibility:** invisible — no "register device" screen.

> ⚠️ There is **no separate `POST /devices/register` endpoint.** Registration is folded into the
> mobile login (stage-2 carries the `device` object). This flow describes that.

### Steps
1. App opens → user completes OTP login.
2. Client checks Keychain/Keystore for an existing device key pair.
   - **Exists** (reinstall, keys survived) → reuse; send existing `publicKey` → server matches by
     `(user_fk, publicKeyHash)` → returns existing device (no new identity). → F11.
   - **None** (first install / wiped) → generate **Ed25519** key pair:
     - private key → Keychain/Keystore, **never leaves the device**.
     - public key → sent to server.
3. Login stage-2 body includes:
   `device: { publicKey, platform, model, osVersion, appVersion, pushToken, attestation:{token, bundleId} }`.
4. **Backend:**
   1. `publicKeyHash = SHA-256(publicKey)`.
   2. `(user_fk, publicKeyHash)` exists → update `last_seen_at`, `app_version`, `push_token` → return existing device.
   3. Else create a new `device` row.
   4. Verify attestation: pass → `attestation_verified=true`; fail → `false` (**logged, not blocking**).
   5. Create `device_session`; issue refresh token bound to it.
   6. `audit_log`: `login_success` with `deviceId`.
   7. Return `{ deviceGuuid, deviceSessionGuuid, isTrusted }`.
5. **Client stores:** `deviceGuuid` (AsyncStorage), `deviceSessionGuuid` (memory), refresh token (secure).

### Rule
Registration does **not** consume a store slot — the slot is claimed in F2.

### Edge cases
- Blocked key pair (`is_blocked`) → login `403 DEVICE_BLOCKED` (F8).
- Attestation fails → still registers; logged only.

---

## 7. F2 — Store access & device-limit check

**Trigger:** user opens a store (picker tap, single-store auto-nav, store switch).
**Actor:** any user. **Online-only** (the slot claim is a write; offline → F16).

### Endpoint
`POST /stores/:storeId/access` — **empty body**; device identity from the authenticated context
(`auth.device.id`), **not** a request body.

### Steps
1. Client → `POST /stores/:storeGuuid/access` (empty body).
2. **Backend:**
   1. Resolve `store.account_fk → account_subscription → plan_entitlements(max_devices_per_store)` → `maxDevices`.
   2. Active `store_device_access` for `(store, thisDevice)`?
      - **Yes** → update `last_accessed_at=NOW` → `{ access:'granted', isNew:false }`.
      - **No** → compute `activeDeviceCount = COUNT(store_device_access WHERE store_fk=store AND status='active')`
        (**per store only — no account-wide count**):
        - `maxDevices=NULL` (Enterprise) → create row → granted.
        - `activeDeviceCount < maxDevices` → create row (`first/last_accessed_at=NOW, status='active'`) → `{ granted, isNew:true }`.
        - `activeDeviceCount >= maxDevices` → **403 `DEVICE_LIMIT_REACHED`** `{ limit, active, devices:[...] }` (F3).
3. **Concurrency:** count-and-insert must be **atomic** (transaction + unique index on
   `(store, device, status='active')`) so two devices can't grab the last slot.

### When the check runs
| Trigger | Runs? |
|---|---|
| Launch → auto-nav to single store | Yes |
| Tap store on picker | Yes |
| Switch stores | Yes |
| Return from background (session live) | No |
| Pull-to-refresh inside store | No |
| Offline | No — cached access (F16) |

### Created on first access
`store_fk, device_fk, user_fk, status='active', device_label=NULL, first_accessed_at=NOW, last_accessed_at=NOW`.

---

## 8. F3 — Device limit reached

**Trigger:** F2 returns `403 DEVICE_LIMIT_REACHED`. **Loading:** full-screen.

### F3.1 Owner / Manager
```
← Device limit reached
This store allows 3 devices. All slots are in use.
─── Active Devices ───
📱 Samsung Galaxy M34   Ramesh (Owner)    Today, 2:30 PM
📱 iPhone 13            Priya (Cashier)   Today, 11:00 AM
📱 iPad Air             Kumar (Manager)   2 days ago
Remove a device to free a slot or upgrade your plan.
[Manage Devices]   [Upgrade Plan]
```

### F3.2 Cashier / Staff (no manage / upgrade)
```
← Device limit reached
This store allows 3 devices. All slots are in use.
─── Active Devices ───  (same list)
Contact the store owner to free up a device slot.
[OK]
```

### Rules
- Owner/Manager → `[Manage Devices]` (F4) + `[Upgrade Plan]`.
- Staff → read-only list + `[OK]` → store picker. Cannot manage/upgrade.
- Staff see the active list **only here** (context); the full Manage screen is owner-only.

---

## 9. F4 — Manage store devices

**Navigation:** Store Settings → Devices (also F3 `[Manage Devices]`).
**Endpoint:** `GET /stores/:storeId/devices` → active + recently-revoked + `{limit, active, planName}`.

### Layout
```
← Devices                                   3 / 3
Basic Plan — 3 devices allowed
─── Active ───
📱 Samsung Galaxy M34  Ramesh (Owner)   Today 2:30 PM   Reg 15 Jun   📍 This device
📱 iPhone 13           Priya (Cashier)  Today 11:00 AM  Reg 20 Jun           [Remove]
📱 iPad Air "Counter Tablet"  Kumar (Manager)  2 days ago  Reg 22 Jun        [Remove]
─── Removed ───
📱 Redmi Note 12  Raju (former Cashier)  Removed 24 Jun  Reason: Owner removed
Devices inactive for 30 days are removed automatically.   [Upgrade for more devices]
```

### Row fields
Platform icon (`device.platform`) · Model (`device.model`) · User+role (`user.name` + role from
`user_role_mapping`) · Label (`store_device_access.device_label`, per store) · Last active
(`last_accessed_at`) · Registered (`first_accessed_at`) · "This device" badge · `[Remove]` (owner,
hidden on current device) · Status (active/removed).

### Sub-rules
- **Removed section:** revoked/expired rows from the last **90 days**; older hidden in UI, retained in DB.
- **Label editing (owner):** tap row → sheet → set `device_label` (max 100 chars). Per store.

---

## 10. F5 — Remove device from store

**Trigger:** owner taps `[Remove]`. **Actor:** owner only.

### Steps
1. Confirmation:
   ```
   Remove this device?
   📱 iPhone 13 — Used by: Priya (Cashier)
   This device will lose access to this store. Priya can re-register by opening the store again
   (if a slot is available).
   [Cancel]   [Remove Device]
   ```
2. Confirm → `POST /stores/:storeGuuid/devices/:deviceGuuid/revoke` `{reason:'owner_removed'}`.
3. **Backend (atomic):**
   1. `status='revoked'`, `revoked_at=NOW`, `revoked_by=owner`, `revoked_reason='owner_removed'`.
   2. Revoke active `device_session`s for `(device+user)` tied to this store.
   3. *(Push notify removed device — **not wired today**, §27.)*
   4. `audit_log`: `device_revoked` `{deviceModel, userName, reason}`.
4. **Client:** list refreshes; count `3/3 → 2/3`; device → Removed; toast "Device removed".

### Hard rule (self-lockout prevention)
**Cannot remove your own current device.** `[Remove]` hidden on "This device". Use another device.

### Graceful mid-shift removal (DECISION)
If the removed device is mid-sale, it should **finish the current sale + sync** before the
revocation takes effect locally (it learns on next call). Warn the owner the cashier is active.

---

## 11. F6 — Removed-device experience

**Trigger:** the revoked device (F5) keeps being used.

### Online
1. Next API call → `403 DEVICE_REVOKED`.
2. Modal:
   ```
   Access removed
   Your device no longer has access to this store. Contact the store owner to re-enable access.
   [OK]
   ```
3. `[OK]` → store picker (or home if single store).

### Offline
1. Device keeps working locally.
2. Next sync → mutations rejected `DEVICE_ACCESS_REVOKED`.
3. Same modal; unsynced changes for this store marked **conflicted** (F13).

### Critical rules
- **Membership NOT removed** — only the device lost access. A freed slot lets the user re-access (F2).
- **No push** — device learns on next call/sync (push not wired).

---

## 12. F7 — My Devices (user-level)

**Navigation:** My Account → My Devices. **Endpoint:** `GET /devices/my` (also `GET /me/devices`).
Shows **all devices registered to the current user across ALL stores** — distinct from F4.

### Layout
```
← My Devices
📱 Samsung Galaxy M34  Android 14 · v1.2.0  📍 This device  Last seen: Now
   Trusted: Yes ✓   Stores: Sharma Kirana, Kumar Traders
📱 iPad Air            iPadOS 17 · v1.2.0   Last seen: 2h ago
   Trusted: No   Stores: Sharma Kirana                                  [Rename]
─── Blocked ───
📱 Redmi Note 12 🚫  Android 13  Blocked 24 Jun  Reason: Reported stolen   [Unblock]
```

### Row fields
Model/OS/app version · Last seen (`device.last_seen_at`) · "This device" · Trusted (`is_trusted`) ·
Stores (from `store_device_access WHERE device_fk AND status='active'`) · `[Rename]`
(`PATCH /devices/:guuid/label`) · Blocked badge + `[Unblock]`.

### F7 vs F4
| Aspect | My Devices (F7) | Manage Store Devices (F4) |
|---|---|---|
| Scope | this user's devices, all stores | devices that accessed **one** store |
| Actions | Block, Unblock, Rename | Remove from store, Label |
| Who | any user (own) | owner (full), manager (view) |

---

## 13. F8 — Block stolen / lost device

**Trigger:** the device's owner logs in elsewhere to block a stolen/lost phone.
**Actor:** the device's registered user (any account role — blocking their own device).

### Steps
1. Other phone → My Account → My Devices → stolen device → `[Block — Device Lost/Stolen]`.
2. Confirmation:
   ```
   Block this device?
   📱 Samsung Galaxy M34
   This will immediately: sign out all sessions · revoke access to all stores · prevent future login.
   Local data stays encrypted and cannot be accessed without your login credentials.
   [Cancel]   [Block Device]
   ```
3. `PATCH /devices/:deviceGuuid/block` `{reason:'stolen'}`.
4. **Backend (single transaction):**
   1. `device.is_blocked=true`, `is_trusted=false`.
   2. Revoke **all** `device_session`s (`revoked_reason='device_blocked_stolen'`).
   3. Revoke **all** `store_device_access` rows (`status='revoked'`, `revoked_reason='stolen'`) → frees slots everywhere.
   4. Revoke all refresh tokens for the device's sessions.
   5. Blacklist the device's JWT (`revoked_token`).
   6. Null the push token.
   7. `audit_log`: `device_revoked`, severity `alert`, `{reason:'stolen', storesAffected:[...]}`.
5. **Effect on stolen device:**
   - App open → next call `401`; background → push fails; reopen → JWT expired + refresh denied → forced logout.
   - Local SQLite encrypted (SQLCipher, device-bound key) → unreadable.
   - Cannot re-register: `publicKeyHash` linked to blocked device → `403 DEVICE_BLOCKED`.

### Notes
- Block = **global kill** (all stores), unlike F5 (one store).
- Factory reset → new keys bypass the block — acceptable (local data lost too).

---

## 14. F9 — Unblock device

**Trigger:** device recovered / blocked by mistake. **Actor:** the user who blocked it.

### Steps
1. My Devices → blocked device → `[Unblock]` → `PATCH /devices/:deviceGuuid/unblock`.
2. **Backend:** `is_blocked=false`; `audit_log: device_unblocked`.
3. **Result — device is "fresh":** old sessions stay revoked (must log in again); all
   `store_device_access` rows stay revoked (must re-access each store, F2); effectively reinstalled.

---

## 15. F10 — Auto-expiry of inactive devices

**Trigger:** daily cron `device-expiry.job` (`@Cron EVERY_DAY_AT_2AM`). Already exists.

> **Distributed lock required (F7):** The device-expiry cron mutates shared `store_device_access` rows. Concurrent cron runs (e.g., if the previous run takes longer than 24h, or if two nodes fire at the same time) can double-expire or audit-log the same slots twice. Before processing, acquire a Redis distributed lock:
> ```ts
> const lock = await redis.set('cron:device-expiry', '1', 'EX', 3600, 'NX');
> if (!lock) { logger.warn('[cron] device-expiry already running — skipping'); return; }
> ```
> Release the lock in `finally`. TTL of 1 hour is a backstop; the cron should complete in seconds.

### Steps
1. Select `store_device_access WHERE status='active' AND last_accessed_at < NOW() - 30 days`.
2. Per stale row: `status='expired'`, `revoked_at=NOW`, `revoked_reason='auto_expired'`;
   *(push notify owner — **not wired**, §27)*; `audit_log`.
3. **Effect:** slot frees; device **not blocked** (user can still log in); next store access (F2)
   creates a new row if a slot is free.

### Rationale
A kirana operates daily; a device idle 30 days is almost certainly a replaced phone / former
employee. **30 days hardcoded in Phase 1** (Phase 2: configurable 7/14/30/60/90).

---

## 15B. F10B — Device-slot lease (heartbeat + explicit release)

A store slot is effectively a **lease**, not a permanent grab. The lease is what lets slots recover
when a device crashes, is lost, or logs out — without waiting on a manual remove.

### The lease model (mostly already in place)
| Lease part | Mechanism | Status |
|---|---|---|
| **Claim** | `POST /stores/:id/access` creates the `store_device_access` row | ✅ built (F2) |
| **Heartbeat** | `last_accessed_at` updated on every store access | ✅ built (BR-DEV-004) |
| **Expiry (TTL)** | 30-day auto-expiry cron frees a stale slot | ✅ built (F10) |
| **Renew** | re-opening the store (idempotent re-claim) refreshes the heartbeat | ✅ built (F2) |
| **Release** | **explicit free on logout / uninstall** | 🆕 **ADD** (F10B.1) |
| **Crash reclaim** | **owner instant reclaim at point of contention** + optional contended-slot soft-TTL | 🆕 **ADD** (F10B.3) |

### 🆕 F10B.1 Explicit release on logout
Today a slot frees only via owner-remove (F5) or the **30-day** expiry — so a user who logs out (or
hands the phone back) **holds a slot for up to a month**. Add an explicit release:
- On **user-initiated logout** and on the logout-all path → `DELETE /stores/:id/access` (or
  `POST /auth/logout` cascades a release) → `store_device_access.status='revoked'`,
  `revoked_reason='released'` → slot frees **immediately**.
- **Best-effort + offline-tolerant:** if logout happens offline, queue the release; the slot still
  frees on the next online event, and the 30-day expiry remains the backstop.
- **Block (F8) already releases** all slots; this just adds the *graceful* logout path.

### F10B.2 Why NOT shorten the 30-day TTL
A short heartbeat-TTL (e.g. 3 days) would **kick out a device that was merely offline** — a cashier on
a week's leave, a shop closed for a festival. **Keep the long expiry as the backstop**; recover slots
*fast* via explicit **release-on-logout**, *slowly* via the 30-day TTL. Long TTL + explicit release =
both fast recovery (the common case) and tolerance of legitimate absence.

### 🆕 F10B.3 Crash recovery — the gap release-on-logout doesn't cover
**Release-on-logout only fires on a *graceful* exit.** A device that **crashes, is lost, stolen, or
factory-reset without logging out** never sends the release → its slot is stuck until the **30-day TTL**.
For a 2-slot kirana that bought a replacement phone today, "wait 30 days" is unacceptable. Two
complementary recoveries — neither shortens the global TTL, so legitimate-absence tolerance is preserved:

1. **Owner instant reclaim (primary, build first).** When a new device hits the device limit, the claim
   error returns the **current slot holders sorted by `last_accessed_at`** (which device, last-seen-when).
   The owner taps **"Release this device"** → `DELETE /stores/:id/access?device=:id` frees it
   **immediately**, new device claims. This is F5 made *contextual at the point of contention* — the owner
   never has to hunt through a settings screen. (BR-DEV-022)
2. **Contended-slot soft reclaim (optional, automatic).** *Only when a store is at its device limit AND a
   new claim is waiting*, a slot whose `last_accessed_at` is older than a **short contended-TTL (e.g. 72 h)**
   may be auto-reclaimed. The short TTL applies **exclusively under contention** — an idle slot in a store
   below its limit still enjoys the full 30 days. This gives automatic crash recovery without punishing a
   genuinely-absent cashier when there's no pressure on the slots.

A reclaimed device, on its next online event, is told `device_released` and **re-claims transparently if a
slot is free**, else shows "ask the owner to free a device" (the standard at-limit path).

---

## 16. F11 — Re-registration (app reinstall)

| Case | Behaviour |
|---|---|
| Key pair survives (iOS Keychain) | Send existing `publicKey` → match by hash → **same device**, no new row/slot. |
| Key pair wiped (Android Keystore cleared / reset) | New key pair → new `publicKeyHash` → **new device row**; old orphaned. |
| Orphaned device had active access | Auto-expires in 30 days (F10) or owner removes manually (F5). |

**Reinstall does NOT bypass a block.** `is_blocked=true` → login rejected for that
`user + device_model` for 24h (rate limit). Factory reset → new keys bypass (local data lost too).
**Watch:** reinstall churn can exhaust a small `maxDevices` quickly — surface self-service removal.

---

## 17. F12 — Push token management

**Trigger:** app launch (foreground). Endpoint: `PATCH /devices/:guuid/push-token`.

### Steps
1. Client reads Expo push token.
2. Unchanged → no-op. Changed (OS rotated / reinstall) → `PATCH .../push-token {pushToken}` → `device.push_token=new`.

### Rules
- **Blocked device:** token set `NULL`; never receives notifications.
- **Removed from store:** token stays valid — device still gets other stores'/account alerts; only
  the removed store's notifications are suppressed.
- ⚠️ **Push is stored but never sent** today (§27) — token management is forward-looking.

---

## 18. F13 — Multi-device sync impact

| Event | Sync cleanup |
|---|---|
| Removed from store (F5) | `sync_init_progress` for `(store, device)` deleted → re-access = full cold-start. |
| Blocked (F8) | `sync_init_progress` for **all** `(store, device)` deleted; `local_sync_conflict` for device → `discarded`; `mutation_idempotency` **retained** (prevent replay). |
| Auto-expired (F10) | `sync_init_progress` for `(store, device)` deleted; re-access → may `410 SYNC_HORIZON_EXCEEDED` → full cold-start. |
| New device accesses store (F2) | fresh `sync_init_progress`; cold-start from scratch. |

---

## 19. F14 — Subscription downgrade (account plan → lower limits)

**Trigger:** the owner's **account plan** changes to lower `max_stores` and/or
`max_devices_per_store` while more stores/devices are active (e.g. higher 5-store/10-per-store →
Mid 2-store/3-per-store).

### A. Fewer devices-per-store (e.g. 10 → 3, applied to every kept store)
1. **Existing devices keep working.** Downgrade does **NOT** auto-remove devices (BR-DEV-015).
2. **New registrations/accesses blocked** in a store until that store's `activeDeviceCount ≤ max_devices_per_store`.
3. Slots free via **auto-expiry** (F10) or **manual removal** (F5).
4. **Per-store banner:** "5 devices active. Your plan allows 3 per store. Remove 2 or they'll expire after 30 days of inactivity."

### B. Fewer stores (e.g. 5 → 2, account `max_stores`)
1. The owner has 5 stores, plan now allows 2 → **owner chooses which 2 stay active**.
2. The other 3 → **read-only locked** (`store.locked=true`), data retained, "Upgrade to reactivate".
   **Never auto-pick, never delete.**
3. **Drain first:** before a store is locked, force a **final sync** of its offline queue so no
   rung-up sales are lost.
4. Locked stores **don't count** against `max_stores` (F0) and are excluded from new device claims.
5. Staff in locked stores keep membership but go **read-only** (see F15 staff rules).
6. On **re-upgrade**, locked stores reactivate automatically.

---

## 20. F15 — Subscription expiry → device behaviour

**Trigger:** `account_subscription` lapses (past_due grace-over, or cancelled period-over) —
applies to **all stores under the account** simultaneously.

### Rules (binary, not gradual)
1. **Grace (7 days):** full device access in all stores under the account; warning banner.
2. **After grace:** **all stores under the account** go **read-only** — devices may **open** + **read**
   (history/reports), but **writes (sales) blocked**; devices **not** revoked (slots preserved);
   **reads never blocked**.
3. **Paused (admin/abuse only):** full block (`403`), suspended overlay.
4. **Never** delete devices/data on expiry.

### Staff rules
All users across all stores in the account keep their **membership** but lose **writes**; they see
"Business subscription expired — view-only." A staffer only loses access to a store if the account
owner explicitly archives it or revokes their role — not due to subscription expiry alone.

### Offline interaction (CRITICAL — §27 D1)
A device offline during/after grace keeps selling locally; on sync those writes are rejected.
**Required:** client caches subscription status and **blocks new sales locally** once it knows the
plan lapsed, **and** the server **honours offline-origin sales** stamped (`client_modified_at`)
before grace-end. Without both, real sales the shop rang up are lost.

---

## 21. F16 — Offline behaviour (all cases)

| Scenario | Behaviour |
|---|---|
| Launch offline, device has cached access | Enters store; `last_accessed_at` updated locally, synced later. |
| Launch offline, device **never** accessed this store | Limit check can't run → "Internet connection required for first-time device setup." |
| Device removed while it is offline | Keeps working; next sync → `403 DEVICE_ACCESS_REVOKED` → access-removed modal. |
| Device blocked while it is offline | Keeps working; next call/sync → `401` → forced logout. |
| Owner removes a device while **owner** is offline | Removal queued; processed on next sync; target keeps working until processed. |
| Auto-expiry while device offline | Next online access → server creates a new row (if slot free) else limit-reached. |

**Principle:** device access is **server-enforced**. Offline access is a **grace period, not a
bypass** — validated on every call/sync.

---

## 22. Navigation

```
USER-LEVEL  (all stores):  More → My Account → My Devices    (F7 — block/unblock/rename)
STORE-LEVEL (one store):   More → Settings → Devices          (F4 — remove/label/count vs limit)
```

---

## 22B. Loading states (per flow)

Treatments use the [mobile-08 §13](./mobile-08-loading-ux-states.md) vocabulary (**A–E**); rules live there.

| Flow | Treatment | Notes |
|---|---|---|
| Store access / slot claim (F2) | **C** | brief POS-shell skeleton while `/access` returns; cached reopen = instant |
| Device limit reached (F3) | **B** full-screen | owner: manage/upgrade · staff: "contact owner" + list |
| Manage store devices (F4) | **C** / instant | section skeleton while `GET /stores/:id/devices` loads |
| Remove device (F5) | **E** + toast | optimistic (count 3→2), confirm dialog first; "Device removed" toast |
| Removed-device experience (F6) | **modal** (not a loader) | "Access removed" on next 403 |
| My Devices (F7) | **C** / instant | skeleton while `GET /devices/my` loads |
| Block stolen (F8) | **E** + confirm | confirm dialog → instant kill; **D** silent on the blocked device |
| Unblock (F9) | **E** button spinner | quick |
| First-time access offline (F16) | **banner/modal** (not a loader) | "Internet required for first-time setup" |

---

## 23. RBAC matrix

| Action | Owner | Manager | Cashier |
|---|---|---|---|
| View own devices (My Devices) | ✓ | ✓ | ✓ |
| Block / Unblock own device | ✓ | ✓ | ✓ |
| Rename own device | ✓ | ✓ | ✓ |
| View store devices | ✓ | ✓ (view only) | ✗ |
| Remove device from store | ✓ | ✗ | ✗ |
| Label a device in store | ✓ | ✗ | ✗ |
| Upgrade plan | ✓ | ✗ | ✗ |
| Trust/untrust (Phase 2) | ✓ | ✗ | ✗ |

- **Cashiers can't see the store device list** — it exposes who uses which phone (privacy/ops).
- **Managers view but can't remove** — context only; removal is owner-only (security).

---

## 24. Business rules

| ID | Rule |
|---|---|
| BR-DEV-000 | Store creation is gated by `account_subscription → plan_entitlements(max_stores)` (F0); locked stores don't count. |
| BR-DEV-001 | **Account model (§2):** `account_subscription` governs all stores under the account; billing and `max_stores` are account-level; `max_devices_per_store` and `max_locations_per_store` are enforced **per store independently**. |
| BR-DEV-002 | Registration (login) does **not** consume a slot; store access does. |
| BR-DEV-003 | Active devices = `store_device_access.status='active'`; revoked/expired/blocked excluded. |
| BR-DEV-004 | `last_accessed_at` updated on every store access (keeps the 30-day clock ticking). |
| BR-DEV-005 | Cannot remove your own current device (self-lockout prevention). |
| BR-DEV-006 | Removing a device does **not** remove the user's store membership. |
| BR-DEV-007 | Blocked device cannot authenticate, sync, or re-register with the same key pair. |
| BR-DEV-008 | Block revokes **all** sessions and **all** store access globally. |
| BR-DEV-009 | 30-day inactivity auto-expires slots (daily cron). |
| BR-DEV-010 | `max_devices=NULL` → unlimited (no check). |
| BR-DEV-011 | Device label is per store. |
| BR-DEV-012 | Removed devices shown 90 days in UI; retained in DB for audit. |
| BR-DEV-013 | Re-registration with existing key pair returns the same device (no duplicate). |
| BR-DEV-014 | Push token nullified on block; restored on unblock + re-login. |
| BR-DEV-015 | Downgrade does **not** auto-remove excess devices; new registrations blocked; slots free via expiry/manual. |
| BR-DEV-016 | First-time store access requires internet (server-side limit check). |
| BR-DEV-017 | Sync cleanup on revocation: `sync_init_progress` deleted, conflicts discarded, idempotency retained. |
| BR-DEV-018 | Slot claim must be **atomic** (transaction + unique index) — no two devices share the last slot. |
| BR-DEV-019 | Device-state changes propagate via **next call / sync**, **not push** (push not wired). |
| BR-DEV-020 | Expiry/downgrade → read-only, never delete devices/data; reads never blocked. |
| BR-DEV-021 | A slot is a **lease**: claim (F2) · heartbeat (`last_accessed_at`) · 30-day TTL (F10) · **explicit release on logout** (F10B). Keep the long TTL as backstop; recover fast via release. |
| BR-DEV-022 | **Crash recovery:** a non-graceful exit (crash/loss/reset) is recovered by **owner instant reclaim at the point of contention** (slot holders listed by `last_accessed_at`, one-tap `DELETE`), optionally a **contended-slot soft-TTL (~72 h) that applies only when the store is at its limit** (F10B.3). The global 30-day TTL is never shortened. |

---

## 25. Validation matrix

| Trigger | Check | Result |
|---|---|---|
| Access store, limit reached | `activeDeviceCount >= maxDevices` AND not already active | Full-screen limit (F3) |
| Access store, device blocked | `device.is_blocked` | `401` → forced logout |
| Access store, revoked here, no slot | `status='revoked'` AND no slot | Limit reached (F3) |
| Access store, revoked but slot free | `status='revoked'` AND slot free | New row created silently — granted |
| Remove own current device | self | `[Remove]` hidden |
| Remove without permission | not owner | `[Remove]` hidden |
| Block already-blocked | `is_blocked=true` | `[Block]` → `[Unblock]` |
| First store access offline | no cache + no network | "Internet required for first-time setup" toast |
| Device label > 100 chars | length | "Device label cannot exceed 100 characters" |
| Downgrade over-limit | `maxDevices < activeDeviceCount` | No removal; banner; new registrations blocked |
| Concurrent last-slot claim | two inserts race | Atomic check → one granted, one limit-reached |

---

## 26. Real-world scenarios

**S1 — New store, owner phone only (Free, 1).** Owner's phone → 1/1. A 2nd phone → limit screen.

**S2 — Staff new phone.** Priya's iPhone 15 (new keys) → 3/3 limit. Owner removes old iPhone 13 (F5)
→ 2/3 → Priya re-opens → 3/3.

**S3 — Stolen phone.** Owner logs in on wife's phone → My Devices → Block (F8). Session dies; thief
can't log in; data encrypted; slot freed.

**S4 — Cashier quit.** Raju's phone idle; day 30 auto-expiry (F10) → slot frees → new hire registers.

**S5 — One phone, two stores.** Account has 2 stores (within `max_stores=2`). The owner's phone
accesses both → **two `store_device_access` rows**, each counted against **that store's** device
budget independently. Store 1 being full (5/5) does not affect Store 2. Each store independently
has room for the owner's phones + cashiers.

**S6 — Downgrade to fewer devices-per-store, 5 active in a store.** All 5 keep working; per-store
banner "5 active, plan allows 3 per store — remove 2 or they expire in 30 days." No 6th registers in
that store until ≤ 2.

**S7 — Expiry mid-day (offline POS).** The `account_subscription` lapses while a cashier sells
offline. Grace: sales sync fine. After grace: client must block new sales locally once cached
`access_valid_until` passes; server accepts offline sales stamped before grace-end — else real
sales are lost (§27 D1 + subscription §30).

**S8 — Higher plan (5 stores, 10 devices/store) expires, then downgrade to Professional (5 stores, 5/store).**
Expiry → 7-day grace (all stores full) → after grace **all stores read-only**. Owner resubscribes
to Professional: stores reactivate. In each store, devices over 5 keep working, new blocked, owner
prompted to remove or wait for auto-expiry. Staff keep membership; nobody deleted. On re-upgrade
to a higher tier, all locked devices reactivate automatically.

---

## 27. Design issues & decisions

| # | Issue | Resolution |
|---|---|---|
| D1 🔴→📋 | **Offline-first + expiry = lost sales.** Device offline after grace keeps selling; server rejects on sync. | **Fully specified in [§30](#30-offline-expiry-write-gating-handshake-resolves-d1):** point-in-time write-gating on both sides — client blocks new sales once the cached `access_valid_until` passes; server accepts any sale stamped before it. No lost sales; no indefinite free offline selling. Depends on a subscription freshness signal. |
| D2 ✅ | **Device-count semantics** (whose plan does a device count against?). | **Resolved by Account model (§2):** the device limit is **per store** — a device counts in the store it accesses, against that store's `max_devices_per_store` (resolved via `store.account_fk → account_subscription → plan`). No global/account device count exists. Slot claim is **atomic + online** (F2). |
| D3 ✅ | **Numbers too tight** (e.g. 3 devices shared across 2 stores). | **Resolved by per-store limit:** "5 devices" is **per store**, so each store has its own independent budget. No shared pool. |
| D10 ✅ | **Account-wide caps fight offline partitioning.** | **Resolved:** device cap stays **per store** (locally enforceable, offline-clean). Only `max_stores` is account-level, and it's checked online at store-create (F0). |
| D4 🟠 | **Push not wired.** Spec assumes push notifies removed/blocked/expired devices; no sender exists. | Propagate via **next call / sync** (works today). Build a real push sender only when needed; **don't depend on push**. |
| D5 🟡 | **No separate `/devices/register`.** | Registration is part of **login** (F1). |
| D6 🟡 | **`/access` body.** | Empty body; device from **auth context**, not `{deviceGuuid}`. |
| D7 🟡 | **`store_device_access` already exists.** | Do **not** recreate the table. |
| D8 🟡 | **Reinstall churn.** | Match re-registration by key-hash; surface self-service removal. |
| D9 🟡 | **Grace 1 day too short / gradual degradation is bad.** | **7-day grace**, then **binary read-only**; never gradual; never block reads; never delete. |
| D11 🔴 | **Backend reads device limit from `store_subscription` (wrong table) — C3 migration required.** | **Resolution:** point at `store.account_fk → account_subscription → plan_entitlements(max_devices_per_store)`. The `store_subscription` table is being dropped as part of the Account entity migration (subscription §29 items 1–6). `store_device_access` table and counting logic are **unchanged** — only the resolution path for `max_devices_per_store` changes. This migration MUST land before device limit enforcement is correct. Until it lands, `store_subscription` is read for limits and the result may not match the account's actual plan. |

---

## 28. Dos & don'ts

**Do:** block a stolen device immediately · label devices · let auto-expiry clean up · show the
active-device list on the limit screen · make slot claims atomic + online-only.

**Don't:** auto-remove excess devices on downgrade · block a device just to free a slot (use Remove)
· enforce attestation in Phase 1 · send the device list (with names) to staff · require internet on
every open (only first-time access) · **depend on push** for revocation propagation · delete
devices/data or block reads on expiry (go read-only).

---

## 29. Phase 2 — deferred

| Feature | Phase 2 scope |
|---|---|
| Device trust gating | Void / high-value refund / price override require `is_trusted`; owner trust UI. |
| Configurable expiry window | Store setting: 7/14/30/60/90 days. |
| Geofencing | Alert if a device accesses from >5km from the store. |
| Remote wipe | Local data deletion on next launch after block. |
| Device groups | Group by Counter / Back Office / Delivery. |
| Multi-user device login | Fast user switch with PIN on a shared tablet. |
| Device analytics | Devices/store over time, peak concurrent, model/OS distribution. |
| Per-store push preferences | Mute specific stores on a device. |
| Device transfer | One-tap transfer to another user (preserve identity + slot). |
| Attestation enforcement | Optional per-store strict mode (warn on fail; block if enabled). |
| Real push sender | FCM/APNs/Expo push delivery (token is stored but never sent today). |

### Cron Health Check Endpoints (Rec4 — 📋 Planned)

Background cron workers (device-expiry, subscription-reconcile, token-cleanup) can fail silently — the process runs, the cron fires, but the job throws and nothing alerts. Add a health check endpoint for each cron worker so oncall can verify the last successful run:

```ts
// GET /health/cron
{
  "device_expiry":           { "last_run_at": "2026-07-01T02:00:03Z", "status": "ok", "rows_processed": 12 },
  "subscription_reconcile":  { "last_run_at": "2026-07-01T06:55:01Z", "status": "ok", "rows_processed": 0 },
  "token_cleanup":           { "last_run_at": "2026-07-01T03:00:07Z", "status": "ok", "rows_processed": 847 },
}
```

Each cron writes its completion timestamp and result to a Redis key (`cron:health:{name}`) at the end of a successful run. The health endpoint reads these keys. Alert if `last_run_at` is older than `2 × schedule_interval`. This is the minimum viable observability for cron correctness.

---

## 30. Offline-expiry write-gating handshake (resolves D1)

The single most dangerous failure for an **offline-first POS**: the owner's subscription lapses,
a device is **offline**, the cashier keeps ringing up sales, and on reconnect the server **rejects**
them → the shop's real sales are lost. This section specifies the exact handshake that prevents it.

### 30.1 Goals (both must hold)
1. **Never lose a legitimate sale** — any sale rung up while access was still valid is accepted, even
   if it syncs hours/days later.
2. **A lapsed account cannot sell forever offline** — once the device knows access has ended, it
   stops allowing new sales locally.

### 30.2 The one field that drives everything — `access_valid_until`
The server computes, per account, a single timestamp: **the moment write-access ends**:
```
access_valid_until = max(
  current_period_end,                 // the paid/trial period
  past_due_grace_until                // + 7-day grace if past_due
)   // null/blocked immediately for `paused`
```
- `active | trialing | free` → writes always allowed (no expiry check).
- `past_due` / `cancelled` → writes allowed **strictly before** `access_valid_until`.
- `paused` → blocked immediately.

The device **caches** this with the subscription snapshot:
```
subscriptionGuard = {
  status,                  // active|trialing|free|past_due|cancelled|paused|expired
  access_valid_until,      // ISO — writes allowed while now < this
  refreshed_at,            // last online refresh
  server_time_offset_ms,   // from x-server-time, so device-clock tampering can't bypass
}
```

> **MITM vector for `server_time_offset_ms` (F8):** The `x-server-time` header is sent unprotected over HTTPS. On a network where TLS is terminated by an attacker (e.g., corporate proxy, rogue hotspot), the header can be forged to set a large negative `server_time_offset_ms`, effectively backdating the device's `now` and allowing sales past the access window. **Mitigation:** the server-side sync check (`POST /sync/delta`) is the authoritative backstop — `client_modified_at` is validated against `account_subscription.access_valid_until` on the server using server time, not client time. Client-side gating is defence-in-depth (UX), not the security boundary. For stronger protection, see Rec7 in subscription.md — deliver `access_valid_until` as a server-signed token with a short TTL.

### 30.3 Half A — client gates writes locally (works fully offline)
On **every sale / write attempt**, evaluate with **server-aligned** time:
```
now = Date.now() + server_time_offset_ms
canSellNow =
  status in (active, trialing, free)         ? ALLOW
  : (access_valid_until && now < access_valid_until) ? ALLOW   // still in period/grace
  : BLOCK                                                       // lapsed
```
- **ALLOW** → record the sale; stamp `client_modified_at = now`; queue for sync.
- **BLOCK** → block the new sale locally, show "Subscription expired — renew to keep selling."
  The store is **read-only** (reads/history/reports still work). **Do not queue new sales.**
- A sale already **in progress** when the boundary passes is allowed to **complete** (it started
  before `access_valid_until`); the **next** one is blocked.

This is what stops indefinite free offline selling — the device enforces the cached window even
with no network.

### 30.4 Half B — server accepts in-flight offline sales (point-in-time entitlement)
On `POST /sync/delta`, for each sale mutation the server checks **entitlement at write time**, not
at sync time:
```
if (client_modified_at <= account.access_valid_until + CLOCK_SKEW)  → ACCEPT
else                                                                → REJECT 'SUBSCRIPTION_LAPSED_AT_WRITE'
```
- A sale rung up **before** access ended is accepted even if it syncs after expiry. ✅ (No lost sales.)
- A sale stamped **after** access ended is rejected (these shouldn't exist if Half A worked; the
  server is the backstop) → surfaced in the sync-conflict list for owner reconciliation.

> This mirrors the **point-in-time revocation grace** the sync engine already applies for RBAC
> (`client_modified_at` honored on `/sync/delta`) — same mechanism, applied to subscription.

### 30.5 Freshness — how the device learns `access_valid_until`
The device must keep `access_valid_until` reasonably current. Whenever **online**, refresh it from
(in priority order):
1. A **subscription version header** (`x-subscription-version`, from the main design-doc Phase 1/2
   freshness work) → on change, pull the subscription payload.
2. The existing **`X-Subscription-Warning: past_due:grace_until_…`** response header → parse
   `grace_until` directly.
3. The **snapshot subscription payload** (`current_period_end`, `trial_ends_at`) on bootstrap/refresh.

Every authenticated response is an opportunity to refresh, so even a brief reconnection updates the
window.

### 30.6 Timeline (worked)
```
Day 0  Renewal fails → account past_due, access_valid_until = period_end + 7d grace
       Device online at any point → caches access_valid_until
Day 0–7 (grace)  Cashier sells online or offline → ALLOW; sales sync & ACCEPT
Day 7  grace ends (now >= access_valid_until)
       Device (even offline) → BLOCK new sales, read-only, "Renew" banner
       Any pre-day-7 sales still queued → sync later → ACCEPTED (client_modified_at < day7)
       Any accidental post-day-7 sale → REJECTED 'SUBSCRIPTION_LAPSED_AT_WRITE'
Renew  Owner pays (any device) → access_valid_until extended
       This device unblocks on its next online refresh
```

### 30.7 Edge cases
| Case | Behaviour |
|---|---|
| Device offline the **entire** grace (never learned of past_due) | Uses last-known `access_valid_until` (= `current_period_end`). Blocks after the paid period — slightly stricter, which is **safe** (fail toward blocking); pre-period-end sales still accepted on sync. |
| Owner renews while this device is offline | Device stays blocked until it next syncs and learns the new `access_valid_until`; unblocks on reconnect. Acceptable brief lag. |
| Device clock changed to cheat the window | `server_time_offset_ms` aligns `now` to server time; **and** the server re-checks at sync → tampering only delays, never bypasses. |
| Multiple devices, account lapses | Each device enforces against its own cached window; server accepts/rejects per `client_modified_at`. Consistent across devices. |
| Reads after lapse | **Always allowed** — history, reports, exports. Never block reads. |

### 30.8 Dependencies
- **Server:** add `access_valid_until` to the subscription payload; enforce point-in-time
  entitlement on `/sync/delta` (the `SUBSCRIPTION_LAPSED_AT_WRITE` reject); emit a subscription
  freshness signal (version header) — see main design doc §11 Phase 1/2.
- **Client:** cache `subscriptionGuard`; gate every write through `canSellNow`; refresh on every
  online response; surface rejected sales in the conflict/reconciliation list.

### 30.9 Rule
**Write-gating is point-in-time, enforced on BOTH sides:** the client blocks new sales once the
cached window closes; the server accepts any sale stamped before the window closed. Together: **no
legitimate sale is ever lost, and a lapsed account cannot sell indefinitely offline.**
