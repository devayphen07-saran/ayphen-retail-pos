# QA Test Cases — Store Roles (`stores/role`)

**Module under test:** `apps/backend/src/stores/role/` (`role.controller.ts`, `role.service.ts`,
`role.repository.ts`, `role.mapper.ts`, `dto/role.dto.ts`, `dto/role.response.ts`)

**Scope:** the store-role *assignment* feature — creating/editing/deleting custom roles within a
store, and assigning/revoking those roles to/from account members. The underlying RBAC permission
*engine* (`common/rbac/*`) is reviewed separately; it is referenced here only where its behavior
directly changes the outcome of a role-assignment test (e.g. cache staleness, escalation checks,
guard order).

Endpoints covered (all under `stores/:storeId/roles`, guard chain
`MobileJwtGuard → TenantGuard → PermissionsGuard → SubscriptionStatusGuard`):

| Method | Path | Permission required |
|---|---|---|
| GET | `/` | `Role.view` |
| GET | `/:roleId` | `Role.view` |
| POST | `/` | `Role.create` |
| PATCH | `/:roleId/permissions` | `Role.edit` |
| DELETE | `/:roleId` | `Role.delete` |
| POST | `/:roleId/assign` | `UserRoleMapping.create` |
| DELETE | `/:roleId/members/:userId` | `UserRoleMapping.delete` |

---

## 1. Feature understanding (BA)

**Actors**
- **Store owner** — holds the immutable, non-editable, non-assignable `STORE_OWNER` system role
  (seeded at store creation with `STORE_OWNER_CRUD`/`STORE_OWNER_SPECIAL`, full `Role` + `UserRoleMapping` CRUD).
- **Custom-role holder with `Role`/`UserRoleMapping` grants** (e.g. a "Manager" role an owner created)
  — can create/edit/delete/assign/revoke roles up to their own grant ceiling.
- **Target user (assignee)** — any user who is a member of the *account* that owns the store
  (`account_users`), not necessarily previously associated with this specific store.
- **System** — `RbacService` (permission cache, version bumps, escalation checks), `AuditService`
  (SOC2 trail), Postgres unique constraints (final race guard).

**Goal:** let a store scope custom, assignable roles (distinct from the three system roles `USER`,
`STORE_OWNER`, `SUPER_ADMIN`) and control which account members hold which role in which store, while
guaranteeing no actor can mint or assign a role broader than their own current permissions.

**Inputs / outputs**
- `POST /` → `{ name, description? }` → `{ id, name }` (201-shaped, but note: no explicit `@HttpCode`,
  defaults to 201 via Nest `POST` convention — see open questions).
- `PATCH /:roleId/permissions` → `{ permissions: [{entity, action}] }` → `204 No Content`.
- `DELETE /:roleId` → `204 No Content`.
- `POST /:roleId/assign` → `{ user_id }` → `204 No Content`.
- `DELETE /:roleId/members/:userId` → `204 No Content`.
- `GET /`, `GET /:roleId` → role list / role + full permission matrix (every `ENTITY_CODE` present,
  defaulted to all-`false` if ungranted).

**Business rules / invariants extracted from code**

- **BR-1 (reserved codes)** — a role name that derives (via `deriveRoleCode`: uppercase,
  non-alnum → `_`) to `USER`, `STORE_OWNER`, or `SUPER_ADMIN` can never be created as a custom role
  (`RoleService.createRole`, backed by DB check `roles_no_reserved_code_when_editable`).
- **BR-2 (name uniqueness per store)** — one role name per store among **non-deleted** roles
  (app pre-check `nameTaken` filters `deletedAt IS NULL`) — but see **Bug-1** below: the DB constraint
  backing it is *not* scoped the same way.
- **BR-3 (system roles are immutable/non-assignable/non-revocable here)** — `STORE_OWNER` (and any
  hypothetical system-wide role) can never be: listed by `listRoles` (filtered out), fetched for edit,
  edited (`isEditable === false` → `ROLE_NOT_EDITABLE`), deleted, assigned (`ROLE_NOT_ASSIGNABLE`), or
  revoked (`ROLE_NOT_REVOCABLE`) through this module.
- **BR-4 (no self-escalation)** — an actor can never grant (`updatePermissions`) or assign
  (`assignRole`) a set of CRUD grants that exceeds their **own current effective permissions** in that
  store. Enforced by re-reading the actor's permissions with the **critical (≤30s)** cache tier, not
  the standard 5-minute tier, specifically so a very recent permission change is honored (H-6 §16).
- **BR-5 (target must be an account member)** — `assignRole` requires
  `isAccountMember(targetUserId, storeId)` — a join of `account_users` to `stores` by `accountFk`.
  Note: **no filter on the target user's `status`/`deletedAt`/`isBlocked`** — see edge cases.
- **BR-6 (no duplicate active assignment)** — a user cannot hold the same role twice concurrently in
  the same store (`assignmentExists` pre-check + `user_role_mappings_uq` DB constraint as backstop).
- **BR-7 (role deletion blocked while it has active members)** — `deleteRole` requires
  `countActiveMembers(roleId) === 0`.
- **BR-8 (unknown entity codes rejected, not dropped)** — `updatePermissions` 422s the whole request
  if any `entity` isn't a real `ENTITY_CODE`, rather than silently applying the valid subset.
- **BR-9 (permission-matrix replace-all semantics)** — `updatePermissions` revokes *all* prior grants
  and re-inserts exactly the submitted set (not a diff/patch) — submitting `[]` strips every grant.
- **BR-10 (cache/version propagation)** — every mutation that changes what a role or a user can do
  bumps `permissionsVersion` for affected members (`bumpPermissionsVersionForRole`) and/or directly
  invalidates the Redis permission cache (`invalidateUserStoreCache` /
  `invalidateRoleMembersCache`), so the effect is visible on the affected user's very next request.
- **BR-11 (soft delete)** — deleting a role sets `deletedAt` on the role and `revokedAt` on all its
  `role_permissions` rows; it does not touch `user_role_mappings` rows (which must already be zero
  per BR-7, absent a race — see Bug-2/Bug-3).
- **BR-12 (write gate)** — all mutations (not reads) are blocked when: the account subscription is
  `paused` (403), `expired` or past `accessValidUntil` (402), the account has a pending downgrade
  reconciliation (403), or the specific store is `locked` (403). Reads (`GET`) are never blocked.
  Guard order means **RBAC (403 permission-denied) is evaluated before subscription state** — an actor
  lacking the route's permission gets 403 even on a fully lapsed/locked store, never 402.

**State machine (per role)**
`(none)` → **created** (`isEditable=true`) → **permissions edited** (repeatable) → **deleted**
(`deletedAt` set, terminal — no undelete endpoint). System roles start and stay in an
"immutable" state outside this machine entirely (never created/deleted via this module).

**State machine (per user-role-mapping / assignment)**
`(none)` → **assigned** (`revokedAt=null`) → **revoked** (`revokedAt` set, terminal *for that row* —
see Bug-1: a *new* row for the same (user, role, store) triple cannot be created afterward even though
the domain intent is clearly "revoke now, allow reassignment later").
`expiresAt` (optional) is read by `RbacService.findActiveRolesForUser` (`expiresAt IS NULL OR
expiresAt > now()`), i.e. an assignment can lapse into an inert state without any explicit revoke —
but nothing in this module surfaces or reaps that state (see edge cases §4).

**Assumptions flagged**
- A1: "Store Roles" here means the custom-role CRUD + assignment surface only; invitation-based
  onboarding (`invitations` table, `insertAssignmentIfAbsent`) is a separate flow and out of scope
  except where it shares the same `user_role_mappings` table/constraints.
- A2: Account ownership (`accounts.ownerUserFk`) is a distinct concept from `STORE_OWNER` role and is
  never mutated by this module — out of scope.
- A3: "Session" for this module means the Redis-cached `EffectivePermissions` + `userStoreIds`, and the
  JWT's `permissionsVersion` (`pv`) claim — there is no separate session table to invalidate; "logging
  a user out on role change" is *not* implemented, only permission re-resolution on next request.
- A4: POST `/` role creation has no `@HttpCode` decorator — assumed to return Nest's default `201`.

---

## 2. Coverage plan

| Dimension | Approx. cases | Notes |
|---|---:|---|
| Happy paths | 8 | One per endpoint + a multi-role-per-user variant |
| Business rules (satisfied + violated) | 16 | BR-1…BR-12, each with a pass + fail case where applicable |
| Boundaries | 10 | Name/description length, permissions array size, role/member counts |
| Negative / invalid | 13 | Bad payloads, unknown entities, non-existent ids, malformed uuids |
| Failure & recovery | 6 | Redis outage degrade paths, audit-in-tx atomicity, unique-violation races |
| Concurrency | 8 | Name race, assign race, **delete-vs-assign race (bug)**, double revoke |
| Permission / role | 10 | Per-actor-role matrix, escalation guard, stale-cache window on assign vs revoke |
| State transitions | 8 | Role lifecycle, assignment lifecycle, **revoke→reassign (bug)** |
| Cross-cutting (tenancy/time/offline) | 10 | Cross-store, cross-account, subscription/lock gating, `expiresAt` lapse |
| UX / response shape | 5 | 204 bodies, full-matrix defaulting, list ordering/cap |

Total: **~94 cases** (IDs below; not every dimension case is enumerated to the same depth — the
Coverage Summary in §5 shows the trace-through).

---

## 3. Test cases

### 3.1 Happy paths (HP)

**HP-01 — Owner creates a custom role**
Area: happy · Criticality: High · Traces to: core create flow
Preconditions: Actor = store owner (or holder of `Role.create`); store active, subscription current.
Input: `POST /stores/{storeId}/roles` body `{ "name": "Head Cashier", "description": "Shift lead" }`.
Steps: 1) Send request. 2) `GET /stores/{storeId}/roles/{id}`.
Expected result: `201` with `{ id, name: "Head Cashier" }`; role persisted with `code="HEAD_CASHIER"`,
`isEditable=true`; permission matrix seeded exactly to `DEFAULT_ROLE_CRUD` (e.g. `Product.view=true`,
`Product.create=false`, `Order.view=true`, `Order.create=true`, `Order.edit=false`, high-risk entities
like `Settings`/`User`/`Subscription`/`Device` all-false); audit log `ROLE_PERMISSION_CHANGED`
"\"Head Cashier\" created".

**HP-02 — List custom roles in a store**
Area: happy · Criticality: Medium · Traces to: `listRoles`
Preconditions: Store has 2 custom roles + the implicit `STORE_OWNER` system role.
Steps: `GET /stores/{storeId}/roles`.
Expected result: exactly the 2 custom roles returned; `STORE_OWNER` is never present in the list.

**HP-03 — Get role detail with full permission matrix**
Area: happy · Criticality: Medium · Traces to: `getRole` / `toDetailResponse`
Preconditions: Role has grants on 3 of the ~28 entity codes.
Steps: `GET /stores/{storeId}/roles/{roleId}`.
Expected result: response `permissions` object contains **every** `ENTITY_CODE` key, the 3 granted
entities show the correct true flags, all others are `{view:false,create:false,edit:false,delete:false}`.

**HP-04 — Edit a custom role's permissions**
Area: happy · Criticality: High · Traces to: BR-9
Preconditions: Actor holds `Role.edit` and at least the grants being assigned; role has 1 existing
member.
Input: `PATCH /:roleId/permissions` body `{"permissions":[{"entity":"Order","action":"view"},
{"entity":"Order","action":"edit"}]}`.
Expected result: `204`; role's grants become exactly `Order.view`+`Order.edit` (all previous grants
gone, including ones not in the request); the 1 member's `permissionsVersion` bumped; member's
Redis permission cache for `(userId, storeId)` invalidated; audit `ROLE_PERMISSION_CHANGED`
"permissions updated (1 members)".

**HP-05 — Delete a role with zero active members**
Area: happy · Criticality: Medium · Traces to: BR-7, BR-11
Steps: `DELETE /:roleId` on a role with no assignments.
Expected result: `204`; `roles.deletedAt` set; all its `role_permissions` rows `revokedAt` set; role
no longer appears in `GET /` or `GET /:roleId` (404 on the latter afterward).

**HP-06 — Assign a custom role to an account member**
Area: happy · Criticality: Critical · Traces to: core assign flow, BR-4, BR-5, BR-6, BR-10
Preconditions: Target user is a member of the store's account, not currently holding this role;
actor's grants ⊇ role's grants.
Input: `POST /:roleId/assign` body `{"user_id":"<target-uuid>"}`.
Expected result: `204`; new `user_role_mappings` row (`revokedAt=null`); target's
`permissionsVersion` bumped; target's `(userId, storeId)` cache and `userStoresKey` invalidated; audit
`ROLE_ASSIGNMENT_CREATED`; target's very next request resolves permissions including this role's
grants (union with any other active role they hold).

**HP-07 — Revoke a user's role assignment**
Area: happy · Criticality: Critical · Traces to: core revoke flow, BR-10
Preconditions: Target actively holds the role.
Steps: `DELETE /:roleId/members/:userId`.
Expected result: `204`; mapping row `revokedAt` set; target's cache invalidated; audit
`ROLE_ASSIGNMENT_REVOKED`; target's next request no longer reflects that role's grants.

**HP-08 — User holds two roles simultaneously in the same store**
Area: happy · Criticality: High · Traces to: OR-union permission resolution
Preconditions: User assigned `Cashier` (default grants) and a custom `Refund-Approver` role (adds
`Payment.edit`).
Steps: Resolve effective permissions.
Expected result: Union of both roles' grants — `Product.view` (from Cashier) AND `Payment.edit` (from
Refund-Approver) both true.

---

### 3.2 Business rules — satisfied & violated (BR)

**BR-01a (satisfied) — Role name that isn't reserved is accepted**
Criticality: High. Input `name: "Inventory Lead"` → derives `INVENTORY_LEAD`. Expected: created fine.

**BR-01b (violated) — Reserved-code collision blocked**
Criticality: Critical · Traces to: BR-1.
Input: `name: "store owner"` (derives to `STORE_OWNER`), or `name: "Super Admin"`, or `name: "user"`.
Expected: `409 ROLE_RESERVED_CODE` "This role name is reserved and cannot be used"; no row inserted.
Notes: also test near-miss casing/punctuation, e.g. `"Store-Owner!!"` → still derives `STORE_OWNER`
(punctuation collapses to `_`, trailing `_` — verify `deriveRoleCode` trim/collapse behavior exactly:
`"Store-Owner!!"` → `STORE_OWNER__` (double underscore) — **confirm whether this equals `STORE_OWNER`
or not**; if `deriveRoleCode` doesn't strip trailing underscores, this near-miss would *not* collide
and would be wrongly allowed to create a role named `"Store-Owner!!"` with code `STORE_OWNER__`,
functionally indistinguishable from the reserved name to a human reading role names in the UI. Flag as
open question (§7).

**BR-02a (satisfied) — Reusing a name after true deletion of an unrelated role in a different store**
Expected: allowed (name uniqueness is per-store).

**BR-02b (violated) — Duplicate name within the same store**
Criticality: High. Two roles named `"Cashier"` in the same store.
Expected: second create → `409 ROLE_ALREADY_EXISTS`.

**BR-03a (satisfied) — Custom role fully editable/assignable/revocable/deletable by an authorized actor.**
Covered by HP-04/05/06/07.

**BR-03b (violated) — Every system-role mutation attempt blocked**
Criticality: Critical · Traces to: BR-3. One case per verb against the store's `STORE_OWNER` role id
(fetch its id via a direct DB read for the test, since `GET /` never lists it):
- `PATCH STORE_OWNER/permissions` → `403 ROLE_NOT_EDITABLE`.
- `DELETE STORE_OWNER` → `403 ROLE_NOT_EDITABLE`.
- `POST STORE_OWNER/assign` → `403 ROLE_NOT_ASSIGNABLE`.
- `DELETE STORE_OWNER/members/{ownerUserId}` → `403 ROLE_NOT_REVOCABLE`.
- `GET STORE_OWNER-id` (direct id, bypassing the list filter) → the current owner **is** returned by
  `findRoleInStore` (it isn't excluded there, only from `listRoles`) — confirm this is intentional:
  `getRole` has no `SYSTEM_ROLE_CODES` guard, so `GET /:roleId` on the owner role id **succeeds** and
  discloses the owner's full permission matrix. Verify this is the intended behavior or a gap (§7).

**BR-04a (satisfied) — Actor grants exactly what they hold**
Actor holds `Order.view+create+edit`; sets role to the same three. Expected: `204`, applied as-is.

**BR-04b (violated) — updatePermissions escalation blocked**
Criticality: Critical · Traces to: BR-4. Actor holds only `Order.view`; request includes
`{"entity":"Order","action":"delete"}`.
Expected: `403 GRANT_EXCEEDS_ACTOR_PERMISSIONS` with `details.grants` listing the offending
`{entity:"Order",action:"delete"}`; **no partial application** (transaction never starts — the check
runs before `uow.execute`).

**BR-04c (violated) — assignRole escalation blocked**
Criticality: Critical. Actor holds `Role.edit`+`UserRoleMapping.create` but not `Payment.edit`; target
role grants `Payment.edit`.
Expected: `403 GRANT_EXCEEDS_ACTOR_PERMISSIONS`; assignment not created; this is the specific
Role.edit + UserRoleMapping.create escalation chain the code comments call out — verify a role with
**zero** grants (a brand-new, ungranted custom role) IS assignable by anyone with base
`UserRoleMapping.create` (empty `beyondActor` trivially passes) — **BR-04d (satisfied, degenerate case)**.

**BR-05a (satisfied) — Target is an account member**
Expected: assignment proceeds (see HP-06).

**BR-05b (violated) — Target belongs to a different account entirely**
Criticality: Critical · Traces to: tenancy. `user_id` = a real user, but not in `account_users` for
this store's account.
Expected: `403 USER_NOT_STORE_MEMBER`; no cross-account disclosure beyond the boolean gate (response
carries no account details).

**BR-06a (satisfied) — Reassigning a previously-revoked user (fresh row expected)**
See Bug-1 (§4) — expected-per-domain-intent result vs actual are different; documented as a defect,
not a normal BR case.

**BR-06b (violated) — Double-assign the same active mapping**
Criticality: High. User already actively holds the role; assign again.
Expected: `409 ASSIGNMENT_ALREADY_EXISTS`; pre-check path (not a race) — no DB round trip to the
unique-violation catch needed.

**BR-07a (satisfied) — Delete a role after revoking its last member**
Steps: revoke the sole member, then delete. Expected: `204`.

**BR-07b (violated) — Delete a role that still has an active member**
Criticality: High. Expected: `409 ROLE_HAS_ACTIVE_ASSIGNMENTS`; role NOT soft-deleted.

**BR-08a (satisfied) — All submitted entity codes valid**
Covered by HP-04.

**BR-08b (violated) — Unknown entity code rejected wholesale**
Criticality: High. `permissions: [{"entity":"Order","action":"view"},{"entity":"Widgetz","action":"view"}]`.
Expected: `422 INVALID_ENTITY_CODE`, `details.entities: ["Widgetz"]`; **the valid `Order.view` entry is
also NOT applied** — confirm the whole request is atomic-rejected (it is, since the check runs before
`uow.execute`).

**BR-09 (replace-all semantics) — Submitting an empty permissions array strips all grants**
Criticality: High. Role currently has 5 grants; `PATCH` with `{"permissions":[]}`.
Expected: `204`; role ends with **zero** active grants; all 5 prior `role_permissions` rows have
`revokedAt` set; members' cache/version bumped (they now effectively lose everything that role gave
them, unless another concurrently-held role covers it).

**BR-10 (version/cache propagation observable end-to-end)**
Criticality: Critical. See CC-06/PM-04 below for the concrete stale-cache timing cases.

**BR-11 (soft delete leaves grants revoked, not deleted)**
Criticality: Medium. After HP-05, directly inspect `role_permissions` rows for that role: all have
`revokedAt` set (not physically deleted) — audit-trail preservation.

**BR-12a (satisfied) — Mutation allowed on active, unlocked, subscribed store**
Covered throughout HP-*.

**BR-12b (violated) — Mutation blocked on suspended subscription**
Criticality: Critical · Traces to: BR-12. Account subscription `status='paused'`.
Steps: `POST /:roleId/assign` (actor otherwise fully authorized).
Expected: `403 SUBSCRIPTION_SUSPENDED`; `GET /` still works (reads unaffected).

**BR-12c (violated) — Mutation blocked on expired subscription**
Criticality: Critical. `status='expired'` or `accessValidUntil` in the past.
Expected: `402 SUBSCRIPTION_PAYMENT_REQUIRED`.

**BR-12d (violated) — Mutation blocked on pending downgrade reconciliation**
Criticality: High. `accountSubscriptions.reconciliationStatus='pending'`.
Expected: `403 SUBSCRIPTION_RECONCILIATION_REQUIRED`, even though the specific store isn't itself
locked.

**BR-12e (violated) — Mutation blocked on a locked store**
Criticality: High. `stores.locked=true` (e.g. downgrade excess-store lock), account subscription
otherwise fine.
Expected: `403 STORE_LOCKED`; `GET /` on that same store still works.

**BR-12f (precedence) — RBAC denial takes priority over subscription block**
Criticality: High · Traces to: guard order. Actor lacks `UserRoleMapping.create` AND the account
subscription is expired.
Expected: `403` from `PermissionsGuard` (generic RBAC-denied shape), **not** `402
SUBSCRIPTION_PAYMENT_REQUIRED` — guard order is Tenant → Permissions → SubscriptionStatus.

---

### 3.3 Boundaries (BD)

**BD-01 — Role name at min length (1 char)**
`name: "A"`. Expected: `201`, accepted (schema `min(1)`).

**BD-02 — Role name at max length (100 chars)**
`name` exactly 100 chars. Expected: `201`, accepted.

**BD-03 — Role name over max length (101 chars)**
Expected: `422` (Zod `max(100)` violation, `VALIDATION_FAILED`).

**BD-04 — Empty role name**
`name: ""`. Expected: `422` (`min(1)` violation).

**BD-05 — Description at max length (500 chars)**
Expected: `201`, accepted.

**BD-06 — Description over max (501 chars)**
Expected: `422`.

**BD-07 — Description omitted (optional field)**
`{ "name": "Stock Clerk" }` (no `description`). Expected: `201`; stored `description = null`
(service does `dto.description ?? null`).

**BD-08 — Permissions array at max (200 entries)**
200 distinct valid `{entity,action}` pairs (fewer than 28 entities × 4 actions = 112 possible distinct
pairs, so 200 is actually **unreachable without duplicates** — see BD-09).
Expected: schema-level, 200 unique pairs would pass Zod; but only ~112 unique (entity,action)
combinations exist in the real matrix, so this boundary is more theoretical — note as an open question
whether `.max(200)` should instead be bounded by `ENTITY_CODES.length * CRUD_ACTIONS.length`.

**BD-09 — Permissions array over max (201 entries)**
Expected: `422` (Zod `max(200)`).

**BD-10 — Zero-role store (fresh store, no custom roles yet)**
`GET /stores/{storeId}/roles` right after store creation.
Expected: `200` with `[]` (only the hidden `STORE_OWNER` exists, filtered out).

**BD-11 — Store with 500+ custom roles (repository cap)**
Criticality: Low. `listStoreRoles` has `.limit(500)` and **no `ORDER BY`**.
Expected (current behavior): only 500 of >500 roles returned, in Postgres's undefined natural order —
no pagination, no indication to the client that more exist, and the specific 500 returned/their order
is not guaranteed stable across calls. Flag as a real (if low-likelihood) UX/correctness gap (§4/§7).

---

### 3.4 Negative / invalid (NG)

**NG-01 — Non-existent roleId (valid UUID, no such row)**
`GET /:roleId` with a random UUID. Expected: `404 ROLE_NOT_FOUND`.

**NG-02 — roleId belongs to a different store**
Role exists, but under `storeId2`; request path uses `storeId1`.
Expected: `404 ROLE_NOT_FOUND` (repository query ANDs `roleId` + `storeId` — cross-store id reuse is
indistinguishable from not-found, correctly avoiding leaking role existence across tenants).

**NG-03 — Malformed (non-UUID) `roleId`/`userId` path params**
`GET /stores/{storeId}/roles/not-a-uuid`.
Expected: `400 Bad Request` from `ParseUUIDPipe` (runs during Nest's pipe phase on the handler's own
params, independent of guard order).

**NG-04 — Malformed (non-UUID) `storeId` path param**
`GET /stores/not-a-uuid/roles`.
Expected: `404 STORE_NOT_ACCESSIBLE` — **not** `400`. `TenantGuard` reads `storeId` as a raw string
directly off `req.params` (not through `ParseUUIDPipe`, which only runs later in the pipe phase) and
short-circuits via `accessibleIds.includes(raw)`, which is trivially false for a non-UUID string, so it
never reaches the pipe or a DB type-cast error. Confirm test asserts `404` with the tenant error, since
a naive tester would expect `400`.

**NG-05 — `assign` with a non-UUID `user_id` in the body**
Input: `{"user_id":"abc"}`. Expected: `422 VALIDATION_FAILED` (Zod `.uuid()` on `user_id`).

**NG-06 — `assign`/create with missing required field**
`{}` body to `POST /` (missing `name`), or `{}` to `assign` (missing `user_id`).
Expected: `422 VALIDATION_FAILED` listing the missing field.

**NG-07 — Wrong types in body**
`{"name": 123}`, `{"permissions": "not-an-array"}`, `{"permissions":[{"entity":123,"action":"view"}]}`.
Expected: `422 VALIDATION_FAILED` in all cases.

**NG-08 — Invalid `action` enum value**
`{"permissions":[{"entity":"Order","action":"archive"}]}` (not one of `view/create/edit/delete`).
Expected: `422 VALIDATION_FAILED` (Zod enum rejection) — never reaches the service's own
`INVALID_ENTITY_CODE` check.

**NG-09 — Assign a user who doesn't exist at all**
`user_id` = a syntactically valid but unassigned/never-created UUID.
Expected: `403 USER_NOT_STORE_MEMBER` (join finds nothing) — same response as a real user who just
isn't a member, avoiding user-existence enumeration.

**NG-10 — Revoke an assignment that was never made**
`DELETE /:roleId/members/:userId` where the user never held this role.
Expected: `404 ASSIGNMENT_NOT_FOUND`.

**NG-11 — Revoke an already-revoked assignment (double revoke)**
Revoke once (succeeds), revoke again immediately.
Expected: second call → `404 ASSIGNMENT_NOT_FOUND` (`revokeAssignment`'s `WHERE revokedAt IS NULL`
matches zero rows the second time) — not idempotent-204, an explicit not-found.

**NG-12 — Duplicate `{entity,action}` pairs within one `updatePermissions` request**
Criticality: High (real defect) · Traces to: BR-8/BR-9.
Input: `{"permissions":[{"entity":"Order","action":"view"},{"entity":"Order","action":"view"}]}`
(same pair twice — passes Zod, `.max(200)` allows duplicates, no dedup in `RoleService.updatePermissions`).
Expected (per BR-8/graceful-validation intent): either a clean `422` rejecting the duplicate, or silent
dedup and success. **Actual (code-traced):** `revokeAllCrud` runs, then `insertCrud` issues a single
multi-row `INSERT INTO role_permissions (...) VALUES (...), (...)` with two identical
`(roleFk, entityCode, action)` tuples, violating `role_permissions_role_entity_action_uq` **within the
same statement** — this is not routed through `rethrowUniqueViolationAs` (only `createRole`'s and
`assignRole`'s inserts are), so it surfaces as an **unhandled Postgres unique-violation → uncaught
exception → 500** to the client, while the transaction rolls back (previous grants already revoked in
the same tx, so the rollback is at least atomic — no partial/corrupt state persists, just a bad error
surface). **File a bug**; see §4/§7.

**NG-13 — Unicode / emoji / RTL / whitespace in role name**
`name: "  Caissière 🧾 مدير  "` (leading/trailing spaces, accents, emoji, RTL script).
Expected: accepted (Zod only checks length, no charset restriction); `deriveRoleCode` uppercases and
replaces every non-`[A-Z0-9]` character (including all the unicode/emoji/space) with `_`, so the
derived `code` collapses to something like `_CAISSI_RE___` — confirm this doesn't accidentally collide
with a reserved code or with another role's derived code in the same store (two visually-different
unicode names could theoretically derive to the *same* `code`, which is fine since `code` has no
uniqueness constraint of its own beyond the reserved-code check and the system-role-per-store unique
index — but flag as worth confirming `code` collisions between two custom roles in the same store are
truly harmless, since consumers may key off `code` elsewhere).

---

### 3.5 Failure & recovery (FR)

**FR-01 — Redis unavailable during `getCachedPermissions` (escalation check)**
Criticality: High. Actor calls `assignRole`; Redis is down when `rbac.getCachedPermissions(actorId,
storeId, true)` runs.
Expected: degrades to DB (`resolveFromDb`) per `RbacService`'s documented fall-through — request still
succeeds/fails correctly on the actual escalation rule, just slower; no 500 from a Redis error leaking
through.

**FR-02 — Redis unavailable during cache invalidation after a successful assign/revoke**
Criticality: Medium. `invalidateUserStoreCache`/`invalidateRoleMembersCache` Redis `DEL` fails.
Expected (code-traced): **not caught** in `RoleService` — `invalidateUserStoreCache` is `await`ed with
no try/catch around it in `assignRole`/`revokeRole`/`updatePermissions`, unlike `getCachedPermissions`
and the cache-fill paths inside `RbacService`, which are wrapped. If Redis throws here, the whole
request fails with `500` **after the DB transaction already committed** — the assignment/revocation is
durably persisted, but the client sees an error and the actor's stale cached permissions may persist up
to the TTL. Flag as a real gap: a transient Redis blip on invalidation turns a successful mutation into
an apparent failure, and the affected user's permission cache is *not* guaranteed fresh despite the
"invalidate immediately" intent. (§4/§7)

**FR-03 — Audit insert fails mid-transaction**
Criticality: Medium. Simulate an `auditLogs` insert failure inside `logInTransaction` (e.g. a DB
constraint or connectivity blip) during `assignRole`.
Expected: whole transaction rolls back — no `user_role_mappings` row persisted, no partial state
(`logInTransaction` runs on the same `tx` as the domain writes) — correct fail-closed behavior.

**FR-04 — Concurrent identical `createRole` calls (name race)**
Covered in CC-01.

**FR-05 — Concurrent identical `assignRole` calls (assignment race)**
Covered in CC-02.

**FR-06 — DB connection drop mid-`updatePermissions` transaction**
Criticality: Medium. Kill the connection between `revokeAllCrud` and `insertCrud`.
Expected: transaction rolls back atomically — role retains its **original** grant set (not
zero-grants, not the new set); no member cache/version bump occurs (that also happens inside the same
tx, after inserts).

---

### 3.6 Concurrency (CC)

**CC-01 — Two actors create a role with the same name simultaneously**
Criticality: High · Traces to: BR-2. Both requests pass the `nameTaken` pre-check (TOCTOU window)
before either commits.
Expected: one succeeds (`201`); the other's insert hits `roles_store_name_uq`, caught by
`rethrowUniqueViolationAs`, surfaced as `409 ROLE_ALREADY_EXISTS` — same client-facing shape as the
non-racy case (BR-02b).

**CC-02 — Two actors assign the same user to the same role simultaneously**
Criticality: High · Traces to: BR-6. Both pass `assignmentExists` before either commits.
Expected: one succeeds; the other hits `user_role_mappings_uq`, caught, surfaced as `409
ASSIGNMENT_ALREADY_EXISTS`.

**CC-03 — Delete-vs-assign race on the same role (defect)**
Criticality: **Critical** · Traces to: BR-7. Actor A calls `DELETE /:roleId` right as Actor B calls
`POST /:roleId/assign` for a user, timed so B's `insertAssignment` commits *after* A's
`countActiveMembers()` returned 0 but *before* A's `softDeleteRole` transaction commits (no row lock is
taken on the role during either operation — `countActiveMembers` and `softDeleteRole` run in separate,
unlocked queries).
Expected (per BR-7's intent — "never delete a role with active members"): either A's delete should
fail once B's assignment lands, or B's assignment should fail once the role is gone.
**Actual (code-traced):** both can succeed — the role ends up `deletedAt` set (invisible in
`listRoles`/`getRole`) **while an active (`revokedAt=null`) `user_role_mappings` row still points at
it.** The dangling assignment grants no permissions in practice (`findActiveRolesForUser` joins
`roles` and requires `isNull(roles.deletedAt)`), but: (a) it's a silent invariant violation (BR-7 says
this state should be unreachable), (b) the user now occupies a `(userFk, roleFk, storeFk)` slot that
can never be revoked cleanly through the normal UI (the role doesn't appear in any list to drive a
revoke action, though the raw `DELETE /:roleId/members/:userId` route would still work if the caller
somehow knew the ids), and (c) it pollutes audit/reporting ("active assignment count" queries elsewhere
that don't join through `roles.deletedAt` would overcount). **File a bug** — recommend a `SELECT ...
FOR UPDATE` on the role row (or re-checking `countActiveMembers` inside the same transaction as
`softDeleteRole`) to close the window. (§4/§7)

**CC-04 — Revoke-then-immediately-reassign by two different actors**
Criticality: High. Actor A revokes user X's role; Actor B, unaware, immediately tries to assign the
same role to X again.
Expected (per Bug-1 below): B's assign fails with `409 ASSIGNMENT_ALREADY_EXISTS` even though X
currently holds **no active** grant from that role — because the DB unique index isn't scoped to
`revokedAt IS NULL`. Confusing/incorrect from B's point of view (message implies X is already assigned,
when in fact they're specifically *not*). Same root cause as Bug-1; documented once there, referenced
here as the concurrency-flavored manifestation.

**CC-05 — Concurrent `updatePermissions` calls on the same role by two authorized actors**
Criticality: Medium. Actor A submits `[Order.view]`; Actor B (racing) submits `[Product.view,
Product.edit]`.
Expected: last-committed-wins (both use `revokeAllCrud` + `insertCrud`, no optimistic lock/version
check on the role itself) — whichever transaction commits last determines the final grant set; the
other's changes are silently overwritten (not merged). This is "correct" in the sense that it's the
documented replace-all semantics (BR-9), but worth confirming product accepts last-write-wins with no
conflict signal to the losing actor (they get `204` success even though their change was clobbered).

**CC-06 — Actor's own `UserRoleMapping.create` permission revoked mid-session, then they assign**
Criticality: Critical · Traces to: BR-4/BR-10 staleness window. Actor's `UserRoleMapping.create` grant
is revoked by an owner at T0. `PermissionsGuard`'s route-level check for the `assign` endpoint uses
`isCritical = (action==='delete')` → **`assign`'s action is `create`, so it is NOT critical**, meaning
`PermissionsGuard` may serve the actor's cached permissions for up to the **standard 5-minute TTL**.
At T0+2min (within the stale window, cache not yet invalidated on the actor unless the revoker's own
`updatePermissions`/revoke call happened to invalidate *this* actor specifically), actor calls
`POST /:roleId/assign`.
Expected (per BR-4 intent — no action should be possible once the underlying permission is gone):
route-level check should reject. **Actual (code-traced):** if the actor's own permission cache entry
is still within its 5-minute window (and wasn't specifically busted — cache busting on a version
mismatch does run per-request via `bustCacheOnVersionMismatch`, *but only if the actor's own JWT `pv`
is stale relative to their current `permissionsVersion`*, which requires the revoking action to have
bumped **this actor's own** version, not just the target's), the `PermissionsGuard.enforceCrud` check
can pass on stale data, and only the *inner* escalation check (`GRANT_EXCEEDS_ACTOR_PERMISSIONS`, which
re-reads with the **critical/30s** tier) is guaranteed fresh — and that check only bounds *what* they
can assign, not *whether* they may call the endpoint at all. Net effect: a small window
(up to ~5 minutes, or immediately if `pv` was bumped) where UI/route access and the fine-grained
grant-ceiling check are on different freshness tiers. Recommend re-verifying: is `assign` supposed to be
critical too (mirroring `revoke`, which correctly uses the `delete`-action critical path)? Flag as an
open question — likely worth marking `UserRoleMapping.create` critical or accepting the documented
staleness window explicitly. (§4/§7)

**CC-07 — Self-revoke of an actor's own only role assignment**
Criticality: High. A non-owner actor holding a single custom role (not `STORE_OWNER`) with
`UserRoleMapping.delete` on themselves revokes their own assignment (`targetUserId === actorId`).
Expected (code-traced, no special-case guard exists): `204` succeeds; actor's cache is invalidated
immediately; their **very next request** to this store resolves to `emptyPermissions()` — effectively
instant self-lockout mid-session, with no confirmation/warning at the API layer. Confirm product intent
— is a "you are about to remove your own access" guard expected? (§7)

**CC-08 — Owner revokes the sole holder of the only role granting `Role`/`UserRoleMapping` permissions (non-owner admin lockout)**
Criticality: Medium (bounded by BR-3 — `STORE_OWNER` is permanent and unrevocable, so the store itself
can never be fully lockout-proof-broken via this module) but still worth testing: revoke the last
custom "Admin" role holder who isn't the owner. Expected: succeeds; store is not orphaned because
`STORE_OWNER` always retains full `Role`+`UserRoleMapping` grants — confirms the invariant holds, no
actual lockout, **as long as the owner's own account/session remains usable** (out of scope: what
happens if the owner's user account itself is suspended — that's an auth-module concern).

---

### 3.7 Permission / role cases (PM)

**PM-01 — `Role.view` required for list/get; blocked without it**
Actor has no `Role.view` grant. `GET /` / `GET /:roleId` → `403` (generic RBAC-denied, from
`PermissionsGuard`, audited as `PERMISSION_DENIED`/`ROLE_PERMISSION_CHANGED`-adjacent denial log per
rbac.md §20 — verify via the shared RBAC audit trail, not this module).

**PM-02 — `Role.create` required for create; blocked without it**
Actor has `Role.view` but not `Role.create`. `POST /` → `403`.

**PM-03 — `Role.edit` required for `updatePermissions`; blocked without it**
Actor has `Role.view`+`Role.create` but not `Role.edit`. `PATCH /:roleId/permissions` → `403`.

**PM-04 — `Role.delete` required for delete; blocked without it, and this path IS critical-cache-fresh**
Actor's `Role.delete` was revoked 10 seconds ago. `DELETE /:roleId` → `403`, and because `delete` is
always critical in `computeCriticality`, this is guaranteed fresh (≤30s cache) — contrast with
CC-06's `assign` staleness gap.

**PM-05 — `UserRoleMapping.create` required for assign; blocked without it**
`POST /:roleId/assign` → `403`.

**PM-06 — `UserRoleMapping.delete` required for revoke; blocked without it, critical-fresh**
`DELETE /:roleId/members/:userId` → `403`, fresh-checked (delete action).

**PM-07 — Store owner can perform every action in this module**
Owner (via `STORE_OWNER_CRUD` full `Role`+`UserRoleMapping`) successfully creates, edits, deletes,
assigns, revokes. Expected: all succeed (bounded only by BR-1/BR-2/BR-3/BR-6/BR-7, never by BR-4 since
owner's grants are the ceiling).

**PM-08 — Custom role holder with partial `Role`/`UserRoleMapping` grants (e.g. `view`+`create` only, no `edit`/`delete`)**
Expected: can list/create/assign but `403` on edit/delete/revoke — each independently gated.

**PM-09 — Permission removed mid-flow (between list and act)**
Actor lists roles (sees role X), then their `Role.edit` is revoked by someone else, then they submit
`PATCH X/permissions`. Expected: `403` on the `PATCH` (assuming cache freshness — `edit` action is not
in `computeCriticality`'s critical set either, since only `delete` and critical specials are critical —
**so `Role.edit` and `Role.create` and `UserRoleMapping.create` all share the same up-to-5-minute
staleness window as CC-06**; only `delete`-flavored actions (`Role.delete`,
`UserRoleMapping.delete`) are guaranteed fresh). Cross-reference CC-06.

**PM-10 — Cross-store actor (has a role in store A, tries to manage roles in store B)**
Actor has no role/grants in store B at all. `TenantGuard` itself will 404
(`STORE_NOT_ACCESSIBLE`) before `PermissionsGuard` is reached, since `userStoreIds` won't include store
B. Expected: `404`, not `403` — access-list gating happens before permission gating.

---

### 3.8 State transitions (ST)

**ST-01 — Role: (none) → created**
Covered by HP-01. Legal.

**ST-02 — Role: created → permissions edited → edited again**
Covered by HP-04, repeatable indefinitely. Legal.

**ST-03 — Role: created → deleted**
Covered by HP-05. Legal, terminal.

**ST-04 — Role: deleted → edit attempt (illegal)**
`PATCH` on a role whose `deletedAt` is set. Expected: `404 ROLE_NOT_FOUND` (`findRoleInStore` filters
`isNull(deletedAt)`) — not `403 ROLE_NOT_EDITABLE`; deletion makes the role invisible entirely, a
distinct error from "exists but not editable."

**ST-05 — Role: deleted → assign attempt (illegal)**
`POST /:roleId/assign` on a deleted role id. Expected: `404 ROLE_NOT_FOUND`.

**ST-06 — Role: deleted → delete again (illegal, idempotency check)**
`DELETE` the same role twice. Expected: second call → `404 ROLE_NOT_FOUND` (not a `204` idempotent
no-op) — confirms delete is not idempotent at the API level, consistent with soft-delete-then-invisible
semantics.

**ST-07 — Role: deleted → recreate with the exact same name (defect)**
Criticality: **Critical** (real defect) · Traces to: BR-2/BR-11.
Steps: 1) Create role "Cashier". 2) Revoke all its members, delete it (`204`). 3) Create a **new** role
also named "Cashier" in the same store.
Expected (per BR-2's stated scope — "one role name per store **among non-deleted roles**" — and the
app-level `nameTaken` pre-check, which explicitly filters `isNull(deletedAt)` and would return `false`,
letting the request past that check): step 3 should succeed with a fresh role.
**Actual (code-traced):** `roles_store_name_uq` is `UNIQUE(store_fk, name)` in
`drizzle/0002_breezy_mad_thinker.sql` / `schema.ts` **with no `WHERE deletedAt IS NULL` predicate** —
so even though the app pre-check (`nameTaken`) says the name is free, the real insert hits the DB
constraint and is caught by `rethrowUniqueViolationAs`, returning `409 ROLE_ALREADY_EXISTS` — **a role
name can never be reused in a store once its original holder is deleted, permanently**, contradicting
the documented/coded intent. Same shape of bug independently affects `deriveRoleCode` collisions with a
never-deleted role of a different display name that happens to derive the same `code` — not blocked at
all today since `code` carries no uniqueness constraint among custom roles, only compounding the
confusion around what "the same role" even means. **File as a Critical bug** — recommend adding
`.where(sql`deleted_at IS NULL`)` to `roles_store_name_uq` (mirroring how `invitations`' partial unique
indexes are already done correctly in the same file) and a migration to backfill/repair. (§4/§7)

**ST-08 — Assignment: (none) → assigned → revoked → reassign attempt (defect)**
Criticality: **Critical** (real defect, the assignment-side twin of ST-07) · Traces to: BR-6.
Steps: 1) Assign role R to user U (`204`). 2) Revoke it (`204`). 3) Assign role R to user U again.
Expected (per the domain model — `revokedAt` existing as a soft-delete column, and
`assignmentExists`'s pre-check explicitly filtering `isNull(revokedAt)` so it returns `false` and lets
step 3 proceed): step 3 should succeed, creating a fresh active mapping (e.g. "rehire a returning
cashier, reassign their old role").
**Actual (code-traced):** `user_role_mappings_uq` is `UNIQUE(user_fk, role_fk, store_fk)` in both
`schema.ts` and `drizzle/0002_breezy_mad_thinker.sql`, **with no partial predicate on `revokedAt IS
NULL`** — the insert in step 3 collides with the *revoked* row from step 1 at the DB level, is caught
by `rethrowUniqueViolationAs`, and returns `409 ASSIGNMENT_ALREADY_EXISTS` — even though the user
holds **zero** active grants from this role right now. **This permanently blocks re-assigning the same
(user, role) pair in the same store, ever, after a single revoke** — a materially broken real-world
workflow (temporary leave, role rotation, probation-then-reinstate, etc.). **File as a Critical bug** —
same fix shape as ST-07: scope the unique index to `WHERE revoked_at IS NULL`. (§4/§7)

**ST-09 — Assignment: `expiresAt` lapses without an explicit revoke**
Criticality: Medium. Assign a role with `expiresAt` set in the past (note: this module's `assignRole`
never accepts/sets `expiresAt` — it's only settable by some other path, e.g. invitations or a future
admin tool — but the column is read by `RbacService.findActiveRolesForUser`).
Expected: once `expiresAt` passes, the role stops contributing to effective permissions
(`expiresAt IS NULL OR expiresAt > now()` filter) — but `countActiveMembers` (used by `deleteRole`)
does **not** filter on `expiresAt`, only `revokedAt` — so a role whose only "member" has a lapsed
`expiresAt` (but no `revokedAt`) is still reported as having an active member and **cannot be deleted**,
even though it grants nothing anymore. Flag as an inconsistency between "active" as used for
permission-resolution vs. "active" as used for the deletion guard. (§4/§7)

---

## 4. Edge-case scenarios (§5 checklist)

**EC-01 (empty/zero) — Store with zero custom roles** → BD-10.

**EC-02 (empty/zero) — Role with zero grants assigned to someone** → BR-04d; permission matrix in
`GET /:roleId` shows all-false; user effectively gains nothing but the assignment itself is valid and
listed.

**EC-03 (first-run) — First role ever created in a brand-new store** → HP-01, immediately after store
creation (only `STORE_OWNER` exists beforehand); confirm `roles_one_owner_per_store_uq` doesn't
interfere with unrelated custom-role inserts.

**EC-04 (max/overflow) — Store with 500+ roles** → BD-11 (list cap silently truncates, no order
guarantee).

**EC-05 (max/overflow) — `updatePermissions` with 200 entries incl. duplicates** → NG-12 (crashes
instead of validating).

**EC-06 (duplicate/repeat) — Duplicate submission of the exact same `assign` request (double-tap)**
Client retries a timed-out `assign` call that actually succeeded server-side.
Expected: retry → `409 ASSIGNMENT_ALREADY_EXISTS` — safe (not a double-apply), but surfaces as a
user-facing "already assigned" error the client should treat as success-equivalent, not a failure to
retry further. Verify client-side handling expectation (§7).

**EC-07 (duplicate/repeat) — Re-doing a "done" action: revoke then reassign** → ST-08 (defect).

**EC-08 (out-of-order) — Revoke arrives at the server before the corresponding assign (client
retried out of order over a flaky connection)**
`DELETE /:roleId/members/:userId` when no assignment exists yet. Expected: `404
ASSIGNMENT_NOT_FOUND` — correct, no crash, but the client must handle this as "nothing to revoke," not
retry indefinitely.

**EC-09 (concurrent identical) — Two devices assign the same user to the same role at the same instant**
→ CC-02.

**EC-10 (permission/subscription change mid-flow) — Actor's grant revoked between opening the "assign
role" screen and submitting** → CC-06/PM-09 (up to 5-minute staleness on non-delete actions).

**EC-11 (permission change mid-flow) — Target's account membership revoked between listing them as
assignable and the assign call landing**
Owner removes user X from the account (`account_users` row deleted) after the client fetched a
member-picker list, then submits `assign` for X.
Expected: `403 USER_NOT_STORE_MEMBER` at the time of the actual request (fresh join, not cached) —
correct fail-closed behavior, no case needed beyond confirming freshness.

**EC-12 (abandonment) — Client abandons after `createRole` succeeds but before rendering confirmation
(role exists, no permission-edit ever done)**
Expected: role persists with only `DEFAULT_ROLE_CRUD` seeded — this is a legitimate, stable end state,
not a partial/corrupt one; re-opening the role later shows the defaults correctly.

**EC-13 (long/unusual input) — Very long unicode role name at the 100-char boundary with multi-byte
characters** — combine BD-02 with NG-13: confirm length is measured in JS string length (UTF-16 code
units) not bytes/grapheme clusters — a 100-emoji name may be rejected or truncated unexpectedly
depending on how surrogate pairs count against `.max(100)`. Verify Zod's `.max()` semantics here (likely
`.length`, i.e. UTF-16 units — emoji using surrogate pairs count as 2). Flag as worth an explicit test
with a name built from 51 four-byte emoji (102 UTF-16 units) to confirm it's rejected as intended (over
limit) rather than accidentally accepted.

**EC-14 (state edge) — Acting on a role that was deleted since the client's list was loaded (stale
client cache)**
Client shows role X (loaded 2 minutes ago); role X was deleted 1 minute ago by someone else; client
submits `PATCH X/permissions`. Expected: `404 ROLE_NOT_FOUND` — client must handle by refreshing its
list, not showing a generic error.

**EC-15 (state edge) — Target user status changed since being made "assignable" (blocked/suspended/soft-deleted account, but still an `account_users` member)**
Criticality: High (real gap) · Traces to: BR-5.
Preconditions: target user `users.status='suspended'`, or `isBlocked=true`, or `deletedAt` set (soft
deleted), but their `account_users` row was never removed.
Steps: `assignRole` for this user.
Expected (arguably): should be blocked — assigning a role to a suspended/blocked/deleted user account
is meaningless/risky.
**Actual (code-traced):** `isAccountMember` only checks the `account_users`⋈`stores` join by
`accountFk`/`userFk` — **it never inspects `users.status`, `isBlocked`, or `deletedAt`.** The assignment
succeeds. The user simply can't log in to use it (a separate auth-layer gate), but the assignment/audit
trail and any staff-listing UI would show a role held by a blocked/deleted user, which is confusing and
inconsistent with how deletion is handled everywhere else in this module (deleted *roles* are
carefully filtered everywhere; deleted/blocked *users* are not, for this one check). Flag as a gap to
confirm with product — likely wants `isAccountMember` to also require an active user status. (§7)

**EC-16 (time) — `expiresAt`-bearing assignment straddling a timezone/DST boundary**
Criticality: Low (this module doesn't set `expiresAt` itself, but inherits the column's semantics from
whatever does). Expected: `gt(userRoleMappings.expiresAt, now())` is a plain UTC timestamp comparison
(`timestamp with time zone` column) — DST/timezone-safe by construction; no separate case needed beyond
confirming the column really is `withTimezone: true` (it is, per schema).

**EC-17 (connectivity) — Client goes offline mid-`assign`, request never reaches the server, client
retries on reconnect**
Expected: safe — no state changed until a request actually lands; retry behaves like a normal first
attempt (`204`).

**EC-18 (device/platform) — Response shape stability for `204 No Content` endpo001**
`assign`/`revoke`/`updatePermissions`/`delete` all return `204` with **no body** — confirm client
doesn't attempt to parse a JSON body on these (a common client-side crash source when a client
optimistically expects `{success:true}`); pure API-contract check, not a server bug.

---

## 5. Coverage summary

| Requirement / rule / transition | Satisfied case(s) | Violated / illegal case(s) | Gap? |
|---|---|---|---|
| BR-1 Reserved role code blocked | BR-01a | BR-01b | Near-miss punctuation collision unresolved — see open question |
| BR-2 Name unique per store (non-deleted) | BR-02a, CC-01 | BR-02b | **Bug (ST-07): DB constraint not scoped to non-deleted, contradicts app pre-check** |
| BR-3 System roles immutable/non-assignable/non-revocable | PM-07 (owner has full access via its own grants, not bypass) | BR-03b (5 sub-cases) | `GET /:roleId` on owner role id not blocked — confirm intent |
| BR-4 No self-escalation (edit) | BR-04a | BR-04b | none found |
| BR-4 No self-escalation (assign) | BR-04c/d | BR-04c | **Staleness gap (CC-06): route-level check not on critical tier for `create` actions** |
| BR-5 Target must be account member | BR-05a, HP-06 | BR-05b | **Gap (EC-15): blocked/suspended/deleted user still assignable** |
| BR-6 No duplicate active assignment | HP-06 | BR-06b, CC-02 | **Bug (ST-08): revoked assignment can never be recreated** |
| BR-7 Delete blocked while active members exist | HP-05, BR-07a | BR-07b | **Race (CC-03): delete/assign not mutually locked**; **inconsistency (ST-09): `expiresAt` lapse not treated as inactive for this check** |
| BR-8 Unknown entity codes rejected wholesale | BR-08a | BR-08b | none found |
| BR-9 Replace-all permission semantics | HP-04, BR-09 | — (not a pass/fail rule, a semantics confirmation) | Concurrent last-write-wins with no conflict signal (CC-05) — confirm accepted |
| BR-10 Cache/version propagation on mutation | HP-04/06/07 | FR-02 (invalidation failure not caught) | **Gap (FR-02): uncaught Redis error on invalidation surfaces as 500 post-commit** |
| BR-11 Soft delete preserves grant history | BR-11 | — | none found |
| BR-12 Write-gate (subscription/lock) | BR-12a | BR-12b/c/d/e, BR-12f (precedence) | none found beyond precedence documented |
| Role state: created→edited→deleted | ST-01/02/03 | ST-04/05/06 (act-on-deleted) | none found |
| Role state: deleted→recreate same name | — | ST-07 | **Bug — see above** |
| Assignment state: assign→revoke→reassign | HP-06/07 | ST-08 | **Bug — see above** |
| Assignment state: revoke without prior assign | — | NG-10 | none found |
| Assignment state: double revoke | — | NG-11 | none found |
| Tenancy: cross-store role id | — | NG-02 | none found |
| Tenancy: cross-account target user | — | BR-05b | none found |
| Tenancy: cross-store actor (no access) | — | PM-10 | none found |
| Permission gating per endpoint | PM-07/08 | PM-01…06 | Staleness tier inconsistency (PM-09/CC-06) |
| Malformed input (all fields/types) | — | NG-05/06/07/08 | none found |
| Concurrency: name / assignment races | — | CC-01/02 | correctly guarded by DB constraints |
| Concurrency: delete-vs-assign race | — | CC-03 | **Bug — see above** |
| Failure recovery: Redis outage | FR-01 | — | Read-path degrade OK; write-path invalidation not guarded (FR-02) |
| Failure recovery: audit-in-tx atomicity | FR-03 | — | none found |
| UX: 204 bodies, full-matrix defaulting | HP-03, EC-18 | — | none found |
| Boundary: name/description length | BD-01/02/05/07 | BD-03/04/06 | none found |
| Boundary: permissions array size | — | BD-09; NG-12 (duplicates within bound) | **Bug (NG-12): duplicate pairs within the size limit crash the request** |
| Boundary: role list size (500 cap) | BD-10 | BD-11 | No pagination/order guarantee past cap — flagged |

---

## 6. Priority roll-up (run these first)

**Critical — must pass before this ships / must fix if failing:**
1. **ST-08** — revoked assignment can never be reassigned (`user_role_mappings_uq` not partial on
   `revokedAt IS NULL`). Breaks a normal real-world workflow permanently.
2. **ST-07** — deleted role's name can never be reused in the same store (`roles_store_name_uq` not
   partial on `deletedAt IS NULL`). Contradicts the app's own pre-check logic.
3. **CC-03** — delete-vs-assign TOCTOU race can leave an active assignment pointing at a deleted role,
   silently violating BR-7.
4. BR-04b/c, BR-05b, BR-03b — escalation guard and system-role protections (verify all pass; these are
   the core security invariants of the module).
5. BR-12a–f — subscription/lock write-gate and its precedence vs RBAC denial.
6. HP-06/HP-07 — the core assign/revoke happy paths, including cache/version propagation actually
   taking effect on the very next request (not just "the DB row changed").

**High — test next:**
- NG-12 (duplicate permission pairs → 500), FR-02 (uncaught Redis error on invalidation), CC-06/PM-09
  (assign/edit staleness window vs delete's guaranteed freshness), EC-15 (blocked/deleted user still
  assignable), CC-07 (self-revoke lockout), ST-09 (`expiresAt` vs `countActiveMembers` inconsistency),
  BR-02b/06b/07b (basic conflict rules), BD-11 (500-role cap/order).

**Medium/Low — polish pass:**
- BD-01–09 (length/size boundaries), NG-01–11 (standard not-found/validation), CC-01/02/04/05
  (races correctly guarded, confirm error shape only), EC-01–18 not already called out above.

---

## 7. Open questions

1. **`deriveRoleCode` collision behavior** (BR-01b) — does `"Store-Owner!!"` (→ `STORE_OWNER__`) truly
   fail to collide with the reserved `STORE_OWNER`, letting a confusingly-named role through? Needs a
   direct unit check of `deriveRoleCode`'s exact collapsing behavior (repeated `_`, trailing `_`).
2. **Should `GET /:roleId` block on the `STORE_OWNER` role id** the way every mutation already does
   (`SYSTEM_ROLE_CODES` check), or is disclosing the owner's full permission matrix to any actor with
   `Role.view` intentional? (BR-03b)
3. **Are the two non-partial unique indexes (`roles_store_name_uq`, `user_role_mappings_uq`) really
   bugs, or an intentional "names/assignments are permanent, once used, forever" policy?** Product/dev
   confirmation needed before filing the fix — but as written, they contradict the app-level pre-checks
   (`nameTaken`, `assignmentExists`), which clearly assume soft-deleted/revoked rows don't block reuse.
   (ST-07, ST-08)
4. **Should `assign` (and `Role.edit`/`Role.create`) be promoted to the critical/30s permission-cache
   tier**, mirroring `delete`, to close the up-to-5-minute staleness window on a just-revoked grant?
   (CC-06, PM-09)
5. **Should `invalidateUserStoreCache`/`invalidateRoleMembersCache` failures be caught/best-effort**,
   the way `RbacService`'s own cache-fill paths already are, so a transient Redis blip doesn't turn a
   successfully-committed mutation into a client-visible `500`? (FR-02)
6. **Should `deleteRole`'s `countActiveMembers` check also exclude `expiresAt`-lapsed assignments**, to
   stay consistent with how `findActiveRolesForUser` defines "active" for permission resolution? (ST-09)
7. **Is a self-revoke of one's own last role in a store intended to be allowed with no warning**, given
   it causes immediate self-lockout on the next request? (CC-07)
8. **Should `assignRole`'s `isAccountMember` check also require the target user's `status==='active'`
   and `isBlocked===false` and `deletedAt IS NULL`**, to avoid assigning roles to
   blocked/suspended/deleted accounts? (EC-15)
9. **Is the `updatePermissions` `.max(200)` array bound meaningful**, given the real matrix only has
   ~112 possible distinct `(entity, action)` pairs today — should it instead be derived from
   `ENTITY_CODES.length * CRUD_ACTIONS.length`, and should duplicate pairs within one request be
   rejected with a clean 4xx instead of crashing (NG-12)?
10. **Is the 500-role-per-store cap in `listStoreRoles` expected to ever bind in practice**, and if a
    store somehow exceeds it, should the list be paginated/ordered rather than silently truncated with
    no stable ordering? (BD-11)
11. **Confirm `POST /stores/:storeId/roles`'s actual HTTP status** — no explicit `@HttpCode`, presumably
    defaults to Nest's `201`; worth a direct assertion since neighboring handlers on this same
    controller are explicit (`@HttpCode(204)`) everywhere else, so the omission here may be
    intentional or an oversight.