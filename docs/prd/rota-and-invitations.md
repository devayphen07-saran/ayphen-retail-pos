# Staff: Roles, Invitations, Shifts & Rota — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** custom roles & RBAC assignment, the invitation lifecycle, standing shift assignment,
> the weekly rota with service areas, and the **membership-vs-device-slot** rule.
> **Companions:** device limit & "contact owner" UX in [device-management.md F2/F3](./device-management.md#7-f2--store-access--device-limit-check);
> subscription gate on accept in [subscription.md §7](./subscription.md#7-enforcement--reads-vs-writes).
> **Source of truth:** backend is authoritative; "current" lines are cited. New work marked **🆕**;
> existing-but-not-wired marked **schema-ready**.

---

## Table of contents
1. [Overview & the three layers](#1-overview--the-three-layers)
2. [The golden rule — membership ≠ device slot](#2-the-golden-rule--membership--device-slot)
3. [RBAC — custom roles & permissions](#3-rbac--custom-roles--permissions)
4. [F1 — Create a custom role](#4-f1--create-a-custom-role)
5. [F2 — Set role permissions](#5-f2--set-role-permissions)
6. [F3 — Invite a user (role + optional default shift)](#6-f3--invite-a-user-role--optional-default-shift)
7. [F4 — Accept / decline / revoke invitation](#7-f4--accept--decline--revoke-invitation)
8. [F5 — First store open after accept (device-limit gate)](#8-f5--first-store-open-after-accept-device-limit-gate)
9. [F6 — Standing shift assignment](#9-f6--standing-shift-assignment)
10. [F7 — Weekly rota + service areas](#10-f7--weekly-rota--service-areas)
11. [Real-world comparison & rationale](#11-real-world-comparison--rationale)
12. [Screens](#12-screens)
12B. [Loading states (per flow)](#12b-loading-states-per-flow)
13. [RBAC matrix](#13-rbac-matrix)
14. [Business rules](#14-business-rules)
15. [Validation matrix](#15-validation-matrix)
16. [Real-world scenarios](#16-real-world-scenarios)
17. [Backend changes required](#17-backend-changes-required)
18. [Design decisions](#18-design-decisions)
19. [Phase 2 — deferred](#19-phase-2--deferred)

---

## 1. Overview & the three layers

Staffing has **three independent layers**. Keeping them separate is what real workforce/POS apps
(Deputy, Homebase, When I Work, Square Team, Shopify) do — and the backend already models it this way.

| Layer | What it answers | Table(s) | Cadence |
|---|---|---|---|
| **1. Membership + RBAC** | "Who is staff here, and what may they do?" | `role`, `role_permissions`, `user_role_mapping`, `invitation` | one-time onboarding |
| **2. Standing shift assignment** | "Which named shift does this person normally work?" | `shift` (definition), `shift_assignment` | occasional |
| **3. Weekly rota** | "Who works which day/time/section this week?" | `rota_entry`, `service_area`, `register` | weekly, ongoing |

**Design principle:** the **invitation** establishes *membership + role* (layer 1) and may pre-fill a
*default* shift (layer 2). **Scheduling is the rota (layer 3)** — never coupled to the one-time invite.

---

## 2. The golden rule — membership ≠ device slot

**A staff member having access to a store is NOT the same as that member's phone holding a device
slot.** They are enforced at different moments:

- **Membership** is granted at **invitation accept** — and **the device limit is NOT checked there**
  (verified: `invitation.service.ts doAccept` checks subscription `:220` but never the device limit).
- **A device slot** is a runtime resource claimed at **store open** (`POST /stores/:id/access`,
  [device F2](./device-management.md#7-f2--store-access--device-limit-check)).

```
Accept invite     → membership granted ALWAYS (device limit not checked; subscription IS checked)
Open the store    → POST /stores/:id/access
   slot free      → granted → POS
   at limit       → 403 DEVICE_LIMIT_REACHED → "Contact the store owner to free a slot"
                    + active-device list (device F3.2, staff/cashier view)
```

**This is the correct, finalized approach** (and what the backend already does). Reasons:
- A device slot caps *concurrent physical devices*, not how many people may belong.
- Staff can share a counter tablet, or wait for a slot to free — they're still members.
- Blocking *membership* on a *device* cap conflates two unrelated limits.

**Polish (optional, real-app-grade):**
- When the **owner invites**, show "X/Y devices in use" so they know the invitee may need a slot freed.
- At **accept**, optionally show the invitee a soft note "this store is at its device limit; you may
  need to wait for a slot." Informational only — the hard gate stays at `/access`.

---

## 3. RBAC — custom roles & permissions

**Model (verified):**
- **System roles:** `USER`, `SUPER_ADMIN`, `STORE_OWNER` (global, not assignable via invite).
- **Custom roles:** per-store, created by the owner (e.g. "Cashier", "Manager", "Stock Clerk").
- **Permissions live on the role** — CRUD `(Entity, view|create|edit|delete)` + special
  `(Entity, ACTION_CODE)`. **No per-user overrides** — a user's effective permissions = the **union
  of their roles' grants** (`snapshot.service.ts:124-152`). To give someone a different permission
  set, create another role.
- **Invitations assign only custom roles of THIS store** — never a system role
  (`invitation.service.ts send()` → `assertRoleAssignableInStore`; prevents minting a second owner).

---

## 4. F1 — Create a custom role

**Endpoint (exists):** `POST /stores/:storeId/rbac/roles` — `@RequirePermissions({entity:'Role', action:'create'})`.
**Actor:** owner (or any role granted `Role:create`).

### Steps
1. Owner → Store Settings → Roles → "Create role".
2. `POST .../roles { code, role_name, description }` → creates a `role` row with `store_fk=this store`,
   `is_system=false`, `is_editable=true`.
3. New custom roles get a sensible default CRUD matrix (`DEFAULT_ROLE_CRUD`) which the owner then edits (F2).

### Rules
- Custom role `code` cannot collide with reserved system codes (`STORE_OWNER`/`USER`/`SUPER_ADMIN`) — DB CHECK constraint.
- Roles are **store-scoped**; the same name in two stores = two independent roles.

---

## 5. F2 — Set role permissions

**Endpoints (exist), all `@RequirePermissions({entity:'Role', action:'edit'})` + `@StepUpAuth({within:'5m'})`:**
- `PUT /roles/:roleId/permissions/crud` — set CRUD grants per entity.
- `POST /roles/:roleId/permissions/special` — grant a special action (e.g. `Order:REFUND`).
- `DELETE /roles/:roleId/permissions/special/:entityCode/:actionCode` — revoke a special action.
- `PUT /roles/:roleId/permissions/matrix` — bulk-save the whole matrix.
- `GET /roles/:roleId/permissions` — read the matrix (`{entityCode, canView, canCreate, canEdit, canDelete, specialActions[]}`).

### Rules
- **Permission identity:** CRUD = `(Entity PascalCase, view|create|edit|delete)`; special =
  `(Entity, SCREAMING_SNAKE)`. (Same shape the client gates off in the snapshot.)
- Editing a role **bumps `permissionsVersion`** for every user mapped to it → their snapshot
  refreshes on the next request (no per-user override needed).
- Sensitive — requires **step-up auth** (5-minute window).

---

## 6. F3 — Invite a user (role + optional default shift)

**Endpoint (exists):** `POST /stores/:storeId/invitations` — `@RequirePermissions` (owner/role-manager),
**step-up**. **Actor:** owner / role-manager.

### Request (verified `invitation.service.ts send()`)
```
{ email? | phone?,            // at least one contact
  roleGuuid,                  // REQUIRED — a custom role of THIS store
  shiftGuuid?,                // OPTIONAL — a shift definition of this store (default standing shift)
  shiftValidFrom?, shiftValidTo?,   // optional date range for that shift
  message? }
```
- `assertRoleAssignableInStore(role, storeId)` — role must be custom + belong to this store.
- If `shiftGuuid` given: `findShiftByGuuid` must belong to this store; date range validated.
- Daily invite **rate limit** (`countInvitationsToday` → `assertInvitationRateLimit`).
- Creates an `invitation` row (`status='pending'`, `token_hash`, `expires_at = now + INVITATION_TTL_DAYS`),
  storing `role_fk`, `shift_fk`, `shift_valid_from/to`. Audit `INVITATION_SENT`.

### Rules
- **`roleGuuid` is required; `shiftGuuid` is optional and is a *default standing shift*, not a schedule.**
  Real scheduling is the rota (F7). Don't make shift mandatory.
- The shift is **stored as intent** and materialized **on accept** (you can't assign a shift to a
  user who has no `user_fk` yet).
- **🆕 (optional polish):** surface "X/Y devices in use" to the owner here so they know the invitee
  may need a slot freed.

---

## 7. F4 — Accept / decline / revoke invitation

**Endpoints (exist), `invitation-response.controller`:**
- `GET /invitations/:token` — preview (store, role, permissions preview, shift).
- `POST /invitations/:token/accept` · `/decline` (deep-link token).
- `POST /invitations/by-id/:id/accept` · `/decline` (from the workspace tab).
- `POST /stores/:storeId/invitations/:invitationId/revoke` — owner revokes a pending invite.

### Accept flow (verified `doAccept` `:212-349`)
1. **Acceptability + identity check** — the caller's email/phone must match the invite.
2. **Subscription gate** (`subscription.checkAccess(storeFk)` `:220`) — a `paused`/`cancelled`/
   past-grace store **blocks accept** (can't join a non-transacting store). *(This is the ONE gate at
   accept — see §2.)*
3. **Tx:** row-lock → **already-member guard** (`ALREADY_A_MEMBER`) → `insertRoleMapping` (`:255`) →
   **`bumpPermissionsVersion(responder)`** (`:266`) → outbox event.
4. **🟢 NO device-limit check** — membership is granted regardless of device slots (§2).
5. **Post-tx:** if the invite carried a shift, `shiftAssignmentService.create()` (`:307`) materializes
   the **standing shift assignment** (F6). Audit.
6. The store now appears in the user's snapshot (pv bumped) → set as `last_opened` → they can open it (F5).

### Rules
- **Decline** is always allowed (no side effects beyond status).
- **Revoke** (owner) invalidates a pending invite.
- Invites expire after `INVITATION_TTL_DAYS`.
- Accepting a **paused/lapsed** store is blocked with the subscription error (route to "ask the owner").

---

## 8. F5 — First store open after accept (device-limit gate)

After accept (F4), the new member opens the store. **This is where the device limit applies** — not at accept.

```
Member taps the new store → POST /stores/:id/access  (online; device from auth)
  slot available      → granted → cold-sync → POS
  403 DEVICE_LIMIT_REACHED → STAFF screen (device F3.2):
     "All device slots are in use. Contact the store owner to free up a slot."
     + read-only list of active devices  [OK → store picker]
```

- The **owner** can then remove a device ([device F5](./device-management.md#10-f5--remove-device-from-store))
  or upgrade; once a slot frees, the member re-opens and is granted.
- This is the **finalized "contact store owner" approach** — correct and already specified.

---

## 9. F6 — Standing shift assignment

**Concept:** a `shift` is a **named time-window template** (`code, name, start_time, end_time` HH:MM);
a `shift_assignment` binds a **person ↔ shift** (optionally with a valid date range). This is the
*standing/default* assignment, set at invite or later — **not** the day-by-day schedule.

**Endpoints (exist):**
- Shift definitions: `GET/POST/PATCH/DELETE /stores/:storeId/shifts` (gated by `Shift:*`).
- Shift assignments: `GET/POST/PATCH/DELETE /stores/:storeId/staff/:userId/shifts` (gated by `ShiftAssignment:*`).

### Rules
- A member can have a standing shift (from the invite) **and/or** be scheduled per-day in the rota (F7).
- Whoever has `ShiftAssignment:create` (owner by default) manages assignments — **role-gated, not a hardcoded role**.
- `shift_session` (the open/close-with-cash POS session) is a **different concept** — no REST API,
  created locally + synced (see device/mobile docs). Don't conflate `shift` (template) with
  `shift_session` (cash session).

---

## 10. F7 — Weekly rota + service areas

> **Schema-ready** (tables already exist; build the API/handlers). This is the **real scheduling layer**.

### 10.1 Data model (existing schema)
- **`service_area`** — a store zone/section: `name, description, register_fk?, color_hex (default
  #6B7280), is_active, display_order`. e.g. "Counter 1", "Back Office", "Delivery".
- **`rota_entry`** — the weekly roster row: `week_start_date, day_of_week (0–6), user_fk,
  shift_definition_fk?, custom_start_time?, custom_end_time?, service_area_fk?, register_fk?`.
- **`rota_template` / `rota_template_entry`** — reusable weekly patterns (Phase 2 / optional).

### 10.2 Minimal functionality (Phase 1)
1. **Service areas:** owner creates/edits a few zones (name + color + optional register). CRUD.
2. **Weekly rota view:** a grid of staff × days for a `week_start_date`.
3. **Add/edit a rota entry:** pick staff + day → choose a **shift definition** *or* a **custom
   start/end time** → optionally tag a **service area** and a **register**.
4. **Read on the device:** staff see their own week ("you're on Counter 1, Mon 9–6").

### 10.3 Rules
- A `rota_entry` uses **either** `shift_definition_fk` **or** `custom_start/end_time` (one source of time).
- `service_area_fk` and `register_fk` are **optional** (minimal = unscheduled-by-area is allowed).
- Rota entries are **store-scoped**; staff can only be rota'd into stores they're members of.
- **Offline-first:** model `rota_entry` + `service_area` as **sync entities** (mutation handlers) so
  scheduling works offline like everything else; or expose simple REST if scheduling is owner-only/online.
  *(Decision in §18.)*

---

## 11. Real-world comparison & rationale

| Question | What most apps do | Our finalized choice |
|---|---|---|
| Permissions per person? | Role-based templates (Shopify, Square, Slack) — assign people to roles, not bespoke per-person grants | **Role-based** (matches backend: union of role grants, no per-user override) |
| Schedule at invite? | No — invite = identity+role; scheduling is a separate ongoing roster (Deputy, Homebase, When I Work) | **Invite = role (+ optional *default* shift); rota = the real scheduler** |
| Block membership on seat/device limit? | No — let them join, gate at the resource | **Accept always succeeds; device limit gates at store-open** |
| Standing vs daily scheduling? | Two layers: role/availability + actual roster (Deputy) | **`shift_assignment` (standing) + `rota_entry` (weekly)** |

The backend already matches the real-world pattern on all four — this PRD just makes it explicit and
adds the rota layer that's schema-ready but unbuilt.

---

## 12. Screens

| Screen | Purpose |
|---|---|
| Roles list / editor | create role, edit CRUD + special matrix (step-up) |
| Invite member | contact + role (required) + optional default shift + message; owner sees device usage |
| Invitations (pending) | sent invites; revoke; badge/count |
| Invitation preview (invitee) | store, role, permission preview, shift; accept/decline |
| Device-limit reached (invitee, post-accept open) | "contact owner" + active-device list (device F3.2) |
| Shift definitions | named time templates |
| Staff shifts (standing) | a member's standing shift assignments |
| **Service areas** | create/edit store zones (name + color + register) |
| **Weekly rota** | staff × days grid; add/edit entries → shift/custom time + service area + register |

---

## 12B. Loading states (per flow)

Treatments use the [mobile-08 §13](./mobile-08-loading-ux-states.md) vocabulary (**A–E**); rules live there.

| Flow | Treatment | Notes |
|---|---|---|
| Create role (F1) | **E** button spinner | submit form |
| Set role permissions (F2) | **E** button spinner | step-up → save matrix |
| Invite member (F3) | **E** button spinner | submit; owner sees device-usage hint inline |
| Invitation preview (F4) | **C** / instant | skeleton while `GET /invitations/:token` loads |
| Accept invite (F4) | **E** spinner → **B** | spinner on accept → **B full-screen "Joining {store}"** (first cold sync) → POS |
| Device limit on first open (F5) | **B** / modal | "contact owner" + device list (device F3.2) |
| Standing shift assignment (F6) | **E** button spinner | quick form |
| Service areas (F7) | **E** + toast | optimistic CRUD |
| Weekly rota (F7) | **C** / instant | grid skeleton while loading; instant if local; rota edits optimistic |

---

## 13. RBAC matrix

| Action | Owner | Role-manager (custom) | Cashier |
|---|---|---|---|
| Create/edit/delete custom role | ✓ | if `Role:create/edit/delete` | ✗ |
| Set role permissions | ✓ | if `Role:edit` (+step-up) | ✗ |
| Send / revoke invitation | ✓ | if granted | ✗ |
| Accept / decline own invite | ✓ (the invitee) | ✓ | ✓ |
| Manage shift definitions | ✓ | if `Shift:*` | ✗ |
| Manage shift assignments | ✓ | if `ShiftAssignment:*` | ✗ |
| Manage service areas / rota | ✓ | if granted (new `Rota`/`ServiceArea` perms) | view own |
| Remove a device / upgrade plan | ✓ | ✗ | ✗ |

---

## 14. Business rules

| ID | Rule |
|---|---|
| BR-INV-001 | Invitations assign **only custom roles of this store** — never a system role. |
| BR-INV-002 | Permissions live on the **role**; effective perms = union of role grants. **No per-user overrides.** |
| BR-INV-003 | Editing a role bumps `permissionsVersion` for all mapped users → snapshot refreshes. |
| BR-INV-004 | `roleGuuid` is **required** on an invite; `shiftGuuid` is **optional** (a default standing shift, not a schedule). |
| BR-INV-005 | The invite's shift is stored as intent and **materialized on accept** (no user_fk before accept). |
| BR-INV-006 | **Accept checks subscription, NOT the device limit.** Membership ≠ device slot. |
| BR-INV-007 | Accepting a **paused/lapsed** store is blocked (subscription gate). |
| BR-INV-008 | The **device limit gates at store-open** (`/access`) → staff see "contact owner" + device list (device F3.2). |
| BR-INV-009 | Already-a-member accept is a no-op guard (`ALREADY_A_MEMBER`); declines/revokes always allowed; invites expire after TTL. |
| BR-ROTA-001 | A `rota_entry` uses **either** a shift definition **or** custom start/end — not both. |
| BR-ROTA-002 | Staff can only be rota'd into stores they are members of. |
| BR-ROTA-003 | `service_area` and `register` on a rota entry are optional (minimal). |
| BR-ROTA-004 | `shift` (template) and `shift_session` (cash session) are distinct concepts — never conflate. |

---

## 15. Validation matrix

| Trigger | Check | Result |
|---|---|---|
| Invite with a system/other-store role | `assertRoleAssignableInStore` | reject (role not assignable) |
| Invite with a shift not in this store | `findShiftByGuuid.storeFk` | `404` shift not found |
| Invite over staff cap | `activeMembers >= max_users_per_store` | `403 USER_LIMIT_REACHED` ([subscription.md S10](./subscription.md#15c-s10--staff-limit-max_users_per_store)) |
| Accept on paused/lapsed store | `subscription.checkAccess` | blocked (subscription error) |
| Accept when already a member | active mapping exists | `ALREADY_A_MEMBER` (no-op) |
| Accept when store at device limit | (not checked) | **accept succeeds** |
| Open store at device limit (post-accept) | per-store device count | `403 DEVICE_LIMIT_REACHED` → "contact owner" |
| Rota entry with both shift + custom time | one-source rule | reject |
| Rota a non-member | membership check | reject |

---

## 16. Real-world scenarios

**S1 — Hire a cashier.** Owner creates "Cashier" role → grants `Order:create/view`, `Customer:view`,
`Product:view` → invites Priya as Cashier with a default "Morning 9–2" shift. Priya accepts → becomes
a member with Cashier permissions + the standing shift. Owner schedules her week in the rota.

**S2 — Store at device limit.** Priya accepts fine (membership granted). She opens the store →
`DEVICE_LIMIT_REACHED` → "Contact the store owner." Owner removes an old device → Priya re-opens → POS.

**S3 — Weekly roster.** Owner opens the rota for next week → drags Priya to Mon/Wed/Fri, Counter 1,
9–6; Kumar to Tue/Thu, Back Office. Each sees their own week on their device.

**S4 — Permission change.** Owner adds `Order:REFUND` (special) to the Cashier role (step-up) → every
Cashier's `permissionsVersion` bumps → their snapshot refreshes on the next request; no re-invite.

**S5 — Lapsed store.** The store's subscription is paused. A pending invitee tries to accept → blocked
("ask the owner to reactivate"). Existing members keep read-only access.

---

## 17. Backend changes required

| # | Change | Status |
|---|---|---|
| 1 | **Service-area CRUD** (the `service_area` table is schema-ready, no API) | 🆕 |
| 2 | **Rota CRUD** (`rota_entry`; optional `rota_template`) — REST or sync mutation handlers | 🆕 |
| 3 | (Optional) **`Rota` / `ServiceArea` permission entities** in the RBAC matrix so rota mgmt is role-gated | 🆕 |
| 4 | **`max_users_per_store` gate** at invite/accept ([subscription.md S10](./subscription.md#15c-s10--staff-limit-max_users_per_store)) | 🆕 |
| 5 | (Optional polish) device-usage hint to the owner on the invite screen; soft note to invitee on accept | 🆕 |
| 6 | If rota is offline-first → register `rota_entry` + `service_area` mutation handlers (see [backend-implementation-plan.md WS-A](./backend-implementation-plan.md)) | 🆕 |

**Unchanged / already correct:** custom role create + permission matrix (F1/F2), invite send with
role+shift (F3), accept materializing role mapping + shift + pv bump and **not** checking the device
limit (F4), device-limit gate at `/access` (F5), shift definitions/assignments (F6).

---

## 18. Design decisions

| # | Decision |
|---|---|
| D1 | **Invite = role (+ optional default shift); rota = the scheduler.** Don't couple weekly scheduling to the one-time invite. |
| D2 | **Membership ≠ device slot.** Accept never checks the device limit; gate at store-open with "contact owner". |
| D3 | **Permissions are per-role, not per-person.** No per-user overrides (matches backend + most apps). For a different set, make another role. |
| D4 | **Two scheduling layers:** `shift_assignment` (standing) + `rota_entry` (weekly). |
| D5 | **Rota offline-first (recommended):** model `rota_entry`/`service_area` as sync entities so scheduling works offline; fall back to owner-only REST if simpler for Phase 1. |
| D6 | **Subscription IS checked on accept** (can't join a non-transacting store); device + staff limits are separate. |

---

## 19. Phase 2 — deferred

| Feature | Phase 2 |
|---|---|
| Rota templates | save/apply a weekly pattern (`rota_template` + entries). |
| Availability & time-off | staff set availability; owner schedules around it. |
| Shift swaps / open shifts | staff claim or swap shifts. |
| Clock-in/out + timesheets | tie attendance to `shift_session`. |
| Labour cost on rota | show projected wage cost per day/week. |
| Routes / delivery rota | `route` + `delivery_note` integration for delivery staff. |
| Per-user permission overrides | grant/deny a single action on top of a role (if ever needed). |
| Notify invitee of free device slot | when a slot frees, ping the waiting member (needs push sender). |
