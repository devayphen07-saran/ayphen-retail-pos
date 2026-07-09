# QA Test Cases — Devices Module (`apps/backend/src/devices/`)

**Agent:** Business-Analyst + QA (per `docs/agent/CLAUDE-ba-qa-testcases.md`)
**Mode:** QA (read from actual implementation) + BA (cross-checked against `docs/backend/device-management.md` PRD)
**Scope:** `apps/backend/src/devices/*` (`device-access.repository.ts`, `device-access.service.ts`,
`device-slot-expiry-cron.service.ts`, `device.mapper.ts`, `devices.module.ts`,
`my-device.controller.ts`, `store-device.controller.ts`) plus the code it composes with directly:
`auth/mobile/services/{auth-login,auth-signup,auth-logout,device.service}.ts`,
`auth/mobile/repositories/device.repository.ts`, `auth/mobile/guards/mobile-jwt.guard.ts`,
`sync/guards/device-slot.guard.ts`, `subscription/entitlement.service.ts`,
`subscription/reconciliation.service.ts`, `db/schema.ts` (`devices`, `deviceSessions`,
`storeDeviceAccess`, `syncInitProgress`).

---

## 1. Feature understanding (BA)

### What it does
The Devices module implements a **device↔store slot model** for a multi-tenant, offline-first
retail POS:

- **Device identity** (`devices` table) is created once per `(user, public-key-hash)` at login —
  not at an explicit "register device" call. One user can own many devices; there is **no cap on
  how many devices a user may register**.
- **Store access ("slot")** (`storeDeviceAccess` table) is a separate, plan-limited resource:
  a device only consumes a slot in a store the first time it *opens* that store
  (`POST /stores/:storeId/access`), not at login. The same physical device consumes **one
  independent slot per store** it accesses — a device open in 2 stores holds 2 slot rows, each
  counted against that store's own budget.
- **The limit** (`max_devices_per_store`, an `EntitlementService` lookup: `account → 
  account_subscription → plan_entitlements`) is enforced **per store**, never account-wide or
  user-wide. `NULL` = unlimited (Enterprise).
- **Slot lifecycle:** claimed (`insertSlot`) → heartbeated on every re-open (`touchSlot`, keeps
  `lastAccessedAt` fresh) → released by owner removal (`revokeSlot`/F5), device block (`revokeAllSlotsForDevice`/F8),
  logout (`revokeAllSlotsForDevice` with reason `'released'`), or the 30-day-idle cron
  (`expireStaleSlots`/F10).
- **Device-level actions** (`MyDeviceController`, own devices only): list all of a user's devices
  across all stores (`GET /devices/my`), block a lost/stolen device globally
  (`PATCH /devices/:id/block` — kills all sessions + all store slots + nulls push token),
  unblock a recovered device (`PATCH /devices/:id/unblock` — device usable again but *all* slots
  and sessions stay revoked; "fresh" re-registration required per store).
- **Store-level actions** (`StoreDeviceController`, owner/manager only): list devices that have
  touched this store (`GET /stores/:storeId/devices`), remove one from the store
  (`DELETE /stores/:storeId/devices/:deviceId` — revokes the slot + kills that device's live
  sessions/JWTs; owner cannot remove their own current device).
- **`StoreAccessController.open`** (`POST /stores/:storeId/access`) is the slot-claim endpoint: any
  store member may call it (no CRUD permission — the gate is the device *count*, not a role check).
- **`DeviceSlotGuard`** (in the sync module, not this one, but load-bearing for this module's
  purpose) enforces that every `/stores/:storeId/sync/*` call (pull, push, changes, conflicts) has
  an active slot — closing the loophole where a client could bypass the paid device-limit feature
  by never calling `/access` and syncing anyway.
- **`DeviceSlotExpiryCronService`** runs a configurable cron (`CRON_DEVICE_AUTO_EXPIRY`), batches
  of 500, expiring any `active` slot whose `lastAccessedAt` is >30 days old.

### Actors
- **Owner** — full control: remove devices from their store(s), view the store device list, block/
  unblock/list their own devices.
- **Manager** — view-only on the store device list (per RBAC matrix in PRD §23; see Open Question
  OQ-1 on whether this is actually wired for a default custom role).
- **Cashier / other staff** — cannot see or manage the store device list; can fully manage (view,
  block, unblock) their own devices via `/devices/my`.
- **System (cron)** — auto-expiry.
- **Reconciliation flow** (`subscription/reconciliation.service.ts`) — a special actor that
  revokes/restores slots by slot-id directly when a plan downgrade puts a store over its new
  device limit.

### Inputs / Outputs
| Endpoint | Method | Actor | Key input | Key output |
|---|---|---|---|---|
| `/stores/:storeId/access` | POST | any store member | none (device from JWT) | `{access:'granted', isNew}` or `403 DEVICE_LIMIT_REACHED {limit, active, devices[]}` |
| `/stores/:storeId/devices` | GET | Device:view (owner/manager) | — | list of `StoreDeviceResponse` |
| `/stores/:storeId/devices/:deviceId` | DELETE | Device:delete (owner) | deviceId | 204, or `403 CANNOT_REMOVE_CURRENT_DEVICE` / `404 DEVICE_SLOT_NOT_FOUND` |
| `/devices/my` | GET | any authenticated user | — | list of `MyDeviceResponse` |
| `/devices/:deviceId/block` | PATCH | owner of the device identity | deviceId | 204, or `404 DEVICE_NOT_FOUND` |
| `/devices/:deviceId/unblock` | PATCH | owner of the device identity | deviceId | 204, or `404 DEVICE_NOT_FOUND` |

### Business rules / invariants extracted from code (cross-referenced to PRD BR-DEV-xxx)
- **BR-DEV-002** Registration (login) never consumes a slot; only `/access` does. ✅ confirmed —
  `AuthLoginService`/`AuthSignupService` call `DeviceService.upsertDevice` + create a
  `deviceSessions` row only; no `storeDeviceAccess` write.
- **BR-DEV-003** Active = `storeDeviceAccess.status='active'`; every count/list query filters on it.
- **BR-DEV-004** `lastAccessedAt` refreshed on every re-claim (`touchSlot`).
- **BR-DEV-005** Self-lockout prevention — `removeDevice` throws `CANNOT_REMOVE_CURRENT_DEVICE`
  (403) if `targetDeviceId === currentDeviceId`, checked **before** any DB write.
- **BR-DEV-006** Removing a device does not touch `users`/store membership — only
  `storeDeviceAccess` + `deviceSessions` rows are mutated.
- **BR-DEV-007/008** Blocking sets `devices.isBlocked=true`, revokes every `deviceSessions` row for
  that device, revokes every active slot in every store (`revokeAllSlotsForDevice`), and
  blacklists/evicts every live JWT (`revokeLiveTokens`, best-effort/post-commit).
- **BR-DEV-009** 30-day cron, `STALE_DAYS = 30`, batch size 500, EvalPlanQual-safe against a
  concurrent `touchSlot`.
- **BR-DEV-010** `limit === null` ⇒ `EntitlementService.canCreate` always returns `true`.
- **BR-DEV-013** Re-login with the same `(userFk, publicKeyHash)` returns the *same* `devices` row
  (`findByUserAndKeyHash`), never a duplicate — enforced additionally by the DB unique index
  `devices_user_key_hash_uq`.
- **BR-DEV-014** Push token nulled on block (`setBlocked`); **not** restored automatically on
  unblock (schema/repo never re-sets it — client must re-register push on next login/foreground).
- **BR-DEV-015** Downgrade never auto-removes; `restoreDowngradedSlots`/`restoreSlot` only ever
  *re-activate*, never revoke on their own (revocation on downgrade is driven separately, by
  `ReconciliationService.apply`/`revokeSlotById`).
- **BR-DEV-018** Slot-claim atomicity — `lockStore` (SELECT...FOR UPDATE) + recount inside the same
  transaction + `uk_sda_active` partial unique index as the hard backstop; a unique-violation on
  insert is treated as a successful idempotent re-claim (`unwrapPgError(err)?.code === '23505'`).
- **BR-DEV-021/022** Slot-as-lease: claim/heartbeat/TTL all present; **owner instant reclaim** is
  achievable (the 403 payload lists holders; the owner can `DELETE` any of them by id) but there is
  **no dedicated "release this device" one-tap endpoint** distinct from the existing remove-device
  endpoint, and the **automatic 72h contended-slot soft-reclaim (F10B.3.2) is not implemented** —
  see Open Questions.

### State machine — `storeDeviceAccess.status`
```
                 ┌────────────────────────────────────────────┐
                 │                                            │
   (no row) ──insertSlot──▶ active ──touchSlot──▶ active (self-loop, heartbeat)
                              │  │  │
              revokeSlot(owner)│  │revokeAllSlotsForDevice(block/logout)
                              │  │  │
                              ▼  ▼  ▼
                            revoked ◀── revokeSlotById (reconciliation downgrade)
                              │
                       restoreSlot / restoreDowngradedSlots
                              │  (only if reason='plan_downgrade' AND no fresher active row exists)
                              ▼
                            active

   active ──expireStaleSlots (30d idle, cron)──▶ expired
   expired ── (no restore path in code — a fresh /access call inserts a brand-new row) ──▶ active (new row, isNew=true)
```
`revoked` and `expired` are both terminal for that *row*; a device regaining access always either
(a) is explicitly restored (`restoreSlot`, downgrade-reversal path only) or (b) gets a **new**
`storeDeviceAccess` row via `claimSlot`. `devices.isBlocked` is an orthogonal boolean gate
(`true`/`false`) that is enforced at auth time (`MobileJwtGuard`/login), not in this state machine.

### Assumptions / ambiguities flagged (see §7 Open Questions for full detail)
1. Whether "Manager" as actually seeded has `Device:view` (PRD §23 says yes; `DEFAULT_ROLE_CRUD`
   doesn't include `Device` at all, so it depends on explicit grants at role-seed time — not
   verifiable from this module alone).
2. PRD F13 says `sync_init_progress` is deleted on remove/block/expire (BR-DEV-017); the code has a
   `SyncInitProgressRepository.reset()` method but it is **never called** from any device-lifecycle
   path in this module or the auth flows reviewed — only from the client-driven `reset=true` query
   param on `/sync/initial`.
3. PRD F4/F7 describe a device-label rename affordance (`PATCH device_label`, max 100 chars); no
   such endpoint exists anywhere in the codebase, despite `Device: edit` being granted in
   `STORE_OWNER_CRUD` and `deviceLabel` being read (always `null`) in every response.
4. PRD F12 describes `PATCH /devices/:guuid/push-token`; no such endpoint exists — push token is
   only ever set at login (`upsertDevice`) or nulled at block (`setBlocked`).
5. `DEVICE_REVOKED` is a defined error code (PRD F6: "next call → 403 DEVICE_REVOKED") but is never
   thrown anywhere in the codebase — a revoked slot and a never-claimed slot both surface as the
   same `403 DEVICE_SLOT_REQUIRED` from `DeviceSlotGuard`, so a client cannot distinguish "you were
   removed" from "you never opened this store" from the error code alone.

---

## 2. Coverage plan

| Dimension | Applies? | Approx. cases |
|---|---|---|
| Happy paths | Yes | 10 |
| Business rules (satisfied + violated) | Yes | 22 |
| Boundaries | Yes | 10 |
| Negative / invalid | Yes | 12 |
| Failure & recovery | Yes | 10 |
| Concurrency | Yes | 9 |
| Permissions / roles | Yes | 10 |
| State transitions | Yes | 11 |
| Cross-cutting (offline/sync, tenancy, time) | Yes | 12 |
| UX/experience | Partial (backend-only module; UX cases expressed as API-contract behaviors the client state depends on) | 5 |
| Edge-case checklist (§5 dedicated section) | Yes | 16 |
| **Total** | | **~127** |

---

## 3. Test cases

### 3.1 Happy paths (HP)

**DEV-HP-01 / First store access claims a new slot**
Area: happy · Criticality: High · Traces to: F2, BR-DEV-002
Preconditions: Store "Sharma Kirana" on Basic plan (`max_devices_per_store=3`); 0 active slots; user Ramesh (Owner) logged in on Samsung Galaxy M34 (no prior slot in this store).
Input: `POST /stores/{storeId}/access`, empty body.
Steps: 1) Call the endpoint as Ramesh/Galaxy.
Expected result: `200 {access:'granted', isNew:true}`; one new `storeDeviceAccess` row `status='active', firstAccessedAt=lastAccessedAt=now`; active slot count 0→1.
Notes: verify server-side row, not just the wire response.

**DEV-HP-02 / Re-opening a store with an already-active slot is a heartbeat, not a new claim**
Area: happy · Criticality: High · Traces to: F2, BR-DEV-004
Preconditions: Ramesh/Galaxy already holds an active slot in the store (from DEV-HP-01), `lastAccessedAt` = 2 days ago.
Input: `POST /stores/{storeId}/access`.
Expected result: `200 {access:'granted', isNew:false}`; same row id; `lastAccessedAt` updated to now; active count unchanged (1); no new row inserted.

**DEV-HP-03 / Owner lists store devices**
Area: happy · Criticality: Medium · Traces to: F4
Preconditions: Store has 2 active slots (Ramesh/Galaxy, Priya/iPhone 13) and 1 revoked (Raju/Redmi, `owner_removed`, 10 days ago).
Input: `GET /stores/{storeId}/devices` as Ramesh (Owner, `Device:view`).
Expected result: `200`, array of 3 rows including the revoked one, each with `is_current` correctly flagged only for Ramesh's own `deviceFk`, ordered by `lastAccessedAt` desc.

**DEV-HP-04 / Owner removes a device from the store**
Area: happy · Criticality: Critical · Traces to: F5, BR-DEV-005/006
Preconditions: Priya's iPhone 13 holds an active slot; Priya has a live `deviceSessions` row with `currentJti` set.
Input: `DELETE /stores/{storeId}/devices/{iphoneDeviceId}` as Ramesh (Owner).
Expected result: `204`; slot row → `status='revoked', revokedReason='owner_removed', revokedBy=Ramesh`; Priya's `deviceSessions` row(s) revoked (`revoked_reason='store_device_removed'`); her live JWT blacklisted (post-commit, best-effort) so her very next authenticated call to *any* endpoint gets `401` immediately, not just this store; audit row `DEVICE_REMOVED` written in the same transaction; Priya's account/user membership in the store untouched.

**DEV-HP-05 / My Devices shows all of a user's devices across stores**
Area: happy · Criticality: Medium · Traces to: F7
Preconditions: Ramesh owns 2 devices (Galaxy — active slots in Sharma Kirana + Kumar Traders; iPad Air — active slot only in Sharma Kirana).
Input: `GET /devices/my` as Ramesh.
Expected result: `200`, 2 rows; Galaxy's `store_ids` contains both store ids; iPad's contains only Sharma Kirana's id; `is_current` true only for the device tied to the calling session.

**DEV-HP-06 / Block a stolen device (global kill)**
Area: happy · Criticality: Critical · Traces to: F8, BR-DEV-007/008/014
Preconditions: Redmi Note 12 (Ramesh's) holds active slots in 2 stores and 1 live session.
Input: `PATCH /devices/{redmiId}/block` as Ramesh (owner of that device identity).
Expected result: `204`; `devices.isBlocked=true, isTrusted=false, blockedAt=now, pushToken=null`; both `storeDeviceAccess` rows → `revoked/'stolen'`; all `deviceSessions` for the device revoked (`'device_blocked_stolen'`); live JWT(s) blacklisted; subsequent `POST /stores/*/access` or any authenticated call from that device fails (device blocked at `MobileJwtGuard`).

**DEV-HP-07 / Unblock a recovered device**
Area: happy · Criticality: High · Traces to: F9
Preconditions: Redmi Note 12 is blocked (from DEV-HP-06).
Input: `PATCH /devices/{redmiId}/unblock` as Ramesh.
Expected result: `204`; `devices.isBlocked=false`; **sessions and slots remain revoked** — the device must log in again and re-claim slots in each store; audit `DEVICE_UNBLOCKED` best-effort logged (does not fail the unblock if audit write fails).

**DEV-HP-08 / Unlimited plan (Enterprise) never blocks new slots**
Area: happy · Criticality: Medium · Traces to: F2, BR-DEV-010
Preconditions: Store's account is on Enterprise (`max_devices_per_store=NULL`); 40 active slots already exist.
Input: `POST /stores/{storeId}/access` from device #41 (never accessed this store).
Expected result: `200 {access:'granted', isNew:true}` — `entitlements.get` returns `null`; `canCreate(null, 40)` short-circuits `true` without even reading `active` count meaningfully.

**DEV-HP-09 / Login re-registers an existing device (key pair survived reinstall)**
Area: happy · Criticality: High · Traces to: F1/F11, BR-DEV-002/013
Preconditions: Priya reinstalls the app; Keychain key pair survived; same `publicKey` sent.
Input: Login stage-2 with `device.publicKey` matching the stored hash for `(Priya, iPhone13-key)`.
Expected result: `DeviceService.upsertDevice` finds the existing row by `(userFk, publicKeyHash)`; updates `lastSeenAt/appVersion/osVersion/lastIp/pushToken` only; **no new `devices` row**, **no new `storeDeviceAccess` row** — any store slots she held remain exactly as before (untouched by login).

**DEV-HP-10 / 30-day auto-expiry cron frees an idle slot**
Area: happy · Criticality: High · Traces to: F10, BR-DEV-009
Preconditions: A slot's `lastAccessedAt` is 31 days old, `status='active'`.
Input: `DeviceSlotExpiryCronService.expireStaleSlots()` fires on schedule.
Expected result: Row → `status='expired', revokedReason='auto_expired', revokedAt=now`; `stats.lastExpiredCount` increments; device itself is untouched (`isBlocked` stays false — user can still log in); a subsequent `/access` call from that device creates a **new** active row if the store has room.

---

### 3.2 Business-rule cases (BR) — each satisfied + violated

**DEV-BR-01a (satisfied) / Registration never consumes a slot**
Area: rule · Criticality: High · Traces to: BR-DEV-002
Steps: Fresh signup (stage-2) for a brand-new user/device on a store they haven't opened yet.
Expected: `devices` + `deviceSessions` rows created; **zero** `storeDeviceAccess` rows exist for that device anywhere.

**DEV-BR-01b (violated attempt) / Claiming a slot without a prior device identity is impossible by construction**
Area: rule · Criticality: Low · Traces to: BR-DEV-002
Notes: `StoreAccessController.open` reads `user.deviceId` from the authenticated JWT — there is no code path to call `/access` before a device row exists, since `MobileJwtGuard` requires a valid session bound to a device. Documents the invariant rather than a runnable negative case.

**DEV-BR-02a (satisfied) / Active count excludes revoked/expired**
Area: rule · Criticality: Critical · Traces to: BR-DEV-003
Preconditions: Store has 3 revoked/expired rows and 2 active, plan limit 3.
Steps: A new device calls `/access`.
Expected: `countActiveSlots` returns 2 (not 5); claim succeeds (2 < 3), new row `isNew:true`.

**DEV-BR-02b (violated) / A revoked device re-attempting silently succeeds if room exists, not "revoked forever"**
Area: rule · Criticality: High · Traces to: validation-matrix row "revoked here but slot free"
Preconditions: Raju's device was `owner_removed` 2 days ago; store now has room (2/3).
Steps: Raju's device calls `/access` again.
Expected: A **brand-new** row is created (`isNew:true`) — his old revoked row is left untouched, not resurrected; this is silent (no special "welcome back" signal) per the PRD validation matrix.

**DEV-BR-03 (satisfied+violated) / `lastAccessedAt` heartbeat vs. staleness**
Area: rule · Criticality: High · Traces to: BR-DEV-004
Steps: (a) Claim a slot, wait, re-claim → `lastAccessedAt` advances (satisfied). (b) Claim a slot, never re-open it for 30 days → cron expires it (violated the "stay fresh" implicit rule → row moves to `expired`).

**DEV-BR-04a (satisfied) / Cannot remove own current device**
Area: rule · Criticality: Critical · Traces to: BR-DEV-005
Steps: Ramesh, authenticated on Galaxy, calls `DELETE /stores/{id}/devices/{galaxyDeviceId}` (his own current device).
Expected: `403 CANNOT_REMOVE_CURRENT_DEVICE`; no DB mutation at all (check thrown before any repo call).

**DEV-BR-04b (violated correctly blocked) / Owner removes a *different* device, then that device tries to remove itself back**
Area: rule · Criticality: Medium
Steps: Ramesh removes Priya's iPhone from Store A. Priya's iPhone (now slot-less in Store A, but she is still logged in with a live session until it's revoked) calls the remove endpoint targeting itself.
Expected: Her session is already revoked from DEV-HP-04, so this fails at `MobileJwtGuard` (`401 SESSION_REVOKED`) before ever reaching the self-lockout check — confirms defense-in-depth ordering.

**DEV-BR-05 (satisfied) / Removing a device does not remove store membership**
Area: rule · Criticality: Critical · Traces to: BR-DEV-006
Steps: Remove Priya's device from Store A; then check `user_role_mapping`/membership for Priya in Store A.
Expected: Membership row untouched; Priya can still be assigned shifts / seen in staff list; she can regain store access by opening the store again on a *different or newly-registered* device (if a slot is free).

**DEV-BR-06a (satisfied) / Block revokes ALL sessions + ALL store slots**
Area: rule · Criticality: Critical · Traces to: BR-DEV-007/008
Preconditions: Redmi has active slots in Store A and Store B, and 2 live `deviceSessions` (one per recent login).
Steps: `PATCH /devices/{redmiId}/block`.
Expected: Both slots revoked (`reason='stolen'`), both sessions revoked, both live JWTs blacklisted — single transaction, single audit event with `storesAffected` context implied by the revoked rows.

**DEV-BR-06b (violated / non-owner tries to block)**
Area: rule · Criticality: Critical · Traces to: BR-DEV-007
Steps: Kumar (Manager, different user) calls `PATCH /devices/{redmiId}/block` where Redmi belongs to Ramesh.
Expected: `findOwnedDevice(redmiId, kumar.userId)` returns null → `404 DEVICE_NOT_FOUND` (not 403 — deliberately doesn't leak that the device exists under someone else's account).

**DEV-BR-07 (satisfied+violated) / 30-day cron boundary**
Area: rule · Criticality: High · Traces to: BR-DEV-009
Steps: (a) Slot idle 29 days 23 hours → NOT expired (satisfied: still active). (b) Slot idle 30 days + 1 minute → expired (violated the freshness window, correctly reaped). See DEV-BD-06/07 for exact boundary cases.

**DEV-BR-08 (satisfied) / `max_devices_per_store=NULL` bypasses all counting**
Area: rule · Criticality: Medium · Traces to: BR-DEV-010
Covered by DEV-HP-08.

**DEV-BR-09a (satisfied) / Same key-hash always maps to the same device row**
Area: rule · Criticality: High · Traces to: BR-DEV-013
Covered by DEV-HP-09.

**DEV-BR-09b (violated attempt, correctly blocked) / DB unique index prevents a duplicate `(userFk, publicKeyHash)` row even under a race**
Area: rule · Criticality: High · Traces to: BR-DEV-013, `devices_user_key_hash_uq`
Steps: Two concurrent login requests for the same user+device fire `upsertDevice` before either commits (both see "no existing row").
Expected: One insert wins; the other hits the unique constraint. Notes: **gap** — `DeviceRepository.insert`/`upsertDevice` has no catch for a `23505` unique violation the way `device-access.service.ts`'s `claimSlot` does; verify whether the caller (`AuthLoginService`/`AuthSignupService`'s `uow.execute`) surfaces a raw 500 on this race instead of gracefully re-reading the winning row. **Recommend a dedicated test to confirm actual behavior — flagged as an open question (OQ-6).**

**DEV-BR-10 (satisfied) / Push token nulled on block, not restored on unblock**
Area: rule · Criticality: Medium · Traces to: BR-DEV-014
Steps: Device has `pushToken='ExponentPushToken[abc]'`; block it → `pushToken=null`; unblock it → `pushToken` still `null` (only a fresh login/foreground push-registration call would repopulate it, and no such endpoint exists in this module — see OQ-4).

**DEV-BR-11 (satisfied) / Downgrade never auto-revokes from this module's own code**
Area: rule · Criticality: High · Traces to: BR-DEV-015
Steps: Call `DeviceAccessRepository.restoreDowngradedSlots`/`restoreSlot` directly with no prior revoke.
Expected: No-ops gracefully (nothing to restore); confirms this module contains no revocation trigger tied to plan value changes — that decision lives entirely in `ReconciliationService`, which calls `revokeSlotById` explicitly, only when the owner submits a resolution.

**DEV-BR-12a (satisfied) / Atomic slot claim under the last-slot race**
Area: rule · Criticality: Critical · Traces to: BR-DEV-018
Steps: Store at 2/3 (Basic plan); two different never-before-seen devices call `/access` at the same instant.
Expected: Exactly one gets `{granted, isNew:true}`; the other either (a) is serialized behind `lockStore`'s row lock and correctly sees `active=3` on recount → `403 DEVICE_LIMIT_REACHED`, or (b) if it raced past the recount somehow, its insert hits `uk_sda_active`/unique violation and is caught, returning `{granted, isNew:false}` as an idempotent re-claim — **this second path is a latent correctness question: two *different* devices should never both get "granted" for the last slot. Investigate — see OQ-7.**

**DEV-BR-12b (satisfied) / A device's own retry never double-blocks itself**
Area: rule · Criticality: High · Traces to: BR-DEV-018 (own-device race comment in code)
Steps: Store at exactly its limit already excluding this device; this same device's client double-sends `/access` (timeout + retry) concurrently.
Expected: Both requests resolve `granted` — the second, slower one hits the in-transaction `findActiveSlot` re-check (`raced`) and returns `isNew:false` via `touchSlot`, never evaluated against the limit at all.

**DEV-BR-13 (satisfied) / Sync surface is gated on having an active slot (billing-invariant enforcement)**
Area: rule · Criticality: Critical · Traces to: `DeviceSlotGuard` doc-comment ("client is never trusted to self-enforce a billing invariant")
Steps: A device with no `storeDeviceAccess` row (never called `/access`) calls `POST /stores/{id}/sync/delta` directly.
Expected: `403 DEVICE_SLOT_REQUIRED` from `DeviceSlotGuard`, before `PermissionsGuard`/`SubscriptionStatusGuard` or the sync engine itself run.

**DEV-BR-14 (violated, correctly blocked) / Cashier cannot list or remove store devices**
Area: rule · Criticality: Critical · Traces to: PRD §23 RBAC matrix
Steps: Priya (Cashier) calls `GET /stores/{id}/devices` and `DELETE /stores/{id}/devices/{x}`.
Expected: Both blocked by `PermissionsGuard` (`Device:view`/`Device:delete` not granted to Cashier) — `403`.

---

### 3.3 Boundary cases (BD)

**DEV-BD-01 / Exactly at limit − 1 (limit-1 = allowed)**
Area: boundary · Criticality: High · Traces to: F2/F3
Preconditions: Basic plan, limit 3, 2 active slots.
Steps: 3rd never-before-seen device calls `/access`.
Expected: `{granted, isNew:true}`; active count becomes 3.

**DEV-BD-02 / Exactly at limit (limit = blocked for a new device)**
Area: boundary · Criticality: Critical · Traces to: F2/F3, BR-DEV-003
Preconditions: 3 active slots, limit 3.
Steps: 4th never-before-seen device calls `/access`.
Expected: `403 DEVICE_LIMIT_REACHED {limit:3, active:3, devices:[3 holders]}`.

**DEV-BD-03 / limit + 1 is unreachable via normal claim, but pre-existing over-limit rows keep working (downgrade scenario)**
Area: boundary · Criticality: High · Traces to: F14/BR-DEV-015
Preconditions: Account was Professional (limit 10) with 7 active slots in a store; downgraded to Basic (limit 3).
Steps: An already-active device (one of the 7) re-opens the store.
Expected: `touchSlot` heartbeat path — `existing` slot found *before* any limit check runs, so it's `{granted, isNew:false}` regardless of being 7 > 3. A brand-new 8th device is blocked (`403 DEVICE_LIMIT_REACHED {limit:3, active:7,...}`).

**DEV-BD-04 / Zero active slots in a brand-new store**
Area: boundary · Criticality: Medium · Traces to: F2
Steps: First-ever `/access` call for a freshly created store.
Expected: `countActiveSlots` = 0; `0 < limit` always true (any plan) → granted, `isNew:true`.

**DEV-BD-05 / Free plan, limit = 1 — single-slot store**
Area: boundary · Criticality: High · Traces to: F2, PRD §5 plan table
Steps: Owner's phone claims the only slot; a 2nd device (even the owner's own tablet, different key) tries to claim.
Expected: 2nd device → `403 DEVICE_LIMIT_REACHED {limit:1, active:1, devices:[owner's phone]}`.

**DEV-BD-06 / Cron boundary — 29 days 23h59m idle**
Area: boundary · Criticality: High · Traces to: BR-DEV-009
Steps: Set `lastAccessedAt = now - (30*24*60*60*1000 - 60000)` ms; run cron.
Expected: Row NOT selected (`lt(lastAccessedAt, staleBefore)` where `staleBefore = now - 30d`) — stays active.

**DEV-BD-07 / Cron boundary — exactly 30 days + 1ms idle**
Area: boundary · Criticality: High · Traces to: BR-DEV-009
Steps: Set `lastAccessedAt` to exactly `staleBefore - 1ms`; run cron.
Expected: Row IS selected and expired (strict `<` comparison, so equality to `staleBefore` itself is NOT expired — only strictly older; verify the exact-equals-`staleBefore` instant is excluded).

**DEV-BD-08 / Cron batch-size boundary (exactly 500 stale rows)**
Area: boundary · Criticality: Medium · Traces to: `BATCH_SIZE=500`, cron loop
Steps: Exactly 500 stale rows exist; run the cron.
Expected: One batch returns exactly 500 rows (`batch.length === BATCH_SIZE`), so the loop runs a **second** iteration (since the break condition is `batch.length < BATCH_SIZE`), which then returns 0 — total expired = 500, 2 DB round trips, no infinite loop, no double-processing (second batch's predicate re-evaluates and finds nothing left).

**DEV-BD-09 / Device label field is always null (no write path exists)**
Area: boundary · Criticality: Low · Traces to: F4 sub-rule, OQ-3
Steps: Inspect any `StoreDeviceResponse.label` in any listing.
Expected: Always `null` for every row in the current implementation — there is no endpoint that ever sets `deviceLabel`, so testing "max 100 chars" validation (PRD §25) is currently **not applicable/blocked** until that endpoint ships.

**DEV-BD-10 / `deviceIds` batched query with an empty array**
Area: boundary · Criticality: Low · Traces to: `activeStoresForDevices`, `listStoreDevicesByStores`, `countActiveSlotsByStores`
Steps: Call `listMyDevices` for a user with zero registered devices (`devices.length === 0`).
Expected: `activeStoresForDevices([])` short-circuits and returns an empty `Map` without querying the DB (guarded by `if (deviceIds.length === 0) return ...`); `listMyDevices` returns `[]`, not an error.

---

### 3.4 Negative / invalid cases (NG)

**DEV-NG-01 / Malformed device id (not a UUID)**
Area: negative · Criticality: Medium
Steps: `DELETE /stores/{storeId}/devices/not-a-uuid`.
Expected: `400` from `ParseUUIDPipe`, before the handler runs.

**DEV-NG-02 / Remove a device that never had a slot in this store**
Area: negative · Criticality: High · Traces to: F5
Steps: Owner calls remove for a `deviceId` that is a real device (belongs to some user) but has never opened this specific store.
Expected: `revokeSlot` affects 0 rows → `404 DEVICE_SLOT_NOT_FOUND`. No audit row written (the `if (n>0)` guard around the audit call).

**DEV-NG-03 / Remove a device already revoked (double-remove)**
Area: negative · Criticality: Medium · Traces to: idempotency of destructive actions
Steps: Remove Priya's iPhone (succeeds); call remove again for the same `(storeId, deviceId)`.
Expected: Second call finds no `active` row to match → `404 DEVICE_SLOT_NOT_FOUND` (not a silent 204) — confirms remove is not naturally idempotent at the HTTP layer, unlike the slot *claim* path.

**DEV-NG-04 / Block a device that doesn't belong to the caller**
Area: negative · Criticality: Critical · Traces to: BR-DEV-06b (ownership check)
Covered by DEV-BR-06b.

**DEV-NG-05 / Block an unknown/nonexistent device id**
Area: negative · Criticality: Medium
Steps: `PATCH /devices/{randomUuid}/block` for a UUID that matches no `devices` row at all.
Expected: `404 DEVICE_NOT_FOUND`.

**DEV-NG-06 / Unblock a device that isn't blocked**
Area: negative · Criticality: Low · Traces to: PRD validation matrix "Block already-blocked"
Steps: Call unblock on a device with `isBlocked=false` already.
Expected: `setBlocked(id, false)` is a no-op `UPDATE` (idempotent) → `204` regardless; no error surfaced, no audit-worthy state change really occurred (the audit log is still best-effort-written every call regardless of prior state — verify this is acceptable/expected, not a bug).

**DEV-NG-07 / Claim a slot for a store the account doesn't own / cross-tenant store id**
Area: negative · Criticality: Critical · Traces to: tenancy
Steps: User authenticated for Account A calls `/access` with a `storeId` belonging to Account B (not a member at all).
Expected: Blocked upstream by `TenantGuard` before reaching `DeviceAccessService.claimSlot` — `403`/`404` per `TenantGuard`'s own contract (not this module's concern directly, but must be verified end-to-end since `claimSlot` itself does **not** re-validate that `userId` is a member of `storeId`).

**DEV-NG-08 / Empty/whitespace `Authorization` header on any devices endpoint**
Area: negative · Criticality: Critical
Steps: Call `GET /devices/my` with no Bearer token.
Expected: `401 MISSING_TOKEN` from `MobileJwtGuard`, before any device logic runs.

**DEV-NG-09 / List store devices as a store member with zero device-related permission grants**
Area: negative · Criticality: High · Traces to: PRD §23
Steps: A custom-role staffer with `DEFAULT_ROLE_CRUD` (no `Device` entry at all, i.e. `NONE`) calls `GET /stores/{id}/devices`.
Expected: `403` — `RequirePermissions({entity:'Device', action:'view'})` fails since `Device` isn't in the seeded default grants (ties to OQ-1: even a "Manager" custom role needs an *explicit* grant, contradicting the PRD table's implication that Manager gets this for free).

**DEV-NG-10 / Injection-style input in device metadata at login**
Area: negative · Criticality: Medium
Steps: Login stage-2 with `device.model` / `device.osVersion` containing SQL-metacharacters or script tags (`<script>alert(1)</script>`, `'; DROP TABLE devices; --`).
Expected: Stored verbatim as opaque text via parameterized Drizzle queries (no injection); returned verbatim in `GET /devices/my`/`GET /stores/:id/devices` responses — confirm the **client** is expected to escape/sanitize on render (this API does not sanitize output), flag as a UI-layer responsibility, not a backend bug, but worth an explicit case since `model`/`label` are free-text fields surfaced in owner-facing lists.

**DEV-NG-11 / `publicKey` reused across two different users**
Area: negative · Criticality: Medium · Traces to: `devices_user_key_hash_uq` (scoped to `userFk + publicKeyHash`, not global)
Steps: Two different users happen to submit the same `publicKey` bytes (e.g., a broken client that doesn't generate per-install keys, or a shared/rooted-device key-export scenario).
Expected: Two separate `devices` rows are created (one per user) since the unique index is `(userFk, publicKeyHash)`, not `publicKeyHash` alone — this is allowed by design; confirms there is no cross-user device-identity collision detection/alerting for a scenario that could indicate key-material sharing (fraud signal) — note as a Low-priority gap only if the product cares about that signal.

**DEV-NG-12 / Attempt to claim `/access` with a request body**
Area: negative · Criticality: Low · Traces to: D6 (PRD) "empty body; device from auth context"
Steps: POST a body like `{"deviceId": "<some-other-device-id>"}` to `/stores/{id}/access`, attempting to claim a slot on behalf of a different device than the caller's own JWT-bound device.
Expected: Body is ignored entirely — `ctx`/`user.deviceId` from the authenticated principal is the only source of device identity (`open()` handler signature takes no `@Body()`); confirms this can't be used to claim a slot for an arbitrary device id.

---

### 3.5 Failure & recovery cases (FR)

**DEV-FR-01 / Blacklist/Redis failure during device block must not fail the block**
Area: failure · Criticality: Critical · Traces to: `revokeLiveTokens` doc-comment
Preconditions: Redis is down or `blacklist.addManyToBlacklist` throws.
Steps: `blockDevice` runs; the DB transaction (isBlocked, revoke sessions/slots, audit) commits; then `revokeLiveTokens` is called post-commit and its Redis call fails.
Expected: The overall `PATCH .../block` call still returns `204` (error is caught/logged, not rethrown); DB state fully reflects "blocked"; the *already-issued* access token for that device remains valid until its natural expiry instead of being immediately killed — an accepted, documented trade-off, but a real production risk window worth a monitoring alert (flag as operationally important, not a bug).

**DEV-FR-02 / Same Redis failure during `removeDevice`**
Area: failure · Criticality: High · Traces to: same `revokeLiveTokens` pattern
Expected: Identical shape — `DELETE .../devices/:id` still returns `204`; slot is revoked in DB; the removed cashier's live JWT keeps working until natural expiry if the post-commit blacklist step failed.

**DEV-FR-03 / Audit-log write fails inside `removeDevice`'s transaction**
Area: failure · Criticality: High · Traces to: `audit.logInTransaction` being IN the same tx as the slot revoke
Steps: Force `AuditService.logInTransaction` to throw (e.g., a constraint violation) during `removeDevice`.
Expected: **Whole transaction rolls back** — slot stays `active`, no sessions revoked, no partial state. (Contrast this deliberately with `unblockDevice`, DEV-FR-04, where audit is explicitly best-effort/non-transactional.)

**DEV-FR-04 / Audit-log write fails during `unblockDevice`**
Area: failure · Criticality: Medium · Traces to: explicit try/catch around `audit.log` in `unblockDevice`
Steps: Force the audit write to throw after `setBlocked(id, false)` has already committed.
Expected: The unblock still succeeds (`204`) — the exception is swallowed; confirms an intentional asymmetry vs. DEV-FR-03 (block/remove audit is transactional+atomic; unblock's is fire-and-forget) — worth calling out explicitly as a design inconsistency to confirm with product (OQ-8).

**DEV-FR-05 / Concurrent slot-claim retry after a network timeout (client-side double-send)**
Area: failure · Criticality: High · Traces to: BR-DEV-018 own-device race handling
Covered functionally by DEV-BR-12b; additionally verify: if the *first* request's transaction is still in-flight (not yet committed) when the retry's `findActiveSlot` (pre-lock) runs, the retry proceeds into `lockStore`, blocks until the first commits, then its own `raced` re-check finds the just-inserted row and returns `isNew:false` — no duplicate row, no spurious `DEVICE_LIMIT_REACHED` for the same device.

**DEV-FR-06 / Unique-violation race outside the expected pattern**
Area: failure · Criticality: Medium · Traces to: `catch` block in `claimSlot`
Steps: Simulate a `23505` unique violation on `insertSlot` that is NOT simply "another concurrent claim for the same (store,device)" — e.g. a corrupted/duplicate row from a data-migration bug.
Expected: Code currently treats **any** `23505` from this insert as "lost the race, already granted" and returns `{granted, isNew:false}` — it does not re-verify that an active row for *this exact* device now exists. If the unique violation came from an unrelated constraint on the same table, the caller would get a false "granted" without a real slot. Flag as a **low-probability but real robustness gap** (OQ-9).

**DEV-FR-07 / Cron crash mid-batch**
Area: failure · Criticality: Medium · Traces to: `expireStaleSlots` loop / batching
Steps: Force the 2nd batch's `uow.execute` to throw (e.g., DB connection drop) after batch 1 (500 rows) already committed.
Expected: `stats.error` is set, `stats.lastExpiredCount` reflects only the committed batches (500, not partial), `isRunning` reset to `false` in `finally` so the next scheduled tick can retry; **no double-expiry** of the same rows next run (each batch's predicate re-selects only currently-active+stale rows).

**DEV-FR-08 / Two cron instances (multi-node deploy) fire at the same time**
Area: failure · Criticality: High · Traces to: doc-comment "in-memory re-entrancy guard, NOT a distributed lock... harmless here"
Steps: Deploy 2 backend instances; both crons fire at `02:00` simultaneously; both start `expireStaleSlots` (in-memory `isRunning` guard only protects within a single process).
Expected: Some rows get updated by instance A, and instance B's `UPDATE ... WHERE status='active' AND lastAccessedAt < staleBefore` naturally becomes a no-op for those same rows (already `status='expired'`) — no double-audit-log, no error, no duplicate work beyond wasted queries; confirms the code comment's claim is accurate. **Contrast with the PRD's explicit call for a Redis distributed lock (§15 F10) — this is a documented, deliberate deviation; verify it's actually acceptable at current scale (OQ-10).**

**DEV-FR-09 / Best-effort session-cache invalidation fails silently**
Area: failure · Criticality: Medium · Traces to: `revokeLiveTokens` → `cacheInvalidator.invalidateMany`
Steps: `SessionCacheInvalidatorService.invalidateMany` throws for one or more session ids during a block/remove.
Expected: Caught by the same try/catch as the blacklist write; DB mutation already committed is not rolled back; a stale Redis session-cache entry could let `MobileJwtGuard`'s cached session lookup (30s TTL per its own doc) serve a technically-revoked session for up to that TTL window — acceptable per design, but confirms a **bounded** (not unbounded) exposure window worth asserting explicitly in a test (≤30s).

**DEV-FR-10 / Entitlement lookup fails / plan row missing entirely**
Area: failure · Criticality: High · Traces to: `EntitlementService.get` "missing row ⇒ 0, never unlimited"
Steps: Account's `account_subscriptions ⋈ plan_entitlements` join returns no row for `max_devices_per_store` (e.g., a seed gap / new plan tier missing an entitlement row).
Expected: `get()` returns `0`, not `null` — every claim attempt (even the very first) is blocked with `403 DEVICE_LIMIT_REACHED {limit:0, active:0, devices:[]}`. This is intentionally fail-closed (never silently grants unlimited on a seed gap) — verify this is the actually-desired behavior for a *first* device on a brand-new store, since it would mean an owner can never open their own new store if the plan's entitlement row is missing (Critical to test since it can hard-block onboarding).

---

### 3.6 Concurrency cases (CX)

**DEV-CX-01 / Two different devices race for the literal last slot**
Area: concurrency · Criticality: Critical · Traces to: BR-DEV-018
Covered by DEV-BR-12a — the case QA must run for real against Postgres (not just reason about), given the flagged ambiguity in the catch-all `23505` handling (OQ-7).

**DEV-CX-02 / Owner removes a device at the exact instant that device is mid-heartbeat**
Area: concurrency · Criticality: High
Steps: Thread A: `removeDevice` (revokeSlot, `WHERE status='active'`). Thread B: the same device's `/access` call is running `touchSlot` concurrently.
Expected: Whichever commits first wins; if revoke commits first, the concurrent `touchSlot` is a no-op UPDATE on a now-`revoked` row (matches nothing, since `touchSlot`'s `WHERE eq(id, existing.id)` doesn't re-check status — verify: does `touchSlot` accidentally "resurrect" freshness on a row that's about to be/was just revoked? Since `touchSlot` only sets `lastAccessedAt`/`modifiedAt`, not `status`, a revoked row could get a fresh `lastAccessedAt` with `status='revoked'` still — harmless for the active-count logic (still filtered out), but pollutes `revokedAt`-adjacent audit timestamps. Low-risk, but a real interleaving to test.

**DEV-CX-03 / Cron expiry races an in-flight heartbeat (EvalPlanQual re-validation)**
Area: concurrency · Criticality: High · Traces to: code comment on `expireStaleSlots`
Steps: A slot is selected as stale by the cron's inner SELECT; concurrently, the device calls `/access` and `touchSlot`s it (advancing `lastAccessedAt` to "now") before the outer UPDATE commits.
Expected: The outer UPDATE's repeated predicate (`lastAccessedAt < staleBefore`) is re-evaluated by Postgres against the now-fresh row and **excludes it** — the slot survives, not incorrectly expired underneath an active device. This is the single most important concurrency case in the whole module; must be verified with an actual interleaved-transaction test, not just code review.

**DEV-CX-04 / Block races a store-access claim for the same device**
Area: concurrency · Criticality: Critical
Steps: Thread A: owner blocks the device (`blockDevice`, revokes all slots + sessions). Thread B: the same device is mid-`claimSlot` for a *new* store it's opening for the first time.
Expected: If B's transaction commits after A's block already ran, the newly-inserted slot from B is now "active" on a blocked device — nothing in `claimSlot` checks `devices.isBlocked`. However, the device's session should already be dead (A revoked all sessions), so B's request should never have passed `MobileJwtGuard` to begin with *unless* B's JWT was accepted just before A's revoke committed (session-cache 30s TTL window). Net: a narrow race could let a just-blocked device claim one more slot in a store it had never opened, which then sits `active` until the next explicit action. **Flag as a real, if narrow, gap — `claimSlot` never re-checks `devices.isBlocked` itself; it relies entirely on the auth guard already having filtered blocked devices out (OQ-11).**

**DEV-CX-05 / Two owners (co-owner scenario) remove the same device simultaneously**
Area: concurrency · Criticality: Medium
Steps: Store has two users with `Device:delete` (e.g., Owner + a co-owner role); both call `DELETE .../devices/{x}` for the same device at the same time.
Expected: One succeeds (`n=1`, 204 + audit + session revoke); the other's `revokeSlot` affects 0 rows (already revoked) → `404 DEVICE_SLOT_NOT_FOUND` — no double-audit, no crash, no double session-revoke call issue (idempotent revoke-sessions would be a no-op the second time too, but it's never reached since `n===0` short-circuits `sessions=[]`).

**DEV-CX-06 / Reconciliation `restoreDowngradedSlots` races a fresh manual claim by the same device**
Area: concurrency · Criticality: High · Traces to: `restoreSlot`'s "already claimed" guard, doc-commented explicitly
Steps: A slot was revoked for `plan_downgrade`. Before the owner upgrades back, the same device independently re-opens the store and gets a **brand-new** active row (since a slot became free from someone else's expiry). Now the owner upgrades, triggering `restoreDowngradedSlots`.
Expected: `restoreSlot` checks `findActiveSlot` first and no-ops for that device (leaves the old revoked row alone) — does NOT attempt to flip the old row back to `active`, which would otherwise violate `uk_sda_active` (two active rows for the same `(store, device)`) or create a confusing duplicate-history situation.

**DEV-CX-07 / Concurrent `listActiveStoreDevices` read while `lockStore` holds the row lock**
Area: concurrency · Criticality: Medium · Traces to: comment on `listActiveStoreDevices` being bounded/SQL-filtered
Steps: Store is at its limit; a new claim is rejected and, while still inside the transaction holding `lockStore`'s lock, `listActiveStoreDevices` runs to build the 403 payload; meanwhile another read-only request (`GET /stores/:id/devices`, no lock) runs concurrently.
Expected: The read-only `listStoreDevices` (different method, not lock-scoped) is not blocked by `lockStore`'s row lock (different table/row) — verify no accidental lock contention/deadlock between the store-row lock and the plain SELECT-based device list endpoint.

**DEV-CX-08 / Double-tap "Remove" in the owner's UI**
Area: concurrency · Criticality: Medium · Traces to: UX double-submission
Steps: Owner double-taps `[Remove]`; client fires the DELETE twice in quick succession.
Expected: First call succeeds (204); second call's `revokeSlot` matches 0 active rows → `404 DEVICE_SLOT_NOT_FOUND` — client must treat a 404 on this specific action as "already removed, refresh the list" rather than a hard error toast (UX contract to confirm, see DEV-UX cases).

**DEV-CX-09 / Simultaneous block + unblock from two different sessions of the same user**
Area: concurrency · Criticality: Low
Steps: User is logged into two of their own OTHER devices simultaneously (call them Session-X, Session-Y); Session-X blocks Device-Z, Session-Y unblocks Device-Z, near-simultaneously.
Expected: Whichever commits last wins (`isBlocked` is a plain boolean overwrite, no optimistic-concurrency/version check on `devices` table for this field) — final state is a last-write-wins race with no conflict detection; acceptable for this low-stakes toggle, but worth documenting since e.g. a stolen-phone "block" could be immediately undone by a stale "unblock" retry racing in afterward — recommend confirming this is acceptable (OQ-12).

---

### 3.7 Permission / role cases (PM)

**DEV-PM-01 / Owner — full device management**
Area: permission · Criticality: Critical · Traces to: PRD §23
Steps: Owner performs list, remove, block-own, unblock-own.
Expected: All succeed per `STORE_OWNER_CRUD.Device = {view:true, create:false, edit:true, delete:true}` and the fact that block/unblock are ownership-gated (not role-gated) on `MyDeviceController`.

**DEV-PM-02 / Manager — view store devices, cannot remove**
Area: permission · Criticality: High · Traces to: PRD §23
Steps: Manager calls `GET /stores/:id/devices` (expect success **if** granted — see OQ-1) and `DELETE /stores/:id/devices/:id` (expect 403 regardless, since `STORE_OWNER_CRUD` isn't Manager's matrix and no default grant gives `delete`).
Expected: List either succeeds or fails consistently with whatever the Manager role's actual seeded grants are (must be verified against the live role-seed data, not just this module) — remove always `403`.

**DEV-PM-03 / Cashier — no visibility into store device list**
Area: permission · Criticality: Critical · Traces to: PRD §23 "Cashiers can't see the store device list — privacy/ops"
Covered by DEV-BR-14/DEV-NG-09.

**DEV-PM-04 / Any role — full self-service on own devices via `/devices/my`**
Area: permission · Criticality: High · Traces to: PRD §12 "any user (own)"
Steps: Cashier lists, blocks, unblocks their own devices.
Expected: All succeed — `MyDeviceController` has no `@RequirePermissions` at all, only `MobileJwtGuard` + `@StoreContext('none')`; ownership is the only gate (`findOwnedDevice`).

**DEV-PM-05 / User cannot block/unblock a device belonging to a different user in the same store**
Area: permission · Criticality: Critical
Covered by DEV-BR-06b/DEV-NG-04 — even an Owner cannot block a Cashier's personal phone; block/unblock is identity-owner-gated, not role-gated.

**DEV-PM-06 / Permission revoked mid-session (role change while device list is open)**
Area: permission · Criticality: Medium · Traces to: cross-cutting "permission removed mid-session"
Steps: Manager has the store device list open (already fetched); Owner revokes the Manager's `Device:view` grant mid-session; Manager pulls-to-refresh the list.
Expected: The *next* `GET /stores/:id/devices` call re-evaluates `PermissionsGuard` fresh (no client-side permission caching bypass) → `403` on the refresh, even though the stale list is still on-screen until then (a UX case, not a data-leak — no new data was fetched).

**DEV-PM-07 / A store's own owner is not automatically exempt from the device limit**
Area: permission · Criticality: Medium · Traces to: F2 "any store member" (no role bypass)
Steps: Store already at its device limit (all slots held by staff); the Owner's own new phone tries to claim a slot.
Expected: Owner is blocked with the same `403 DEVICE_LIMIT_REACHED` as anyone else — no special-cased bypass for the account owner in `claimSlot`. Confirms the limit is enforced identically regardless of caller role (matches PRD F3.1's implication that even the owner sees the limit screen, just with extra actions available).

**DEV-PM-08 / Reconciliation's slot revoke/restore bypasses normal `Device:delete` permission entirely**
Area: permission · Criticality: Medium · Traces to: `ReconciliationService`
Steps: The reconciliation "apply"/"swap" flow calls `revokeSlotById`/`restoreSlot` directly on the repository, not through `StoreDeviceController`.
Expected: These paths are gated by whatever permission `ReconciliationService`'s own controller requires (likely Subscription/owner-only), not `Device:delete` — confirms device-slot mutation has **two distinct authorization surfaces** (normal remove vs. reconciliation) that must each be independently tested; a bug in one does not imply safety in the other.

**DEV-PM-09 / `StoreContext('none')` on `MyDeviceController` — no store-scoping leak**
Area: permission · Criticality: High · Traces to: tenancy
Steps: A user who is a member of Store A only calls `GET /devices/my`.
Expected: Response includes devices/store-id lists correctly scoped to only stores where an *active* slot exists for that device — never surfaces another tenant's store ids even indirectly, since `activeStoresForDevices` filters by the caller's own `deviceIds` only (never cross-user).

**DEV-PM-10 / A blocked device's owner can still manage it via a different, non-blocked device**
Area: permission · Criticality: Medium · Traces to: F9 flow
Steps: Ramesh's Redmi is blocked; Ramesh logs in on his Galaxy (still trusted) and calls `PATCH /devices/{redmiId}/unblock`.
Expected: Succeeds — ownership (`findOwnedDevice(redmiId, ramesh.userId)`), not "is this the calling device," is the only check; a blocked device does not need to authenticate itself to be unblocked (which would be impossible by definition, since it can't auth while blocked).

---

### 3.8 State-transition cases (ST)

**DEV-ST-01 / (no row) → active — legal, via first claim**
Covered by DEV-HP-01.

**DEV-ST-02 / active → active — legal self-loop via heartbeat**
Covered by DEV-HP-02.

**DEV-ST-03 / active → revoked (`owner_removed`) — legal, via F5**
Covered by DEV-HP-04.

**DEV-ST-04 / active → revoked (`stolen`) — legal, via F8, ALL rows at once**
Covered by DEV-HP-06.

**DEV-ST-05 / active → revoked (`released`) — legal, via logout**
Area: state · Criticality: High · Traces to: `AuthLogoutService.logout` → `revokeAllSlotsForDevice(..., 'released')`
Steps: User with active slots in Store A and Store B logs out from a session bound to that device.
Expected: **Both** stores' slots revoke (`reason='released'`) — logout is device-scoped, not store-scoped; confirm this matches product intent (a user "logging out of the app" releases every store that device had open, not just "the current store") — flag as a behavior to explicitly confirm with product if the mental model is "log out of Store A only" (OQ-13).

**DEV-ST-06 / active → expired — legal, via 30-day cron only**
Covered by DEV-HP-10/DEV-BD-06/07.

**DEV-ST-07 / revoked(`plan_downgrade`) → active — legal, ONLY via restore, and ONLY for that specific reason**
Area: state · Criticality: High · Traces to: `restoreDowngradedSlots`'s `WHERE revokedReason='plan_downgrade'` filter
Steps: A slot revoked for `owner_removed` and a slot revoked for `plan_downgrade` both exist in the same store; the account is then upgraded (triggering `restoreDowngradedSlots`).
Expected: Only the `plan_downgrade` row is restored to `active`; the `owner_removed` row stays `revoked` forever (an upgrade must never silently un-remove a device the owner explicitly kicked out) — this is a critical distinction to test explicitly, not just infer from the WHERE clause.

**DEV-ST-08 / revoked/expired → active — illegal transition attempted directly (no such mutation exists) except via the two specific restore paths**
Area: state · Criticality: High
Steps: Attempt to find any code path that flips a `revoked/'owner_removed'` or `revoked/'stolen'` or `expired/'auto_expired'` row back to `active` other than a brand-new `insertSlot` (new row) or the narrow downgrade-restore path.
Expected: None exists — confirms F9's documented behavior ("old `store_device_access` rows stay revoked" after unblock) and F5/F10's ("removed/expired stays gone until a fresh claim") are both correctly enforced by the *absence* of any such mutation, not just by convention.

**DEV-ST-09 / `devices.isBlocked` false → true → false — legal, independent of slot state**
Covered by DEV-HP-06/07 together; explicitly verify slots are NOT restored by unblock (only `isBlocked` flips), confirming the two state machines (device-block vs. slot-status) are decoupled.

**DEV-ST-10 / Illegal: unblocking a device that was never blocked should be a no-op, not an error**
Covered by DEV-NG-06 — verifies the transition table treats "already in target state" as idempotent-success, a deliberate product choice worth confirming (some systems would 409 here).

**DEV-ST-11 / Illegal: removing a device with `status='expired'` (not `active`) via F5**
Area: state · Criticality: Medium · Traces to: `revokeSlot`'s `WHERE status='active'` guard
Steps: Owner tries to "remove" a device whose slot already auto-expired (still shown in the "Removed" section of F4's UI per PRD, 90-day window).
Expected: `revokeSlot` matches 0 rows (guard requires `status='active'`) → `404 DEVICE_SLOT_NOT_FOUND` — an owner cannot "re-remove" an already-expired slot; the UI must not offer `[Remove]` on non-active rows (matches PRD F4 layout showing `[Remove]` only in the "Active" section).

---

### 3.9 Cross-cutting cases (XC)

**DEV-XC-01 / Offline-first: first-time store access requires connectivity**
Area: offline-sync · Criticality: High · Traces to: F2 trigger table, F16, BR-DEV-016
Steps: Device with no cached access to a store goes offline, then opens that store for the first time.
Expected: Client cannot call `/access` at all (no network) — this module has no offline-claim path; documents that the *client* must show "Internet connection required for first-time device setup" (this is a client-side UX requirement, not testable against this backend module directly, but the backend's contract — `/access` has no offline/cached grant fallback — is what the client relies on; confirm there's no accidental server-side allowance for a stale/cached claim).

**DEV-XC-02 / Device removed from a store while it is offline, then reconnects and tries to sync**
Area: offline-sync · Criticality: Critical · Traces to: F6/F16, BR-DEV-017, `DeviceSlotGuard`
Steps: Priya's iPhone has pending offline mutations queued (e.g., 3 sales rung up locally). Meanwhile the owner removes her device from the store (DEV-HP-04) while she's offline. She reconnects and her client calls `POST /stores/:id/sync/delta` to push the queued mutations.
Expected: `DeviceSlotGuard` runs **before** `PermissionsGuard`/the sync engine and finds no active slot → `403 DEVICE_SLOT_REQUIRED` for the **entire** push call — none of her 3 queued mutations are individually evaluated/rejected with a per-mutation code; the whole batch is blocked at the guard. **This differs from the PRD's F6 offline description** ("next sync → mutations rejected `DEVICE_ACCESS_REVOKED`" — implying a per-mutation, per-sync-batch rejection surfaced in the conflict list) — actual behavior is an all-or-nothing guard-level 403 with a *different* error code (`DEVICE_SLOT_REQUIRED`, not `DEVICE_REVOKED`/`DEVICE_ACCESS_REVOKED`, neither of which is ever thrown). **Her 3 pending sales are stuck client-side indefinitely** (not rejected into a visible conflict, not accepted) unless/until: (a) the owner re-grants her a slot (she re-opens the store and a slot is free), or (b) the client independently surfaces the 403 as "you no longer have access" and lets the user discard/export the pending queue. Flag as a **High-severity real-world gap**: the PRD's promise of "unsynced changes marked conflicted (F13)" for owner reconciliation is not actually implemented this way — there is no mechanism today for those 3 sales to ever reach the server's conflict list for the owner to review/recover. **(OQ-2, most important open question in this report.)**

**DEV-XC-03 / Device blocked while offline, then reconnects**
Area: offline-sync · Criticality: Critical · Traces to: F16, BR-DEV-007
Steps: Redmi Note 12 has pending offline mutations; owner blocks it from a different device while Redmi is offline; Redmi reconnects.
Expected: Its now-stale JWT (if still within natural expiry and not yet blacklist-checked against a synced blacklist) might pass `MobileJwtGuard`'s blacklist check (LRU→Redis→DB layers) — but `assertUserEligible` re-reads `device.isBlocked` (via `PrincipalCacheService`, itself Redis-cached with some TTL) and rejects with `401 DEVICE_BLOCKED`/`UnauthorizedException` on the very first authenticated call, before `/sync/*` is ever reached. Same net effect as DEV-XC-02 — pending mutations are stuck client-side — but via a `401` at the auth layer instead of a `403` at `DeviceSlotGuard`. Confirm the client handles both codes identically (forced logout) since the *practical* outcome for the user's queued offline sales is the same "stuck forever unless the device is unblocked" state.

**DEV-XC-04 / Owner removes a device while the *owner* (not the target) is offline**
Area: offline-sync · Criticality: Medium · Traces to: F16 "Owner removes a device while owner is offline"
Steps: Owner's own client queues a "remove device" mutation while offline (if the client supports queuing this as an offline-capable action — verify: `DELETE /stores/:id/devices/:id` is a direct REST call in this module, not routed through the sync-mutation-queue at all, so it **cannot** be queued offline the way sale mutations can).
Expected: The owner's remove action simply fails/is unavailable while the owner is offline (no network = no call), since this endpoint has no offline-queue integration — confirms the PRD's "Removal queued; processed on next sync" (F16) does **not** literally apply to this REST endpoint as built; the owner must be online to remove a device. Flag as a PRD-vs-implementation mismatch (OQ-14) — likely fine since it's not the offline party doing the mutation, but worth confirming the client doesn't attempt to queue this call.

**DEV-XC-05 / Tenancy — cannot see or affect another account's devices**
Area: tenancy · Criticality: Critical
Steps: Account A's owner attempts `GET /stores/{accountB'sStoreId}/devices` and `DELETE .../devices/:id` using a `storeId` from a completely different account.
Expected: Blocked upstream by `TenantGuard` (membership check) before any `DeviceAccessService` method runs — confirms this module has zero built-in tenancy checks of its own and fully depends on the guard chain; a regression removing `TenantGuard` from the controller's `@UseGuards` list would be a full cross-tenant data leak with nothing in this module to catch it. (High-value regression-test candidate: assert the guard order/presence directly, not just behaviorally.)

**DEV-XC-06 / Plan downgrade puts a store over its device limit — banner/read state, no auto-removal**
Area: cross-cutting · Criticality: High · Traces to: F14
Covered by DEV-BD-03/DEV-BR-11 — additionally verify the *account-wide write gate* (`SubscriptionStatusGuard`'s `reconciliationStatus==='pending'` check) blocks **all** writes account-wide (not just device actions) until the owner resolves via `POST /subscription/reconciliation`, which is a *different* code path (`ReconciliationService`) than anything in this module — the two must be tested together for the full F14 story, not just this module in isolation.

**DEV-XC-07 / Subscription fully lapsed (`expired`/`paused`) — device reads still work, writes blocked**
Area: cross-cutting · Criticality: Critical · Traces to: F15, `SubscriptionStatusGuard`
Steps: Account status = `expired`. Owner calls `GET /stores/:id/devices` (read) and `DELETE .../devices/:id` (write).
Expected: `GET` succeeds (`READ_METHODS` always pass `SubscriptionStatusGuard`); `DELETE` is blocked with `402 SUBSCRIPTION_PAYMENT_REQUIRED` — even a legitimate device-removal (which frees a slot, arguably *helpful* during a downgrade-recovery) is blocked as a "write" during full lapse. Confirms owners cannot even clean up their own device list to prepare for reactivation while fully lapsed — worth confirming this is intended (OQ-15) since it could frustrate an owner trying to get back under limit before paying.

**DEV-XC-08 / Clock/timezone — cron scheduled in server-local time vs. store timezone**
Area: time · Criticality: Low · Traces to: F10 "daily @2am"
Steps: `CRON_DEVICE_AUTO_EXPIRY` is a single global cron expression — verify it runs in the server process's configured timezone, not per-store timezone; a store in a very different timezone than the server has no special-cased "2am store-local" behavior (the cron is a single global sweep on `lastAccessedAt` UTC timestamps regardless of any store's local "2am").
Expected: Confirms all `lastAccessedAt`/`revokedAt`/etc. are `timestamp with timezone` (per schema) — the 30-day math is timezone-agnostic (pure UTC duration), so this is actually a non-issue; document as verified-safe rather than a gap.

**DEV-XC-09 / DST transition during the 30-day window**
Area: time · Criticality: Low
Steps: A slot's 30-day countdown spans a DST transition (spring-forward or fall-back).
Expected: Since the comparison is `lastAccessedAt < now - 30*24h` in absolute UTC milliseconds (not calendar days), DST has zero effect on the boundary — confirms no bug class here, but worth one regression test asserting the interval math is millisecond-based, not calendar-based.

**DEV-XC-10 / Sync cold-start progress is not cleaned up on device removal (data-consistency gap)**
Area: offline-sync / data-consistency · Criticality: High · Traces to: BR-DEV-017, F13
Steps: Device has `syncInitProgress` rows (`phase='completed'`) for Store A from before being removed (DEV-HP-04). Owner later frees a slot and the same device re-accesses Store A.
Expected: Per the PRD (BR-DEV-017/F13), re-access after removal should force a **full cold-start** (`sync_init_progress` deleted on revoke). **Actual code never calls `SyncInitProgressRepository.reset()`/deletes these rows from any path in `device-access.service.ts`, `device-access.repository.ts`, or `device-slot-expiry-cron.service.ts`.** The stale `completed` rows persist, so `InitialSyncService.pull` (which picks the first entity not yet `'completed'`) will see everything already complete and skip straight to delta-cursor mode using the device's **old**, months-stale cursor — potentially missing entities that changed while the device had no access, or (worse) re-establishing RBAC-filtered visibility from a stale permission snapshot rather than a fresh cold start. **This is the single most significant business-rule gap found in this module — flag as a Critical finding, not just an open question, since it's a documented rule (BR-DEV-017) that is silently unenforced.** (OQ-2/OQ-16.)

**DEV-XC-11 / `devices.lastSyncAt` and store-wide oversell-detection watermark after a device is revoked**
Area: cross-cutting / data-consistency · Criticality: Medium · Traces to: `DeviceSyncHealthRepository` doc-comment on S-34 oversell detection
Steps: A device is revoked/blocked and therefore never syncs again; its `devices.lastSyncAt` is frozen at the moment of revocation.
Expected: If the oversell-detection watermark computation (outside this module) takes `min(lastSyncAt)` across **all** devices that have ever touched the store rather than only devices with a **currently active** slot, a single revoked/removed device could permanently peg the store's oversell watermark to a stale point in time, stalling oversell detection store-wide forever. **This module itself does not filter `lastSyncAt` by active-slot status anywhere** — the watermark query lives elsewhere, but this is the exact failure mode the `DeviceSyncHealthRepository` doc-comment warns about ("a device that merely pulls... must still advance the watermark — otherwise it pegs the min forever"), just for a *permanently absent* device instead of an idle one. Recommend a dedicated cross-module test verifying the oversell watermark query excludes non-active-slot devices. (OQ-17.)

---

### 3.10 UX / experience cases (UX) — expressed as API-contract behavior the client state depends on

**DEV-UX-01 / 403 payload gives the client everything needed to render F3's active-device list without a second call**
Area: UX · Criticality: Medium · Traces to: F3
Steps: Trigger `DEVICE_LIMIT_REACHED`.
Expected: Response `details` includes `{limit, active, devices:[{deviceId, model, platform, userName, deviceLabel, lastAccessedAt}]}` — sufficient for the client to render the owner's F3.1 list (with names/models/times) in one round trip, no follow-up `GET` needed.

**DEV-UX-02 / Staff (non-owner) sees the same `devices[]` payload as the owner on limit-reached**
Area: UX · Criticality: Medium · Traces to: F3.2 "Staff see the active list only here"
Steps: Cashier triggers `DEVICE_LIMIT_REACHED` on a store they can't otherwise list devices for (no `Device:view`).
Expected: The 403 payload is identical regardless of caller role — `claimSlot` has no permission check on the response shape it builds (only the `/access` endpoint's own guard chain, which doesn't include `RequirePermissions` at all). Confirms staff genuinely see the same device/user names here even though they can never `GET /stores/:id/devices` directly — matches PRD's explicit intent ("Staff see the active list only here [i.e. via this error payload]"), but is a privacy-relevant behavior worth a dedicated regression test given how easy an accidental future `@RequirePermissions` addition to this endpoint could silently break the F3.2 experience.

**DEV-UX-03 / `is_current` device flag correctness drives "hide [Remove] on this device" in the client**
Area: UX · Criticality: High · Traces to: F4/F5 "[Remove] hidden on This device"
Steps: Fetch `GET /stores/:id/devices` as the owner, currently authenticated on Galaxy.
Expected: Exactly one row has `is_current:true` (Galaxy's), matched purely on `deviceFk === currentDeviceId` from the JWT — never on `userFk` (i.e., if the owner is ALSO logged in elsewhere on a different device, that other row must NOT be flagged current).

**DEV-UX-04 / Idempotent re-claim (`isNew:false`) vs. first claim (`isNew:true`) drives whether the client shows a "welcome" toast**
Area: UX · Criticality: Low · Traces to: F2
Covered functionally by DEV-HP-01/02; call out explicitly as a UX-signal contract test since the wire field name `isNew` is noted in the mapper's own comment as something "the mobile client already depends on" — any accidental rename/removal is a breaking change, not just a refactor.

**DEV-UX-05 / Double-remove returning 404 must map to a "list needs refresh" UX, not a hard error**
Covered by DEV-CX-08 — call out as its own UX contract case since the *correct* client behavior (silently refetch the list) vs. the *naive* behavior (show a scary error toast for an action that actually already succeeded) is an easy real-world mistake.

---

## 4. Edge-case scenarios (§5 checklist — the ones teams miss)

**DEV-EC-01 / Empty — a user with zero registered devices**
Traces to: "empty/zero/null." `GET /devices/my` for a brand-new user who hasn't completed device registration somehow (edge of onboarding) → `200 []`, not an error. Covered by DEV-BD-10.

**DEV-EC-02 / Empty — a store with zero devices ever accessed**
`GET /stores/:id/devices` for a store created seconds ago, before anyone has opened it → `200 []` (the join-based query naturally returns nothing; verify no crash on an empty `storeDeviceAccess ⋈ devices ⋈ users` join).

**DEV-EC-03 / First-run — the very first device to ever access a brand-new store**
Covered by DEV-BD-04; additionally verify `first_accessed_at === last_accessed_at` exactly on that first row (no drift/race between the two `defaultNow()` column defaults vs. explicit `new Date()` writes in `insertSlot`).

**DEV-EC-04 / Maximum — a store's device list has hundreds of historical (revoked+expired) rows**
Traces to: "maximum/overflow." `listStoreDevices` (used by F4, no `LIMIT`/pagination) against a store with e.g. 500+ historical rows (high device churn over years).
Expected: Query has no pagination — confirm this doesn't become a real-world performance/timeout problem for a long-lived, high-turnover store; PRD says "removed shown 90 days in UI, retained in DB" implying the **client** filters to 90 days, but the **server** returns everything unfiltered every time. Flag as a **scalability gap worth a load test** (OQ-18) — this module has no server-side cap or date filter on `listStoreDevices`/`listActiveStoreDevices`.

**DEV-EC-05 / Duplicate/repeat — the same device claims the same store slot 100 times in a tight loop**
Every call after the first is `isNew:false`/heartbeat; verify no row-count growth (still exactly 1 active row), and no rate-limiting/throttling exists specifically on `/access` today (any store-membership call can hammer it) — confirm this is acceptable or whether `/access` should be covered by the same `SyncRateLimitGuard` used on `/sync/*` (it currently is not — `StoreAccessController` only has `MobileJwtGuard, TenantGuard, SubscriptionStatusGuard`). (OQ-19.)

**DEV-EC-06 / Out-of-order — a cron expiry event and a manual removal for the same row land "at the same time" from the DB's perspective**
Covered by DEV-CX-05-style reasoning; specifically test: cron's `expireStaleSlots` and a concurrent owner `removeDevice` both target the same stale-and-flagged-for-removal row. Expected: whichever commits first "wins" the `revokedReason` (`auto_expired` vs `owner_removed`) — the loser's `WHERE status='active'` matches 0 rows and is a no-op (cron) or a `404` (manual remove, DEV-CX-05 pattern) — no double-processing, but the **audit trail's recorded reason is a coin-flip** between two legitimate-sounding causes; acceptable but worth knowing for anyone reading the audit log later.

**DEV-EC-07 / Offline → sync — conflicting offline device-metadata edits**
Not directly applicable — `devices` table fields (`model`, `osVersion`, `appVersion`, `pushToken`) are only ever written server-side at login (`upsertDevice`) or by explicit block/unblock; there is no client-authored "edit my device" mutation routed through the offline sync-mutation-queue in this module, so there's no offline-edit-conflict surface here to test **for devices themselves** — document as a scope boundary, not a gap.

**DEV-EC-08 / Permission/subscription change mid-flow — role revoked while the "Manage Devices" screen is open**
Covered by DEV-PM-06.

**DEV-EC-09 / Abandonment — app killed mid-`/access` call**
Traces to: "abandonment/interruption." Client sends `POST /stores/:id/access`, then the app is killed before the response arrives; the server-side transaction still completes normally server-side (HTTP request processing isn't tied to the client process). Expected: slot is claimed regardless of whether the client ever saw the response; next app launch's own `/access` call is a normal idempotent heartbeat (`isNew:false`) — no user-visible impact, but confirms the client must not assume "no response = no side effect" for this endpoint.

**DEV-EC-10 / Very long / unicode input in device metadata**
Traces to: "long/unusual input." Login with `device.model` = a 5,000-character string, or containing emoji/RTL text (e.g. a custom ROM's build string).
Expected: `model: text('model')` has no length constraint in the schema — stored and returned as-is; confirm no downstream rendering/DB-index issue; recommend adding a reasonable max-length validation at the DTO layer if none exists upstream of `DeviceService.upsertDevice` (not visible in this module — the `DeviceInfo` interface has no length validation itself).

**DEV-EC-11 / State edge — acting on a device belonging to a soft-deleted/deactivated user**
Traces to: "acting on deleted/locked/expired/archived records." Owner's user account is soft-deleted (`users.deletedAt` set) while their devices/slots still exist in other stores.
Expected: `MobileJwtGuard.assertUserEligible` already blocks any *authenticated* action by that user (`user.deletedAt` → `401 USER_NOT_FOUND`) — but does anything clean up / revoke that now-orphaned user's devices' slots in OTHER stores (e.g., an owner leaving one store but still holding slots at another under the same account)? Nothing in this module reacts to user soft-deletion — slots simply sit `active` forever, silently consuming plan-limited seats for a user who can never authenticate again. Flag as a **real orphaned-resource gap** (OQ-20) — those slots will never expire before 30 days and nothing proactively frees them on account/user deactivation.

**DEV-EC-12 / Device/platform — `platform` enum boundary (`ios`/`android`/`web`)**
Traces to: "device/platform." Login with `platform:'web'` (schema explicitly allows it) claiming a store slot exactly like a mobile device.
Expected: A "web" device consumes a slot identically to a phone — worth an explicit test since the PRD's mental model throughout is "phones/tablets"; confirm product intends browser-based POS sessions to count 1-for-1 against the same `max_devices_per_store` budget (likely yes, but worth confirming — OQ-21).

**DEV-EC-13 / Rounding/decimals — N/A for this module**
No monetary/quantity fields exist in the Devices module; this dimension does not apply here (documented for completeness of the checklist, not a gap).

**DEV-EC-14 / Connectivity transitions — goes offline mid-`/access` request (server side never sees it)**
Traces to: "connectivity transitions." Request never reaches the server (client offline before send) → no server-side case exists; purely a client retry-on-reconnect concern. Documented as out of this module's testable surface.

**DEV-EC-15 / Concurrent identical actions — two of the owner's devices both trying to block the SAME stolen device at once**
Traces to: "concurrent identical." Owner has Galaxy and iPad both logged in; both fire `PATCH /devices/{redmi}/block` within the same instant.
Expected: Both requests find `device.isBlocked=false` initially (read-then-write, no row lock on `devices` for this operation) and both proceed through the full transaction — the second one's `setBlocked(id, true)` and `revokeAllSlotsForDevice`/`revokeDeviceSessions` are simply redundant no-op-equivalent writes (nothing left to revoke) — but **two separate `DEVICE_BLOCKED` audit rows get written** for the same logical action, and `revokeLiveTokens` runs twice (harmless — blacklisting an already-blacklisted jti or invalidating an already-gone cache entry). Confirms no double-charge/double-harm, but a minor audit-log duplication worth knowing about (Low priority).

**DEV-EC-16 / Very large device counts across `listMyDevices`' batched queries**
Traces to: "maximum/overflow." A power-user account with 50+ devices registered over years (reinstall churn, PRD's own D8 concern) calls `GET /devices/my`.
Expected: `activeStoresForDevices` is a single grouped query keyed on all 50+ device ids at once (no chunking) — confirm no practical limit issue at realistic scale (50-200 devices is fine for a single IN-clause; flag only if this could realistically reach thousands, which seems unlikely for a single user in this domain — Low priority, informational).

---

## 5. Coverage summary

| Requirement / Rule / Transition | Satisfied case(s) | Violated / negative case(s) | Gap? |
|---|---|---|---|
| F1 Registration (login) doesn't consume a slot | HP-09, BR-01a | BR-01b (N/A by construction) | No |
| F2 Store access & device-limit check | HP-01, HP-02, HP-08, BD-01..05 | BD-02, BR-12a | No |
| F3 Device limit reached (payload/role) | UX-01, UX-02 | — | No |
| F4 Manage store devices (list) | HP-03 | NG-09, PM-03 | Yes — no pagination (EC-04) |
| F4 sub-rule: device label editing | — | — | **Yes — endpoint doesn't exist (OQ-3)** |
| F5 Remove device from store | HP-04 | NG-02, NG-03, BR-04a, ST-11 | No |
| F6 Removed-device experience (offline) | — | XC-02 | **Yes — no per-mutation reject, wrong error code (OQ-2)** |
| F7 My Devices | HP-05 | PM-09 | No |
| F8 Block stolen device | HP-06 | BR-06b, NG-04/05 | No |
| F9 Unblock device | HP-07 | NG-06 | No |
| F10 Auto-expiry cron | HP-10, BD-06/07/08 | FR-07/08 | No (deliberate deviation from PRD's distributed-lock ask, OQ-10) |
| F10B Slot lease / crash reclaim | ST-05 (release-on-logout) | — | **Yes — F10B.3.2 auto soft-TTL reclaim not implemented (OQ-5)** |
| F11 Re-registration / reinstall | HP-09 | — | No |
| F12 Push token management | BR-10 (nulled on block) | — | **Yes — no PATCH push-token endpoint (OQ-4)** |
| F13 Multi-device sync impact / cleanup | — | XC-10 | **Yes, Critical — sync_init_progress never cleaned up (OQ-2/16)** |
| F14 Downgrade over-limit | BD-03, BR-11, XC-06 | — | No (verify jointly with reconciliation module) |
| F15 Subscription expiry → device r/w | XC-07 | — | No (mostly owned by SubscriptionStatusGuard, tested here at the boundary) |
| F16 Offline behavior matrix | XC-01, XC-04 | XC-02, XC-03 | Partially — remove-device isn't offline-queueable (OQ-14), consistent with design |
| BR-DEV-000 (max_stores, account-level) | — (out of this module's file set) | — | N/A here |
| BR-DEV-002 Registration ≠ slot | HP-09, BR-01a | — | No |
| BR-DEV-003 Active-only counting | BR-02a | — | No |
| BR-DEV-004 Heartbeat freshness | HP-02, BR-03 | — | No |
| BR-DEV-005 Self-lockout prevention | BR-04a | BR-04b | No |
| BR-DEV-006 Removal ≠ membership removal | BR-05 | — | No |
| BR-DEV-007/008 Block = global kill | BR-06a | BR-06b | No |
| BR-DEV-009 30-day expiry | HP-10, BD-06/07 | — | No |
| BR-DEV-010 NULL = unlimited | HP-08 | — | No |
| BR-DEV-013 No duplicate device identity | HP-09 | BR-09b | **Yes — race-condition handling unverified (OQ-6)** |
| BR-DEV-014 Push token nulled on block | BR-10 | — | Partial — never restored (by design, but no re-registration endpoint exists either, OQ-4) |
| BR-DEV-015 Downgrade doesn't auto-remove | BR-11 | — | No |
| BR-DEV-016 First access needs internet | XC-01 | — | No (client-side; contract documented) |
| BR-DEV-017 Sync cleanup on revoke | — | XC-10 | **Yes, Critical (OQ-2/16)** |
| BR-DEV-018 Atomic slot claim | HP-01, BR-12b | BR-12a (needs live DB test), CX-01 | Needs live-DB confirmation (OQ-7) |
| BR-DEV-021/022 Lease + crash recovery | ST-05 | — | Partial — owner instant reclaim only, no auto soft-TTL (OQ-5) |
| State: (none)→active | ST-01 | — | No |
| State: active→active | ST-02 | — | No |
| State: active→revoked (3 reasons) | ST-03, ST-04, ST-05 | — | No |
| State: active→expired | ST-06 | — | No |
| State: revoked(plan_downgrade)→active | ST-07 | ST-08 | No |
| State: revoked(other)→active | — | ST-08 (confirmed impossible) | No |
| RBAC: Owner/Manager/Cashier matrix | PM-01, PM-02, PM-04 | PM-03, NG-09 | Manager default-grant unverified (OQ-1) |
| Tenancy isolation | PM-09 | XC-05 | No (fully guard-dependent — regression risk noted) |

### Gaps requiring product/dev attention before sign-off
1. **XC-10 / BR-DEV-017** — `sync_init_progress` is never deleted on device remove/block/expire. **Critical.**
2. **XC-02** — Offline device revocation doesn't surface as a per-mutation, owner-visible conflict; it's an all-or-nothing guard-level 403 with a code (`DEVICE_SLOT_REQUIRED`) different from what the PRD documents (`DEVICE_ACCESS_REVOKED`/`DEVICE_REVOKED`, neither ever thrown). Pending offline sales can get stuck with no recovery path. **Critical.**
3. **OQ-3/OQ-4** — Device label rename and push-token update endpoints described in the PRD (F4, F7, F12) don't exist in this module at all.
4. **OQ-5** — F10B.3.2's automatic 72h contended-slot soft-reclaim isn't implemented (only the manual "owner instant reclaim via existing remove" path works).
5. **OQ-11** — `claimSlot` never re-checks `devices.isBlocked` itself (relies entirely on the auth guard chain having already filtered it — narrow race window, see DEV-CX-04).
6. **EC-04/EC-16** — no pagination on `listStoreDevices`/`listActiveStoreDevices`; unbounded historical growth.
7. **EC-11** — no cleanup of device slots when the owning user is soft-deleted/deactivated.

---

## 6. Priority roll-up (run first)

**Critical (money/auth/data-integrity/concurrency/legal):**
- DEV-HP-04, DEV-HP-06 (remove/block correctness, live-token kill)
- DEV-BR-04a, DEV-BR-05, DEV-BR-06a/b (self-lockout, membership preservation, ownership gate)
- DEV-BR-12a/DEV-CX-01 (last-slot race — must be run against a real DB, not just reasoned about)
- DEV-BR-13 (DeviceSlotGuard billing-invariant enforcement on sync)
- DEV-FR-01, DEV-FR-03 (best-effort vs. transactional failure boundaries)
- DEV-CX-03, DEV-CX-04 (cron-vs-heartbeat race; block-vs-claim race)
- DEV-XC-02, DEV-XC-03, DEV-XC-10 (offline revocation + pending-mutation fate; sync_init_progress gap)
- DEV-XC-05 (tenancy isolation / guard-chain regression test)
- DEV-NG-07, DEV-NG-08 (cross-tenant access, missing auth)
- DEV-FR-10 (entitlement-lookup fail-closed behavior on onboarding)

**High:**
- DEV-HP-01/02/05/07/08/09/10, DEV-BD-01..07, DEV-BR-03/07/09b/11/12b, DEV-NG-02/09,
  DEV-FR-02/05/08, DEV-CX-02/06, DEV-PM-02/06/09, DEV-ST-05/07/08/11, DEV-XC-06/07,
  DEV-UX-03, DEV-EC-04/11

**Medium/Low:** everything else in §3, plus §4's remaining edge cases (EC-01/02/05/06/09/10/12/15/16).

---

## 7. Open questions

- **OQ-1** — Is "Manager" actually seeded with `Device:view` by default, given `Device` is absent
  from `DEFAULT_ROLE_CRUD`? If Manager is a custom-role template built on that default, PRD §23's
  claim ("Manager: view store devices ✓") requires an explicit extra grant somewhere not visible in
  this module. Needs confirmation against the actual role-seed data.
- **OQ-2** — Confirm the intended UX/data story for an offline device that gets revoked/blocked
  while it has pending mutations: today it's an all-or-nothing `403 DEVICE_SLOT_REQUIRED` at the
  sync guard, not a per-mutation conflict-list entry as PRD F6/F13 describe. Is losing those
  pending mutations (until the device somehow regains a slot) acceptable, or is a conflict-surfacing
  mechanism expected to be built?
- **OQ-3** — Is device-label rename (F4/F7) in scope for this module and simply not yet built, or
  intentionally deferred? `deviceLabel`/`label` fields exist end-to-end in schema and DTOs but are
  permanently `null`.
- **OQ-4** — Same question for `PATCH /devices/:id/push-token` (F12) — not built at all.
- **OQ-5** — Is the automatic 72h contended-slot soft-reclaim (F10B.3.2) planned, or is "owner
  instant reclaim" (already achievable via the existing remove-device endpoint using the deviceId
  from the 403 payload) considered sufficient for Phase 1?
- **OQ-6** — Confirm actual behavior of a concurrent `upsertDevice` race for a brand-new
  `(userFk, publicKeyHash)` — does the login/signup transaction gracefully handle the
  `devices_user_key_hash_uq` violation the way `claimSlot` handles `uk_sda_active`, or does it
  surface a raw 500? (Needs a direct test against `AuthLoginService`/`AuthSignupService`, both out
  of this module's file set but load-bearing for device registration.)
- **OQ-7** — In the last-slot race (DEV-BR-12a), can two genuinely *different* devices both ever
  receive `{granted}` for what should be a single remaining slot, given the catch-all `23505` →
  `{granted, isNew:false}` handling doesn't distinguish "my own retry" from "a different device that
  also hit the unique index"? Needs a real concurrent-transaction test against Postgres, not just
  code review, to close this out definitively.
- **OQ-8** — Confirm the intentional asymmetry between `removeDevice`/`blockDevice` (audit written
  transactionally, failure rolls back the whole action) and `unblockDevice` (audit best-effort,
  failure never rolls back) is a deliberate product/eng decision, not an oversight.
- **OQ-9** — Should the `23505`-catch in `claimSlot` re-verify an active row now exists for *this*
  device before returning `{granted}`, to close the narrow "unrelated unique violation" false-grant
  risk (DEV-FR-06)?
- **OQ-10** — The PRD explicitly asks for a Redis distributed lock around the auto-expiry cron
  (§15 F10); the actual implementation deliberately uses only an in-memory re-entrancy guard with a
  code comment arguing it's safe "here." Confirm this deviation is accepted at current
  scale/deployment topology (single vs. multi-instance).
- **OQ-11** — Should `claimSlot` defensively re-check `devices.isBlocked` itself, rather than relying
  entirely on the auth-guard chain having already filtered out blocked devices (DEV-CX-04's narrow
  race window)?
- **OQ-12** — Is last-write-wins acceptable for concurrent block/unblock of the same device from two
  of the same user's own sessions (DEV-CX-09), given the security-sensitive nature of "block a
  stolen device"?
- **OQ-13** — Confirm the product's mental model for logout: is releasing **every** store slot a
  device held (not just "the current store") the intended behavior of a single logout action?
- **OQ-14** — F16's "owner removes a device while owner is offline → queued, processed on next sync"
  doesn't match the actual endpoint (`DELETE /stores/:id/devices/:id` is a direct REST call with no
  offline-queue integration) — confirm this PRD line describes aspirational/future behavior, not a
  regression.
- **OQ-15** — Should device-removal (a write, but one that only ever *frees* capacity) be exempt from
  `SubscriptionStatusGuard`'s write-block during a fully lapsed subscription, the way reads are
  exempt, to let an owner clean up before reactivating?
- **OQ-16** — Confirm whether `SyncInitProgressRepository.reset()` is expected to be wired into
  `removeDevice`/`blockDevice`/`expireStaleSlots` as a follow-up, or whether the sync engine handles
  staleness some other way not visible from the Devices module alone (e.g., RBAC-driven filtering
  making a stale cold-start progress harmless regardless).
- **OQ-17** — Confirm (in the module that computes it) whether the S-34 oversell-detection watermark
  excludes devices without a currently-active slot, to avoid a permanently-revoked device pegging the
  watermark forever via its frozen `lastSyncAt`.
- **OQ-18** — Should `listStoreDevices`/`listActiveStoreDevices` gain server-side pagination or a
  90-day date filter (matching the client's own display window) for long-lived, high-churn stores?
- **OQ-19** — Should `POST /stores/:storeId/access` be covered by `SyncRateLimitGuard` (or an
  equivalent), given it currently has no rate limiting of its own?
- **OQ-20** — Should a user's device slots across all stores be proactively released when that
  user's account is soft-deleted/deactivated, rather than left to sit until the 30-day cron (which,
  notably, only checks `lastAccessedAt`, not the owning user's status at all)?
- **OQ-21** — Confirm `platform:'web'` devices are intended to consume a device-limit slot
  identically to native mobile devices.