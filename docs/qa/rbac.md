# RBAC (Role-Based Access Control) — Test Cases & Edge Cases

**Module under test:** `apps/backend/src/common/rbac/**`
(`entity-catalogue.ts`, `crud-matrices.ts`, `special-actions.ts`, `role-matrices.ts`,
`permission-matrix.constants.ts`, `matrix-integrity.validator.ts` / `.bootstrap.ts`,
`rbac.service.ts`, `rbac.repository.ts`, `resolved-store-context.ts`, `rbac.module.ts`,
`route-coverage.validator.ts` / `.module.ts`, `decorators/rbac.decorators.ts`,
`guards/tenant.guard.ts`, `guards/permissions.guard.ts`, `guards/super-admin.guard.ts`,
`guards/step-up-auth.guard.ts`)

Generated per `docs/agent/CLAUDE-ba-qa-testcases.md`. QA mode: cases below are derived from
the **actual** entity catalogue, role matrices, and guard implementations — not generic
placeholder roles/entities.

---

## 1. Feature understanding (BA)

### What it does
RBAC gates every mutating and most read actions in a multi-tenant retail POS backend. Four
layers, executed in this exact guard order (enforced by `RouteCoverageValidator` at boot):

1. **`MobileJwtGuard`** — authenticates the request, loads `request.user` (`MobilePrincipal`:
   `userId`, `permissionsVersion`, `jwtPv`, optional `stepUpAt`).
2. **`TenantGuard`** — resolves `@StoreContext(source)` (`param.`/`query.`/`body.`/`header.` +
   key, or `'none'`) to a `storeId`, checks the caller's Redis-cached accessible-store list,
   and writes `request.context = { storeId, accountId, isLocked }`. 404s identically for
   non-existent and inaccessible stores (timing-oracle safe).
3. **`PermissionsGuard`** — reads `@RequirePermissions({ entity, action })` and/or
   `@RequireSpecial({ entity, actionCode })`, resolves `EffectivePermissions` for
   `(userId, storeId)` (Redis-cached, DB-backed), checks CRUD and/or special grants, writes a
   SOC2 denial audit before throwing 403, and exposes `request.context.permissions`.
4. **`SuperAdminGuard`** (on `/admin`-style routes only, orthogonal path) — boolean check that
   the caller holds the system-wide `SUPER_ADMIN` role; no CRUD granularity.
5. **`StepUpAuthGuard`** (opt-in via `@StepUpAuth({ within })`) — requires a recent MFA
   step-up timestamp within a rolling window.

`RouteCoverageValidator` runs once at `onApplicationBootstrap` and throws (aborting boot) if
any controller method is missing a required guard, has guards in the wrong order, or declares
a permission/special/step-up decorator without the `@StoreContext` needed to scope it.

`MatrixIntegrityBootstrap` validates the static permission matrix itself at boot (entity
catalogue consistency, CRUD coverage for every role matrix, special-action code format,
critical-action set closure).

### Actors / roles (real, from `role-matrices.ts` + `permission-matrix.constants.ts`)
- **`STORE_OWNER`** — system role code, one per store, immutable (`SYSTEM_ROLE_CODES`),
  non-revocable/non-assignable through normal role-management endpoints. Gets
  `STORE_OWNER_CRUD` + `STORE_OWNER_SPECIAL` (seeded by `seedStoreOwnerPermissions`, called
  from the store-create transaction).
- **`SUPER_ADMIN`** — system-wide role (`roles.storeFk IS NULL`). Authority is enforced purely
  by `SuperAdminGuard`'s boolean membership check on `/admin`-prefixed routes
  (`@StoreContext('none')`, no CRUD check). **`SUPER_ADMIN_CRUD`/`SUPER_ADMIN_SPECIAL` are
  defined and validated at boot but are not read by any guard or service** (grep confirms no
  reference outside `role-matrices.ts` / `special-actions.ts` / `matrix-integrity.validator.ts`)
  — see Open Question OQ-1.
- **`USER`** — system-wide base role every account holder carries; contributes zero store
  grants on its own (`resolveFromDb` filters roles to `roleStoreFk === storeId`, so system-wide
  roles never inject store CRUD/special grants — BR-RBAC-002).
- **Custom store roles** (e.g. "Cashier", "Shift Lead", "Bookkeeper" — store-owner-defined,
  store-scoped) — seeded from `DEFAULT_ROLE_CRUD` (`seedDefaultPermissions`), then customized by
  explicit grants. Default seed only covers 17 of 29 entities (see §2 coverage plan); the other
  12 (`OverrideToken`, `Report`, `Settings`, `User`, `Role`, `Subscription`, `Device`, `Store`,
  `Invitation`, `OwnershipTransfer`, `UserRoleMapping`, `ShiftAssignment`) start at `NONE` and
  require explicit grant.

### Entities (29, `entity-catalogue.ts`)
`Product, Order, Customer, Supplier, Inventory, Payment, Shift, CashMovement, Promotion,
StoreCredit, OverrideToken, Report, Settings, User, Role, Subscription, Device, Store,
Invitation, OwnershipTransfer, UserRoleMapping, ShiftAssignment, PersonalExpense,
PersonalBudget, Attachment, Note, Address, TaxRate, Lookup`.

Each entity carries `isOfflineSafe` and `supportsAttachments` flags (metadata for the sync
engine and attachment upload, not enforcement itself, but validated for shape at boot).

### CRUD actions
`view | create | edit | delete`. Presets: `FULL`, `NO_DELETE`, `VIEW_EDIT`, `VIEW_CREATE`,
`VIEW_ONLY`, `NONE` — all `Object.freeze`d.

### Special (beyond-CRUD) actions (`special-actions.ts`)
Only these entities carry special actions, and only these codes exist:
- `Order`: `REFUND, VOID, DISCOUNT_APPLY, REFUND_HIGH_VALUE, VIEW_HISTORY, PRICE_OVERRIDE`
- `Inventory`: `TRANSFER, AUDIT, RESERVE`
- `Report`: `EXPORT, TAX_REPORT`
- `Customer`: `EXPORT, VIEW_ALL`
- `Shift`: `REOPEN, CLOSE_OTHER`
- `CashMovement`: `LARGE_AMOUNT`
- `Subscription`: `PAY, UPGRADE, DOWNGRADE, CANCEL, ADD_DEVICE_SLOT`
- `Device`: `REMOTE_WIPE`
- `StoreCredit`: `ISSUE`
- `Store`: `TRANSFER_OWNERSHIP`

`STORE_OWNER_SPECIAL` and `SUPER_ADMIN_SPECIAL` currently grant **every** declared special
action verbatim (identical maps) — see OQ-2.

`CRITICAL_SPECIAL_ACTIONS` (30s cache TTL instead of 5m): `REFUND, VOID, REFUND_HIGH_VALUE,
TRANSFER_OWNERSHIP, LARGE_AMOUNT, PAY, REMOTE_WIPE, ISSUE`. Notably **not** critical:
`DISCOUNT_APPLY, VIEW_HISTORY, PRICE_OVERRIDE, TRANSFER, AUDIT, RESERVE, EXPORT, TAX_REPORT,
VIEW_ALL, REOPEN, CLOSE_OTHER, UPGRADE, DOWNGRADE, CANCEL, ADD_DEVICE_SLOT` — `PRICE_OVERRIDE`
and `DISCOUNT_APPLY` on standard 5-minute TTL is worth confirming with product (OQ-3).

### Business rules / invariants extracted from code + `docs/backend/rbac.md` §25
- **BR-RBAC-001** — every route needs `@Public()` or `MobileJwtGuard`; every
  `@RequirePermissions`/`@RequireSpecial` route needs `PermissionsGuard` in `@UseGuards`;
  every such route (plus `@StepUpAuth`) needs `@StoreContext` (or explicit `'none'`).
  Enforced by `RouteCoverageValidator` at boot (throws, aborts server start).
- **BR-RBAC-002** — permissions are store-scoped; a user's grants in Store A are independent of
  Store B. System-wide roles never inject store grants.
- **BR-RBAC-003** — union of all active roles in a store (logical OR); one role with `delete`
  is enough even if another role held by the same user lacks it.
- **BR-RBAC-007** — every permission denial is audited (SOC2 CC6.3) before the 403 is thrown;
  a best-effort audit failure must not swallow the denial or turn it into a 500.
- **BR-RBAC-008 / H-6** — `user.permissionsVersion` vs the JWT's baked-in `jwtPv`; a mismatch
  busts the Redis cache before the permission check runs, so a just-changed permission takes
  effect on the very next request even if a stale cache entry would otherwise still be live.
- **BR-RBAC-009** — critical ops (delete CRUD + `CRITICAL_SPECIAL_ACTIONS`) use a 30s cache TTL
  and reject any cached entry older than 30s even if the Redis key itself hasn't expired
  (i.e. a standard-TTL entry written 40s ago by a `view` check is rejected for a `delete` check).
- **BR-RBAC-010** — point-in-time authorization (`wasCrudAuthorizedAt`) for offline mutation
  replay: authorized at the time the action was *queued* (`asOf`), not at sync time.
- **BR-RBAC-011** — timing-oracle-safe: identical 404 for a non-existent store and an
  inaccessible one.
- **BR-RBAC-014** — `STORE_OWNER_CRUD` must cover every entity in `ENTITIES` (checked at boot).
- **BR-RBAC-018** — a corrupt Redis cache entry is deleted and treated as a miss, never as a
  block.
- **(new, this diff)** `@RequireSpecial` alone (no `@RequirePermissions`) must still force
  `PermissionsGuard` to be present — this was a real gap the route-coverage validator just
  closed (a special-action-only route could previously ship unenforced).
- **(removed, this diff)** The `Location` entity, `LocationGuard`, `@LocationContext`,
  `LOCATION_CONTEXT_KEY`, and `ResolvedStoreContext.locationId` have been deleted wholesale.
  Store is now the *only* scoping granularity below the account — see §7 OQ-4/OQ-5 and the
  dedicated regression cases in §4.

### State machine
RBAC itself is not a stateful resource, but permission *state* changes over the life of a
session:
- Role assignment created → active → (optionally) expired (`expiresAt`) → revoked
  (`revokedAt`, soft-delete, never hard-deleted).
- Cache state: miss → DB-resolved → cached (5m std / 30s critical) → busted (version mismatch,
  explicit invalidation, or corruption) → miss again.
- JWT `pv` vs DB `permissionsVersion`: in-sync → drifted (post role-change) → re-synced (cache
  bust on next request; JWT itself isn't rotated by RBAC, only the cache is invalidated).

### Assumptions flagged
- A1: "manager of store A must not act on store B" is enforced entirely by `TenantGuard`'s
  accessible-store-id check (Redis-cached `userStoreIds`), not by a per-request DB query —
  tests below target that cache's correctness and staleness window explicitly.
- A2: Since `SUPER_ADMIN_CRUD`/`SPECIAL` appear unused, "SUPER_ADMIN" test cases below treat
  super-admin authority as all-or-nothing per `/admin` route, not entity/action-granular.
- A3: With `Location` removed, any pre-existing product requirement for "cashier assigned to
  Location X only" is currently **unenforceable** — a role granted `Order.view` at the store
  level can view/act on orders across every location in that store. Treated as an intentional
  descope for this iteration; flagged as OQ-4 for product confirmation.

---

## 2. Coverage plan

| Dimension | Applies? | Approx. case count |
|---|---|---|
| Happy paths | Yes | 8 |
| Business rules (satisfied + violated) | Yes | 20 |
| Boundaries | Yes | 10 |
| Negative / invalid | Yes | 12 |
| Failure & recovery | Yes | 10 |
| Concurrency | Yes | 8 |
| Permission / role (the core of this module) | Yes | 18 (+ full CRUD matrix table) |
| State transitions | Yes | 8 |
| Cross-cutting (tenancy, offline/sync, boot-time) | Yes | 12 |
| UX / experience | Minimal (backend-only; API error-shape consistency) | 3 |
| **Total discrete cases** | | **~95** (below), plus a full role×entity CRUD matrix |

---

## 3. Test cases

Realistic actors used throughout:
- **Priya** — `STORE_OWNER` of "Priya's Electronics" (Store A) and also owns Store B (a second
  location she separately registered — two independent `stores` rows, same `accountFk`).
- **Arjun** — custom role **"Cashier"** (seeded from `DEFAULT_ROLE_CRUD`, no extra grants) in
  Store A only.
- **Meera** — custom role **"Shift Lead"** in Store A: `DEFAULT_ROLE_CRUD` seed plus explicit
  grants for `Report.view`, `Shift.REOPEN`, `CashMovement.LARGE_AMOUNT`.
- **Devon** — `SUPER_ADMIN` (platform staff), no store role anywhere.
- **Wei** — ex-employee of Store A, role revoked yesterday.

### 3.1 Happy paths

**RBAC-H01 — Owner performs a full-permission action**
Area: happy · Criticality: Critical · Traces to: BR-RBAC-003, STORE_OWNER_CRUD
Preconditions: Priya authenticated, `STORE_OWNER` in Store A.
Input: `DELETE /stores/{storeA}/promotions/{id}`.
Steps: Call the endpoint with a valid promotion id in Store A.
Expected: 200; promotion deleted; `checkCrud(perms, 'Promotion', 'delete')` true because
`STORE_OWNER_CRUD.Promotion === FULL`.
Notes: Also exercises `@RequirePermissions({entity:'Promotion', action:'delete'})` end to end.

**RBAC-H02 — Cashier performs an in-scope create**
Area: happy · Criticality: High · Traces to: DEFAULT_ROLE_CRUD.Order = VIEW_CREATE
Preconditions: Arjun authenticated, "Cashier" role in Store A only.
Input: `POST /stores/{storeA}/orders` with a valid cart payload.
Steps: Submit order creation.
Expected: 200/201; order created. `checkCrud(perms,'Order','create')` true.

**RBAC-H03 — Cashier is correctly blocked from editing an order**
Area: happy (rule boundary) · Criticality: High · Traces to: DEFAULT_ROLE_CRUD.Order = VIEW_CREATE (edit:false)
Preconditions: Same as H02.
Input: `PATCH /stores/{storeA}/orders/{id}`.
Steps: Attempt to edit an existing order line.
Expected: 403 `PERMISSION_DENIED`; SOC2 denial audit row written
(`entityType:'Order', metadata.action:'edit'`); no order mutation.

**RBAC-H04 — Shift Lead uses a granted special action**
Area: happy · Criticality: High · Traces to: explicit grant, `@RequireSpecial`
Preconditions: Meera holds explicit `Shift.REOPEN` grant.
Input: `POST /stores/{storeA}/shifts/{id}/reopen`.
Steps: Call reopen on a closed shift Meera did not personally close.
Expected: 200; shift reopened; `checkSpecial(perms,'Shift','REOPEN')` true.

**RBAC-H05 — Owner issues a refund (critical special action)**
Area: happy · Criticality: Critical · Traces to: STORE_OWNER_SPECIAL.Order includes REFUND, CRITICAL_SPECIAL_ACTIONS
Preconditions: Priya, Store A, a completed order.
Input: `POST /stores/{storeA}/orders/{id}/refund` `{ amount: 49.99 }`.
Steps: Submit refund.
Expected: 200; refund processed; permission resolved with `isCritical=true` → 30s TTL cache
entry written.

**RBAC-H06 — Super admin accesses an /admin route**
Area: happy · Criticality: High · Traces to: SuperAdminGuard
Preconditions: Devon holds system-wide `SUPER_ADMIN`, no store role.
Input: `POST /admin/lookup-types` (per `lookup-type.controller.ts`, `@StoreContext('none')`).
Steps: Call the admin endpoint.
Expected: 200; `SuperAdminGuard.isSuperAdmin` true; no store resolution attempted
(`@StoreContext('none')` → `TenantGuard` passes through).

**RBAC-H07 — Public route bypasses all RBAC guards**
Area: happy · Criticality: Medium · Traces to: `@Public()`
Preconditions: Unauthenticated caller.
Input: A `@Public()` route (e.g. health check / login).
Steps: Call without a JWT.
Expected: 200 (no `MobileJwtGuard`/`TenantGuard`/`PermissionsGuard` enforcement); confirmed by
`RouteCoverageValidator` accepting the route at boot without `MobileJwtGuard`.

**RBAC-H08 — Same user, two roles in one store, union grants delete**
Area: happy · Criticality: High · Traces to: BR-RBAC-003
Preconditions: Meera additionally holds a second custom role "Auditor" in Store A that grants
`Order.delete` (Shift Lead alone does not).
Input: `DELETE /stores/{storeA}/orders/{id}`.
Steps: Delete an order.
Expected: 200; union of both roles' grants includes `delete:true`; deletion succeeds.

### 3.2 Business rules (satisfied + violated)

**RBAC-BR01 (satisfied) — Store isolation, BR-RBAC-002**
Priority: Critical. Priya's Store A `STORE_OWNER` grants do not apply in Store B even though
she also owns Store B. Precondition: Priya holds distinct `STORE_OWNER` role rows per store
(one per `roles.storeFk`). Steps: call `GET /stores/{storeA}/reports` then
`GET /stores/{storeB}/reports` with the same JWT. Expected: both succeed independently, each
resolving a separate `EffectivePermissions` for `(priyaId, storeA)` and `(priyaId, storeB)`
(different Redis keys `perm:{userId}:{storeId}`).

**RBAC-BR02 (violated) — Cross-store escalation blocked**
Priority: Critical. Arjun (Cashier, Store A only) calls `GET /stores/{storeB}/orders`.
Expected: `TenantGuard.userStoreIds(arjun)` does not include Store B → 404
`STORE_NOT_ACCESSIBLE` (not 403 — indistinguishable from a non-existent store id, BR-RBAC-011).
No `EffectivePermissions` resolution for Store B is ever attempted (fail fast at `TenantGuard`,
before `PermissionsGuard` runs).

**RBAC-BR03 (satisfied) — Union of roles (BR-RBAC-003)**
Covered by RBAC-H08 above (satisfied case). Violated pairing: a user with only "Cashier"
(no delete anywhere) attempting delete → 403, confirming the union isn't accidentally
over-granting.

**RBAC-BR04 (violated) — Union does not turn two partial roles into over-grant beyond their sum**
Priority: High. Meera holds "Shift Lead" (`Report.view` only, no `Report.EXPORT`) and a second
custom role "Scheduling" that also has no `Report` grants at all. Steps: `GET
/stores/{storeA}/reports/export` (`@RequireSpecial({entity:'Report', actionCode:'EXPORT'})`).
Expected: 403 `SPECIAL_PERMISSION_DENIED` — union of {Report.view} ∪ {} is still missing
`EXPORT`; no entity silently inherits an unrelated entity's special grant.

**RBAC-BR05 (satisfied) — permissionsVersion bust takes effect immediately (H-6, BR-RBAC-008)**
Priority: Critical. Precondition: Arjun's permissions cached 2 minutes ago (well inside the 5m
std TTL). Owner grants Arjun's "Cashier" role a new `Order.edit` mid-session via role-permission
update, which calls `bumpPermissionsVersionForRole` → `users.permissionsVersion += 1` for all
members, but Arjun's **already-issued JWT** still carries the old `jwtPv`. Steps: Arjun
immediately calls `PATCH /stores/{storeA}/orders/{id}`. Expected: `PermissionsGuard` sees
`principal.jwtPv !== principal.permissionsVersion` → busts the Redis cache before checking →
`resolveFromDb` re-run → edit now allowed. 200, not a stale 403.
Notes: Requires `principal.permissionsVersion` to be loaded fresh from the DB per-request by
`MobileJwtGuard` (not baked into the JWT) — verify that assumption against
`auth/mobile/guards/mobile-jwt.guard.ts` if this case fails unexpectedly.

**RBAC-BR06 (violated) — Revoked role takes effect within the critical window, not before**
Priority: Critical. Traces to BR-RBAC-009. Owner revokes Wei's role. Wei's permissions were
cached via a `view` (standard, 5m TTL) request 40 seconds ago. Steps: Wei immediately attempts
`DELETE /stores/{storeA}/products/{id}` (critical: `action==='delete'`). Expected:
`getCachedPermissions(..., isCritical=true)` computes `ageMs = now - resolvedAt` (~40000ms) >
`TTL_CRITICAL_SECONDS*1000` (30000ms) → cached entry rejected even though the Redis key TTL
(5m) hasn't expired → refetch from DB → revoked role excluded → 403 `PERMISSION_DENIED`.
Contrast: if Wei instead attempts a `view` (non-critical) 40s after caching, the same stale
entry **is** accepted (standard requests don't re-check age) — worth an explicit companion
case (RBAC-BR06b) to make the asymmetry visible to testers, since it is easy to "fix" as a bug.

**RBAC-BR06b (documents intended staleness) — Non-critical read may serve a stale-but-live cache entry**
Priority: High. Same precondition as BR06. Steps: Wei calls `GET /stores/{storeA}/products`
(view, non-critical) 40s after the role was revoked but before the 5m TTL expires. Expected:
200 — served from the still-live cache entry with the now-revoked grant, by design (§ getCachedPermissions
doc comment). Up to ~5 minutes of read access can outlive a revocation. Flag as OQ-6 if product
wants reads to also respect a tighter bound.

**RBAC-BR07 (satisfied) — Reads are never subscription/lock-blocked (BR-RBAC-004)**
Out of strict RBAC scope (owned by `SubscriptionStatusGuard`) but interacts with
`ResolvedStoreContext.isLocked` written by `TenantGuard`. Include as a boundary check: a locked
store's `GET` routes still resolve `request.context` normally (RBAC guards do not read
`isLocked` themselves) — verify `TenantGuard`/`PermissionsGuard` do not add their own lock
check (that responsibility lives elsewhere; regression here would double-gate incorrectly).

**RBAC-BR08 (satisfied) — Unknown/decommissioned entity code fails closed**
Priority: Critical. Traces to `checkCrud`/`checkSpecial` `isEntityCode` guard. Precondition: a
`rolePermissions` row exists with `entity_code = 'LegacyDiscount'` (decommissioned, no longer
in `ENTITY_CODES` — e.g. left over from a past migration). Steps: `resolveFromDb` runs.
Expected: the row is silently dropped (`if (!isEntityCode(row.entityCode)) continue;`) — it
does not throw, and it grants nothing. Companion violated case: a route decorator typo'd as
`@RequirePermissions({entity:'Order ' as EntityCode, action:'view'})` (trailing space) —
`checkCrud` returns `false` before ever consulting the map → always denied, never silently
allowed by accident.

**RBAC-BR09 (satisfied) — `@RequireSpecial` alone enforces without `@RequirePermissions` (new rule this diff)**
Priority: Critical (regression risk — this was the gap just fixed).
Precondition: a route declares only `@RequireSpecial({entity:'CashMovement',
actionCode:'LARGE_AMOUNT'})`, no `@RequirePermissions`. Steps (boot-time): run
`RouteCoverageValidator.onApplicationBootstrap()` with `@UseGuards(PermissionsGuard, ...)`
present. Expected: boot succeeds (no error). Violated case: same route but
`@UseGuards(...)` omits `PermissionsGuard`. Expected: boot **throws**
`"<Controller>.<method> has @RequireSpecial but PermissionsGuard is not in @UseGuards(...)."`
— server never starts with this route shipped unenforced.

**RBAC-BR10 (violated) — Route with permission decorator but no store context**
Priority: Critical. A route declares `@RequirePermissions({entity:'Order', action:'view'})`
with `@UseGuards(MobileJwtGuard, PermissionsGuard)` but no `@StoreContext` anywhere (class or
method). Expected: boot throws `"... has @RequirePermissions but no @StoreContext — it would
run store-unscoped. Add @StoreContext(...) or @StoreContext('none')."`

**RBAC-BR11 (violated) — Guard order wrong: PermissionsGuard before TenantGuard**
Priority: Critical. `@UseGuards(MobileJwtGuard, PermissionsGuard, TenantGuard)`. Expected: boot
throws (guard-order check) — `PermissionsGuard` would read `request.context` before
`TenantGuard` ever writes it, producing a permanent, confusing 403 (`STORE_CONTEXT_MISSING`) at
request time if this weren't caught at boot.

**RBAC-BR12 (satisfied) — `@StoreContext('none')` is a real, honored opt-out**
Priority: High. A class-level `@StoreContext('none')` route with no `@RequirePermissions`.
Expected: boot passes without requiring `TenantGuard` in `@UseGuards`, and at request time
`TenantGuard.canActivate` returns `true` immediately without touching `request.context`.

**RBAC-BR13 (satisfied) — `STORE_OWNER_CRUD` covers all 29 entities (BR-RBAC-014)**
Priority: Critical (boot-time). `validateMatrixIntegrity()` iterates `ENTITY_CODES` and asserts
each is present in `STORE_OWNER_CRUD`/`SUPER_ADMIN_CRUD`. Violated case: temporarily remove one
entity from `STORE_OWNER_CRUD` (e.g. delete the `Lookup` line) → expect
`"STORE_OWNER_CRUD is missing entity: Lookup."` thrown at boot, server does not start.

**RBAC-BR14 (violated) — Special action code not SCREAMING_SNAKE_CASE**
Priority: Medium (boot-time). Add `'refund_partial'` to `SPECIAL_ACTIONS.Order`. Expected:
`validateMatrixIntegrity` throws `"SPECIAL_ACTIONS[Order] contains non-SCREAMING_SNAKE action:
refund_partial."`

**RBAC-BR15 (violated) — `STORE_OWNER_SPECIAL` references an undeclared special action**
Priority: Medium (boot-time). Add `'BULK_REFUND'` to `STORE_OWNER_SPECIAL.Order` without adding
it to `SPECIAL_ACTIONS.Order`. Expected: throws `"STORE_OWNER_SPECIAL[Order] references
undeclared action: BULK_REFUND."`

**RBAC-BR16 (violated) — `CRITICAL_SPECIAL_ACTIONS` references an undeclared action**
Priority: Medium (boot-time). Add a typo'd action to `CRITICAL_SPECIAL_ACTIONS` that exists in
no entity's `SPECIAL_ACTIONS` list. Expected: throws
`"CRITICAL_SPECIAL_ACTIONS references undeclared action: <x>."`

**RBAC-BR17 (satisfied) — Deserialization rejects a malformed cached special-action code**
Priority: High. Traces to `SPECIAL_CODE_REGEX` in `effective-permissions.ts`. Precondition: a
Redis value crafted (e.g. by a bug elsewhere, or Redis data corruption) contains
`special.Order = ['refund']` (lowercase). Steps: `deserializeCachedEntry` runs. Expected:
throws `Invalid special action code "refund"` → caller (`getCachedPermissions`) catches, logs,
deletes the key, refetches from DB (BR-RBAC-018) — not a 500 to the caller.

**RBAC-BR18 (satisfied) — System-wide role never injects store grants (BR-RBAC-002 enforcement path)**
Priority: Critical. Precondition: Devon (`SUPER_ADMIN`, `roleStoreFk: null`) is, by a data bug,
also mistakenly given a `rolePermissions` row directly on the `SUPER_ADMIN` role granting
`Order.delete`. Steps: Devon calls a store-scoped route in some arbitrary Store C he has no
`STORE_OWNER`/custom role in. Expected: `resolveFromDb`'s `roleIds` filter
(`activeRoles.filter(role => role.roleStoreFk === storeId)`) excludes the system-wide
`SUPER_ADMIN` mapping entirely (its `roleStoreFk` is `null !== storeC`) → `roleIds.length === 0`
→ `emptyPermissions()` → 403 on the store route, regardless of what `rolePermissions` rows are
attached to the `SUPER_ADMIN` role. This is the concrete regression test for the "without this
filter, a system-wide role's grants would bleed across every store" comment in the code.

### 3.3 Boundaries

**RBAC-B01 — Critical TTL exact boundary (30.0s)**
Priority: High. Entry `resolvedAt` such that `Date.now() - resolvedAt === 30000` exactly.
Expected: `ageMs <= 30000` is true (inclusive `<=`) → accepted, no refetch. At `30001ms` →
rejected, refetch. Verify the operator is `<=` not `<` per code (`ageMs <= TTL_CRITICAL_SECONDS
* 1000`).

**RBAC-B02 — Standard TTL exact boundary (300s / 5m)**
Priority: Medium. Redis key itself expires at exactly 300s (SETEX semantics) — verify the key
is simply gone (cache miss) rather than served stale, distinct from the critical in-payload
`resolvedAt` check.

**RBAC-B03 — Step-up window exact boundary**
Priority: High. `@StepUpAuth({within:'5m'})`, `stepUpAt` exactly `300000ms` in the past.
Expected: `Date.now() - stepUpAt.getTime() > withinMs` is `false` at exactly 300000ms (not `>`)
→ allowed. At `300001ms` → `STEP_UP_AUTH_REQUIRED`.

**RBAC-B04 — Zero active roles**
Priority: Critical. A brand-new user added to a store's account but not yet assigned any role
(e.g. mid-invitation before acceptance). `findActiveRolesForUser` returns `[]` →
`emptyPermissions()` → every `checkCrud`/`checkSpecial` false → 403 on everything except
`@Public` routes.

**RBAC-B05 — Bulk invalidation at the documented ceiling (50 users)**
Priority: Medium. `invalidateUserStoreCacheForUsers` called with exactly 50 user ids (the
documented "up to 50 users in one call" bulk-role-assignment case). Expected: one pipelined
`DEL` with 100 keys (`permKey` + `userStoresKey` per user); all 50 users' caches busted.
Also test 0 users (early return, no Redis call) and 1 user (still batched, not special-cased).

**RBAC-B06 — Empty `roleIds` short-circuits without a query**
Priority: Low. `fetchCrudPermissions([])` / `fetchSpecialPermissions([])` — expect `[]`
returned with no DB round trip (explicit early return in `rbac.repository.ts`), relevant when
`resolveFromDb` already returned early for zero roles but is exercised again for defense-in-depth.

**RBAC-B07 — Max-length / unicode role and entity strings don't break the SCREAMING_SNAKE check**
Priority: Low. A special action code of maximal realistic length,
e.g. `'REFUND_HIGH_VALUE_REQUIRES_MANAGER_APPROVAL_OVER_LIMIT'` — still matches
`SCREAMING_SNAKE_CASE` regex; a code with a digit run `'REFUND2'` also matches
(`[A-Z][A-Z0-9]*`); a code starting with a digit `'2FA_REQUIRED'` does **not** match (regex
requires leading `[A-Z]`) — confirm this is intended (no special code may start with a digit).

**RBAC-B08 — `readScopedSource` on an empty-string value**
Priority: Medium. `@StoreContext('param.storeId')` where `req.params.storeId === ''`.
Expected: `readScopedSource` returns `undefined` (`value.length > 0` check) →
`TenantGuard` throws `STORE_CONTEXT_MISSING`, not a DB lookup with an empty string.

**RBAC-B09 — Single-role vs many-roles union performance/correctness parity**
Priority: Low. A user with 1 role vs a user with 6 concurrently-held custom roles in the same
store — union result must be identical in shape whether computed from 1 or 6 role-id rows
(`Promise.all` fetch is unaffected by role count beyond the `inArray` size).

**RBAC-B10 — `DEFAULT_ROLE_ABSENT` boundary: entity present in neither/both sets is impossible by construction**
Priority: Low (documentation/regression guard). `DEFAULT_ROLE_ABSENT` is defined as the exact
complement of `DEFAULT_ROLE_CRUD`'s keys. Confirm `checkDefaultRoleAbsent` still catches a
future edit that breaks that invariant (e.g. someone manually adds an entity to
`DEFAULT_ROLE_ABSENT` that's also still a key in `DEFAULT_ROLE_CRUD` — expect boot error
`"DEFAULT_ROLE_ABSENT contains entity already present in DEFAULT_ROLE_CRUD"`).

### 3.4 Negative / invalid

**RBAC-N01 — Missing JWT / unauthenticated on a guarded route**
Priority: Critical. No `Authorization` header on a non-`@Public` route. Expected: `401` from
`MobileJwtGuard` before `TenantGuard`/`PermissionsGuard` ever run.

**RBAC-N02 — `request.user` missing at `TenantGuard` (defensive)**
Priority: Critical. Simulated: a guard chain misconfiguration puts `TenantGuard` before
`MobileJwtGuard`. Expected: `TenantGuard` throws `UnauthorizedException('MISSING_AUTH')`
defensively even though this should never happen given correct guard order (also caught
separately by `RouteCoverageValidator`'s auth-coverage check).

**RBAC-N03 — `request.context` missing when `PermissionsGuard` runs (defensive fail-closed)**
Priority: Critical. Traces to the `[SECURITY]`-logged branch in `permissions.guard.ts`.
Precondition: a route has `@RequirePermissions` but (by some future refactor bug) `TenantGuard`
didn't run / didn't write context. Expected: `403 STORE_CONTEXT_MISSING`, an error-level log
line naming the user/route, **not** a 500 and not a silent pass-through.

**RBAC-N04 — Invalid `EntityCode` string reaches `checkCrud`**
Priority: Critical. A hypothetical decorator typo, `entity: 'Oder'`. Expected:
`isEntityCode('Oder')` false → `checkCrud` returns `false` immediately → 403, never a thrown
error, never an accidental grant.

**RBAC-N05 — Invalid `CrudAction` string in a DB row**
Priority: High. A `rolePermissions.action` DB value of `'archive'` (not one of
`view/create/edit/delete` — e.g. a decommissioned action from an old schema). Expected: current
code does **not** call `isCrudAction` on the read path in `resolveFromDb` (it trusts the
Drizzle enum column type) — if the DB enum itself were ever loosened, this would silently set
`current['archive'] = true` on the in-memory object with no effect on real `checkCrud` lookups
(harmless but wasted); flag as OQ-7 (should `fetchCrudPermissions` defensively filter with
`isCrudAction`, matching the fail-closed pattern already used for `entityCode`?).

**RBAC-N06 — Malformed JSON in the Redis permissions cache**
Priority: Critical. Precondition: `redis.get(permKey)` returns `"{not json"`. Expected:
`deserializeCachedEntry` throws `"Malformed cached permissions payload: invalid JSON."` →
caught → warn-logged (truncated to 160 chars) → key deleted → falls through to DB (BR-RBAC-018)
→ request still succeeds, just slower.

**RBAC-N07 — `resolvedAt` missing/non-numeric in cached payload**
Priority: High. Cached JSON has `crud`/`special` but no `resolvedAt` (e.g. written by an older
code version pre-dating H-6). Expected: `deserializeCachedEntry` throws
`'"resolvedAt" must be a number'` → treated as corruption → deleted → DB refetch → cache
re-written in the new format going forward.

**RBAC-N08 — `special` value is not an array in cache**
Priority: Medium. `special.Order = "REFUND"` (string, not array). Expected:
`normalizeSpecialCodes` throws `"Malformed special permissions for entity \"Order\"."` →
corruption path.

**RBAC-N09 — `crud` value is not an object in cache**
Priority: Medium. `crud.Order = "FULL"` (string). Expected:
`normalizeCrudPermissions` throws `'Malformed CRUD permissions for entity "Order".'` →
corruption path.

**RBAC-N10 — `userStoreIds` cache holds non-string-array garbage**
Priority: Medium. Redis value for `user_stores:{userId}` is `'{"a":1}'` (parses but isn't an
array) or `'["id1", 2]'` (array with a non-string element). Expected: the
`Array.isArray(parsed) && parsed.every(v => typeof v === 'string')` guard fails → key deleted →
falls through to `findAccessibleStoreIds` DB query, result re-cached.

**RBAC-N11 — Injection-style input in `@StoreContext` source**
Priority: High. `param.storeId = "'; DROP TABLE stores;--"`. Expected: Drizzle's parameterized
`eq(stores.id, raw)` treats it as a literal string value, not SQL — the id simply won't match
any accessible store → 404 `STORE_NOT_ACCESSIBLE`, no injection possible. (Confirms the
query-builder contract; not expected to be a real vulnerability, but worth a regression test
given `raw` is fully attacker-controlled user input.)

**RBAC-N12 — Malformed `@StepUpAuth` duration spec**
Priority: Medium. A route decorated `@StepUpAuth({within: '5 minutes'})` (not matching
`/^(\d+)(s|m|h)$/`). Expected: `parseDurationMs` throws `'Invalid @StepUpAuth window:
"5 minutes"'` — but this throws **at request time**, on every call to that route, not at boot;
flag as OQ-8 (should this be validated at startup alongside the matrix integrity checks, so a
bad spec fails the deploy instead of every live request to that route?).

### 3.5 Failure & recovery

**RBAC-F01 — Redis fully down on permission read**
Priority: Critical. `redis.get` rejects (connection refused). Expected: caught, warn-logged,
falls through to `resolveFromDb` (Postgres) — request succeeds; no 500 from a Redis outage.

**RBAC-F02 — Redis fully down on permission write-back**
Priority: High. DB resolve succeeds; `redis.setex` rejects. Expected: swallowed (`catch {}`
best-effort comment) — request still returns its correct result; next request simply misses
cache again (no infinite retry, no request failure).

**RBAC-F03 — Redis down on `userStoreIds` read**
Priority: Critical. Same pattern as F01 but for the accessible-store-id cache that
`TenantGuard` depends on for every store-scoped request. Expected: falls through to
`findAccessibleStoreIds` DB query; tenant boundary still enforced correctly, just slower.

**RBAC-F04 — Redis down on cache invalidation (role revoked, Redis unavailable)**
Priority: Critical. `invalidateUserStoreCache` calls two `redis.del`s inside `Promise.all` —
if Redis is down, both reject. Expected (verify current behavior): unlike the read/write
paths, there is **no visible try/catch around `invalidateUserStoreCache`'s own body** — a
Redis outage here would reject the whole call. Trace whether the *caller* (role-revocation
service) wraps this in its own try/catch; if not, a role revocation during a Redis outage could
fail the revocation request even though the DB-side revocation already committed, leaving the
old permissions live in cache until natural TTL expiry. **This is a genuine gap to verify against
the calling service** — flagged as OQ-9, Critical priority to resolve given it affects "employee
fired" correctness.

**RBAC-F05 — DB unavailable during `resolveFromDb`**
Priority: Critical. Postgres connection error during `findActiveRolesForUser`. Expected:
propagates as a 500 (no permissions source left) — verify this surfaces as a generic 500, not
an accidental "no roles found → empty permissions → 403" (which would look like a permission
denial rather than an infrastructure failure, confusing support/monitoring). Confirm error
does not get miscategorized as `PERMISSION_DENIED` in logs/audit.

**RBAC-F06 — Audit write fails during a permission denial (BR-RBAC-007)**
Priority: Critical. `AuditService.log` throws inside `denyAudit`. Expected: caught,
error-logged, and the `ForbiddenException` is **still thrown** right after (the denial itself
is the security outcome per code comment) — a broken audit pipe must never accidentally allow
the request through, and must never turn a clean 403 into a 500.
Notes: cross-check against `docs/backend/rbac.md` BR-RBAC-007, which describes the *target*
behavior as "a failed audit write rejects and propagates to the caller (fail-closed)" —
opposite of what `permissions.guard.ts`'s comment/implementation currently does (best-effort,
swallowed). **This is a live contradiction between the PRD and the shipped code** — flagged as
OQ-10, must be resolved with product/security before sign-off (which is actually correct: silently
allow the 403 to still happen, or fail closed harder by 500'ing when audit is unavailable?).

**RBAC-F07 — Retry / double-submit of a critical special action**
Priority: High. Network blip causes the client to retry `POST /orders/{id}/refund` after a
timeout, but the first request actually succeeded server-side. Expected: RBAC layer itself is
not idempotency-aware (that's the order/refund service's job) — confirm the permission check
re-runs cleanly on retry (still 200 from RBAC's perspective) and that idempotency protection
against double-refund lives downstream, not silently assumed to be RBAC's job. Flag as a
cross-cutting note rather than an RBAC bug.

**RBAC-F08 — Bulk cache invalidation partially fails (50-user batch, Redis times out mid-pipeline)**
Priority: Medium. `redis.del(...keys)` for 100 keys times out. Expected: current code has no
partial-success handling — a single `DEL` call either succeeds or throws; if it throws, the
whole bulk-assignment cache-bust fails. Verify the caller's retry/alerting story; at minimum,
the affected users would keep serving old cached permissions until natural TTL (≤5m) — bounded
staleness, not unbounded.

**RBAC-F09 — Store-create transaction rolls back after `seedStoreOwnerPermissions` partially inserts**
Priority: High. Simulate a failure after `insertCrudGrants` succeeds but before
`insertSpecialGrants` completes, inside the store-create transaction. Expected: since both
calls run inside the caller's transaction (`tx` parameter), a rollback undoes both — no orphaned
CRUD-only owner with no special grants.

**RBAC-F10 — Route-coverage validator itself throws mid-scan (partial error list)**
Priority: Low. Multiple unrelated controllers each have a distinct violation. Expected: all
violations are collected into one `errors[]` array and thrown together in a single `Error`
message (not fail-fast on the first one) — a developer fixing route config sees the whole list
in one boot attempt, not one-at-a-time.

### 3.6 Concurrency

**RBAC-C01 — Two simultaneous requests race a cold cache (thundering herd)**
Priority: High. Arjun's cache key just expired; two requests land in the same millisecond.
Expected: both miss Redis, both call `resolveFromDb`, both `setex` the same key (last write
wins, same value) — no crash, no corruption, at most one extra DB round trip. Not a
correctness bug, but worth confirming there's no lock/singleflight (there isn't) so DB load
under a popular cold key is understood.

**RBAC-C02 — Role revoked while a request is mid-flight**
Priority: Critical. Owner revokes Wei's role at T0. Wei's `PermissionsGuard` call started at
T0-10ms already read a (still-valid-at-read-time) cached permission at T0-5ms. Expected: this
request completes with the pre-revocation permission (acceptable — it was authorized when the
guard read it); the **next** request must reflect the revocation. Verify the boundary is "per
guard invocation," not "per session."

**RBAC-C03 — Concurrent role-permission grant + cache read**
Priority: High. Owner grants Meera `Order.delete` at the same instant Meera's request resolves
`getCachedPermissions`. Two orderings: (a) grant DB-commits before Meera's `resolveFromDb`
reads → she gets the new grant immediately; (b) grant commits after her read → she gets the old
(pre-grant) permissions for this one request, then the version-mismatch bust catches it on her
*next* request (assuming the grant flow also bumps `permissionsVersion` — confirm
`seedDefaultPermissions`/ad-hoc grant endpoints call `bumpPermissionsVersionForRole`).

**RBAC-C04 — Two devices for the same user hit different stores simultaneously**
Priority: Medium. Priya on tablet A calls Store A while Priya on phone B calls Store B at the
same time. Expected: independent Redis keys (`perm:{userId}:{storeA}` vs `perm:{userId}:{storeB}`)
— no cross-contamination, no race between the two lookups.

**RBAC-C05 — Bulk role-member invalidation races an individual grant change**
Priority: Medium. `invalidateRoleMembersCache` (bulk, on role-permission change affecting all
50 members) runs concurrently with one member's own `bumpPermissionsVersionForUser` (e.g. that
member was just also assigned a second role). Expected: both are idempotent DEL/increment
operations — order doesn't matter, end state is correct either way (cache cleared, version
bumped at least once).

**RBAC-C06 — Concurrent double-grant of the same special action**
Priority: Low. Two admin requests both call "grant `Order.REFUND` to role X" at once.
Expected: `insertSpecialGrants` — verify whether a unique constraint exists on
`(roleFk, entityCode, actionCode)` to prevent a duplicate-but-harmless row, or whether
`checkSpecial`'s `Set` semantics make duplicates harmless regardless (a `Set.has` check doesn't
care about duplicate grant rows, only distinct DB rows would matter for revocation bookkeeping).
Flag as OQ-11 if no unique constraint exists — the fix is more about clean data than security.

**RBAC-C07 — Race between store-accessibility cache and store deletion**
Priority: High. Store B is soft-deleted (`stores.deletedAt` set) at the same moment a stale
`user_stores:{userId}` cache entry (from before deletion, TTL up to 5m) still lists Store B.
Expected: `TenantGuard` accepts Store B as "in accessible ids" from cache, but
`resolveAccessibleStore`'s DB query filters `isNull(stores.deletedAt)` — so the DB step still
returns `null` → 404, even though the cache said it was accessible. Net effect: correct
(deleted stores are never reachable), but confirms **the accessible-ids cache alone is not
suffient authorization** — it's a pre-filter, the DB row fetch is the real gate. Good regression
case to keep.

**RBAC-C08 — Simultaneous cache invalidation for 50 users during an in-flight bulk role assignment**
Priority: Medium. `invalidateUserStoreCacheForUsers` runs for 50 users while a 51st user is
mid-assignment to the same role in a separate concurrent request. Expected: the 51st user's own
`bumpPermissionsVersionForUser`/invalidation call (from their own assignment flow) is
independent and not lost by the batch call for the other 50 — verify no shared mutable state
between the two calls (there isn't; each computes its own key list).

### 3.7 Permission / role cases (the core of this module)

**Full CRUD coverage matrix** (satisfied cases — every cell below is `true` per the matrices in
`role-matrices.ts`; the corresponding **violated** case for any `false` cell is "role X attempts
action Y on entity Z → 403 PERMISSION_DENIED," omitted per-cell for brevity but implied by every
`false`/absent entry):

| Entity | STORE_OWNER (V/C/E/D) | Custom-role default seed (V/C/E/D) |
|---|---|---|
| Product | 1/1/1/1 | 1/0/0/0 |
| Order | 1/1/1/1 | 1/1/0/0 |
| Customer | 1/1/1/1 | 1/0/0/0 |
| Supplier | 1/1/1/1 | 1/0/0/0 |
| Inventory | 1/1/1/1 | 1/0/0/0 |
| Payment | 1/1/1/1 | 1/0/0/0 |
| Shift | 1/1/1/1 | 1/1/0/0 |
| CashMovement | 1/1/1/0 | 1/0/0/0 |
| Promotion | 1/1/1/1 | 1/0/0/0 |
| StoreCredit | 1/1/1/0 | 1/0/0/0 |
| OverrideToken | 1/1/1/1 | **absent → 0/0/0/0** |
| Report | 1/0/0/0 | **absent → 0/0/0/0** |
| Settings | 1/0/1/0 | **absent → 0/0/0/0** |
| User | 1/1/0/0 | **absent → 0/0/0/0** |
| Role | 1/1/1/1 | **absent → 0/0/0/0** |
| Subscription | 1/0/1/0 | **absent → 0/0/0/0** |
| Device | 1/0/1/1 | **absent → 0/0/0/0** |
| Store | 1/0/1/1 | **absent → 0/0/0/0** |
| Invitation | 1/1/1/1 | **absent → 0/0/0/0** |
| OwnershipTransfer | 1/1/1/0 | **absent → 0/0/0/0** |
| UserRoleMapping | 1/1/1/1 | **absent → 0/0/0/0** |
| ShiftAssignment | 1/1/1/1 | **absent → 0/0/0/0** |
| PersonalExpense | 1/1/1/1 | 1/1/1/0 |
| PersonalBudget | 1/1/1/1 | 1/1/1/0 |
| Attachment | 1/1/1/1 | 1/1/0/0 |
| Note | 1/1/1/1 | 1/1/1/0 |
| Address | 1/1/1/1 | 1/1/1/0 |
| TaxRate | 1/1/1/1 | 1/0/0/0 |
| Lookup | 1/1/1/1 | 1/0/0/0 |

**RBAC-P01 — Default custom role cannot touch an "absent" entity at all (satisfied+violated pair)**
Priority: Critical. Arjun (Cashier, default seed only) calls `GET
/stores/{storeA}/devices` (`Device` is in `DEFAULT_ROLE_ABSENT`). Expected: 403
`PERMISSION_DENIED` even for `view` — absent means `NONE`, not "view only." Companion satisfied
case: Priya (`STORE_OWNER`) calls the same route → 200 (`STORE_OWNER_CRUD.Device.view === true`).

**RBAC-P02 — `User.delete` is false even for STORE_OWNER (modeled via UserRoleMapping instead)**
Priority: Critical. Traces to the code comment "user removal is modelled through
UserRoleMapping / invitation lifecycle." Priya calls `DELETE /stores/{storeA}/users/{id}`.
Expected: 403 — `STORE_OWNER_CRUD.User === VIEW_CREATE` (delete:false) by design; the only
sanctioned path to "remove" a user is revoking their `UserRoleMapping` (which **is**
`STORE_OWNER_CRUD.UserRoleMapping = FULL`, delete included). Verify no endpoint exists that
hard-deletes a `User` row via this permission path — that would violate BR-RBAC-017.

**RBAC-P03 — `CashMovement`/`StoreCredit`/`OwnershipTransfer` never allow delete, even for owner**
Priority: Critical (financial audit trail integrity). Priya attempts `DELETE
/stores/{storeA}/cash-movements/{id}`. Expected: 403 — `STORE_OWNER_CRUD.CashMovement ===
NO_DELETE`. Same expectation for `StoreCredit` and `OwnershipTransfer`. This protects an
append-only financial/audit trail even from the store owner.

**RBAC-P04 — Custom role explicitly granted an absent entity works exactly as scoped**
Priority: High. Meera (Shift Lead) is explicitly granted `Report.view` only (not `EXPORT`
special, not `create`/`edit`/`delete`). Steps: (a) `GET /stores/{storeA}/reports` → 200. (b)
`POST /stores/{storeA}/reports` (create) → 403. (c) `GET
/stores/{storeA}/reports/export` (`@RequireSpecial` EXPORT) → 403
`SPECIAL_PERMISSION_DENIED` — CRUD `view` grant does not imply the special action.

**RBAC-P05 — CRUD and special are independently gated on the same entity**
Priority: Critical. Traces to `PermissionsGuard.enforceCrud` + `enforceSpecial` running
independently (both must pass if both decorators are present). A route decorated
`@RequirePermissions({entity:'Order',action:'edit'}) @RequireSpecial({entity:'Order',
actionCode:'PRICE_OVERRIDE'})`. Case A: role has `Order.edit` but not `PRICE_OVERRIDE` → 403
`SPECIAL_PERMISSION_DENIED` (CRUD check alone would have passed). Case B: role has
`PRICE_OVERRIDE` special but not `Order.edit` CRUD → 403 `PERMISSION_DENIED` (special alone
insufficient). Both must be granted for 200.

**RBAC-P06 — `SUPER_ADMIN_CRUD`/`SPECIAL` are validated but never enforced (dead-config regression guard)**
Priority: Medium (documents current architecture, not a security hole because
`SuperAdminGuard` already gates the whole route boolean-style). Confirm no controller anywhere
combines `SuperAdminGuard` with `@RequirePermissions`/`@RequireSpecial` expecting
`SUPER_ADMIN_CRUD` to be consulted — if one ever does, `checkCrud`/`checkSpecial` would look up
`EffectivePermissions` built from `resolveFromDb`, which (per BR-RBAC-002) never includes a
system-wide role's grants — such a route would **always 403 a legitimate super-admin**, a nasty
latent bug if someone "helpfully" adds `@RequirePermissions` to an admin route in the future.
Recommend a lint/comment guard; see OQ-1.

**RBAC-P07 — Mid-session permission downgrade (owner removes a grant while cashier is using it)**
Priority: Critical. Traces to §5 "permission removed mid-session." Arjun has `Order.create`
active and is mid-checkout (cart open client-side, no server call yet). Owner revokes
`Order.create` from "Cashier" (bumps version for all members). Steps: Arjun submits the order.
Expected: version mismatch detected (`jwtPv !== permissionsVersion`) → cache busted → fresh
resolve → `Order.create` now false → 403 — the in-flight client-side cart is rejected
server-side, no order created. UX note: client should surface "your permissions changed,
refresh" rather than a generic error (flag to product/mobile team — not enforced by this
backend module).

**RBAC-P08 — Role expiry (`expiresAt`) mid-session, not just explicit revocation**
Priority: High. Traces to `findActiveRolesForUser`'s `or(isNull(expiresAt), gt(expiresAt,
now))` filter. Meera's "Shift Lead" role was granted with a 30-day expiry for a temporary
cover assignment; it expires while she's actively using it (server clock crosses the
boundary between two of her requests). Expected: the request immediately after expiry no
longer includes that role in `findActiveRolesForUser` (assuming no stale cache masks it inside
the TTL window — same BR-RBAC-009/BR06 staleness caveat applies here for critical vs. standard
ops).

**RBAC-P09 — Owner attempts to use their own store role in a store they don't own**
Priority: Critical. Priya's `STORE_OWNER` role row has `roles.storeFk = storeA`. She calls a
Store-B-scoped route for a store she has no relationship to at all (not her account). Expected:
`TenantGuard.userStoreIds(priya)` doesn't include Store C (unrelated) → 404
`STORE_NOT_ACCESSIBLE` before any `EffectivePermissions` lookup — same as BRAC-BR02, restated
for the owner role specifically (owners are not special-cased past the tenant boundary).

### 3.8 State transitions

**RBAC-S01 — Role assignment: active → revoked (legal)**
Priority: Critical. `userRoleMappings.revokedAt` set (soft-delete). Expected: subsequent
`findActiveRolesForUser` excludes it (`isNull(revokedAt)` filter); already-cached permissions
persist until version-bust/TTL as covered in BR06/BR06b.

**RBAC-S02 — Role assignment: revoked → re-revoked (illegal/no-op)**
Priority: Low. Calling revoke twice on an already-`revokedAt`-set mapping. Expected: idempotent
no-op (second call either errors "already revoked" at the service layer, or silently no-ops —
RBAC read-side (`findActiveRolesForUser`) behaves identically either way since the filter is
`isNull(revokedAt)`, already false).

**RBAC-S03 — Role assignment: expired → "reactivated" via `expiresAt` extension (legal, if supported)**
Priority: Medium. If the product allows extending `expiresAt` on an expired-but-not-revoked
mapping, verify `findActiveRolesForUser`'s `gt(expiresAt, now)` immediately picks it back up
with no separate "reactivate" flag needed — expiry is purely a timestamp comparison, not a
distinct state enum.

**RBAC-S04 — Role deletion: custom role soft-deleted while members still assigned (illegal path guard)**
Priority: High. Traces to `roles.deletedAt` + `isNull(roles.deletedAt)` filter in
`findActiveRolesForUser`. A custom role is deleted (soft) while 5 users still hold active
`userRoleMappings` against it. Expected: all 5 users immediately lose that role's grants on
their next resolve (join filters `isNull(roles.deletedAt)`) — verify the deletion flow also
calls `bumpPermissionsVersionForRole`/cache invalidation for those 5, or they ride the stale
cache for up to 5 minutes (same staleness class as BR06).

**RBAC-S05 — System role reassignment attempt (illegal — SYSTEM_ROLE_CODES immutability)**
Priority: Critical. Traces to BR-RBAC-005 / `SYSTEM_ROLE_CODES = {USER, STORE_OWNER,
SUPER_ADMIN}`. An owner attempts to create a custom role named `"STORE_OWNER"` or assign the
literal `STORE_OWNER` role to a second user via the normal role-management endpoint (not the
store-creation flow). Expected: rejected — reserved code, non-assignable/-revocable through
normal endpoints (per the code comment on `SYSTEM_ROLE_CODES`); verify the actual
role-management controller enforces this (this file only defines the constant — trace to the
consuming service/controller for the actual 4xx and error code, likely `ROLE_NOT_ASSIGNABLE`
per BR-RBAC-006, though that BR is phrased around invitations specifically).

**RBAC-S06 — Cache state: fresh → stale-but-live (standard) → expired (illegal read as "still valid")**
Priority: High. Covered by BR06/BR06b; restated as a pure state-machine case: verify there is
no code path that treats an *expired* (TTL-lapsed, key gone) entry as valid — `redis.get`
returning `null` always routes to the DB-resolve branch, never to a "trust the shape of a
`null`" bug.

**RBAC-S07 — Store lock state does not itself transition permissions (boundary of responsibility)**
Priority: Medium. `ResolvedStoreContext.isLocked` is written by `TenantGuard` but not consulted
by RBAC's own guards. Verify `PermissionsGuard` grants/denies purely on CRUD/special matrix
regardless of `isLocked` — locking enforcement is `SubscriptionStatusGuard`'s job, layered
separately. A regression where `PermissionsGuard` starts silently also checking `isLocked`
would double up (and potentially conflict with) that other guard's contract.

**RBAC-S08 — Route validity itself is a boot-time state: valid config → server running vs. invalid config → server never starts**
Priority: Critical. Restated from BR10/BR11 as the state-machine framing: there is no
"partially running with some routes unenforced" state — `RouteCoverageValidator` either passes
(server starts, all routes verified) or throws (process exits before `listen()`). Confirm no
code path allows the server to start serving traffic after a validator failure (e.g. a
try/catch somewhere upstream swallowing the bootstrap error) — check `main.ts`/bootstrap
entrypoint.

---

## 4. Edge-case scenarios (§5 checklist)

**RBAC-E01 — First-run: brand-new store, owner's very first request before role-seed completes**
If `seedStoreOwnerPermissions` fails or is slow (e.g. within the same transaction as store
creation, so this shouldn't be observable, but verify): the owner's very first API call
immediately after store creation must see full `STORE_OWNER_CRUD` grants, not a race where
`resolveFromDb` runs before the seed transaction commits. Since seeding is inside the
store-create transaction, this should be atomic — explicit test: create store, immediately
(same millisecond) call a store-owner-only route, expect 200 not 403.

**RBAC-E02 — First-run: new custom role created, zero members yet**
`seedDefaultPermissions` runs for a role with no `userRoleMappings` yet. Expected: no crash on
empty membership; `invalidateRoleMembersCache`/`bumpPermissionsVersionForRole` called later
(when the first member is assigned) operate correctly on a role that previously had zero
active members (`findActiveMemberIds` returns `[]`, `bumpPermissionsVersion([])` no-ops — both
already guard `.length === 0`).

**RBAC-E03 — Empty/zero: user with zero stores at all**
A newly-registered account holder with no store yet (`USER` system role only, no
`STORE_OWNER`/custom role anywhere). `userStoreIds` returns `[]`. Any store-scoped route → 404
`STORE_NOT_ACCESSIBLE` (correctly, since `accessibleIds.length === 0` short-circuits
`resolveAccessibleStore` before even querying).

**RBAC-E04 — Maximum: user with a very large number of accessible stores (franchise-scale account)**
An account owner with, say, 200 stores. `findAccessibleStoreIds`'s `UNION` query and the
cached `user_stores:{userId}` JSON array must handle 200 ids without truncation; confirm no
hard-coded array-size assumption anywhere (none observed in code, but worth a scale test given
this list is fully re-serialized to JSON on every cache write).

**RBAC-E05 — Duplicate/repeat: same role assigned to the same user twice (double `userRoleMappings` row)**
Priority: Medium. Whether by a UI double-submit or a race, a user ends up with two active
`userRoleMappings` rows for the identical `(userFk, roleFk)`. Expected: `findActiveRolesForUser`
returns two `ActiveRole` entries with the same `roleId` — downstream `fetchCrudPermissions`
re-fetches the same grants twice, `Set`/`Map` semantics in `resolveFromDb` make the duplication
harmless (last-write in a `for` loop over the same entity/action just re-sets the same `true`).
Confirm no unique-constraint violation is expected/needed at the DB level, or flag if one
should exist to prevent bookkeeping confusion during revocation (revoking one of the two rows
leaves the grant fully live via the other — is that intended, e.g. deliberate multi-grant
robustness, or an accidental duplicate that should have been prevented at assignment time?).

**RBAC-E06 — Out-of-order: permission grant DB commit arrives after the cache-bust signal**
Priority: High. If a future async/queued grant-processing path bumps `permissionsVersion`
*before* the corresponding `rolePermissions` insert actually commits (bad transaction ordering),
a request racing in between would see `jwtPv !== permissionsVersion` → bust cache → refetch →
still get the *old* (pre-grant) permissions, because the insert hasn't committed yet — but the
cache is now freshly re-populated with the stale answer for another full TTL. Verify all
current grant-mutation code paths bump `permissionsVersion` **after** the grant transaction
commits (order matters) — trace `seedDefaultPermissions`/role-permission-update service calls.

**RBAC-E07 — Offline → sync: mutation authorized when queued, permission revoked before sync**
Priority: Critical. Arjun creates an order offline at 10:00 (client-side, `Order.create` valid
at that moment). Owner revokes his role at 10:05. Arjun's device reconnects and syncs the
queued mutation at 10:10. Expected: sync path calls `wasCrudAuthorizedAt({..., asOf: <10:00
timestamp>})`, not a live `checkCrud` — returns `true` (he was authorized when queued) — the
sync-time live permission check would incorrectly reject a legitimately-queued action.

**RBAC-E08 — Offline → sync: mutation queued when NOT yet authorized, granted before sync**
Priority: High (inverse of E07). Arjun attempts an action offline at 10:00 he wasn't yet
authorized for (client-side check bypassed/stale), owner grants the permission at 10:05, sync
arrives at 10:10. Expected: `wasCrudAuthorizedAt(asOf: 10:00)` returns `false` — the later
grant does not retroactively authorize a point-in-time check anchored to 10:00. The mutation is
rejected at sync even though Arjun *currently* has the permission — by design (point-in-time,
not "authorized as of sync time").

**RBAC-E09 — Offline → sync: role revoked, then re-granted, before sync (revoke/re-grant sandwich)**
Priority: High. Grant active at 10:00 (asOf) → revoked at 10:02 → re-granted at 10:04 → sync at
10:10. Expected: `wasCrudAuthorizedAt`'s revocation check is `or(isNull(revokedAt),
gt(revokedAt, asOf))` against the specific grant row active *at 10:00* — if the 10:00 grant row
itself was the one revoked at 10:02, that specific row fails the check (`revokedAt(10:02) >
asOf(10:00)` is false since we need revokedAt > asOf... wait: `gt(revokedAt, asOf)` means the
row counts as "still active at asOf" only if it was revoked *after* asOf, which a 10:02 revoke
of a grant asOf=10:00 fails only if revokedAt(10:02) is compared > asOf(10:00) → true → counts
as active. This needs a precise trace-through with real timestamps in an actual test, since the
three-event ordering (grant/revoke/re-grant, all before asOf's "now" but around asOf itself) is
exactly the kind of off-by-one a QA case must nail down concretely, not verbally.
Notes: **write this as an executable test rather than trust this document's prose** — the
predicate is `lte(grantedAt, asOf) AND (revokedAt IS NULL OR revokedAt > asOf)`, which is
correct for "was this row live at asOf," but a revoke-then-re-grant produces a *second* row;
confirm the query's `innerJoin` doesn't need `OR across multiple grant rows` handling beyond
what a plain `WHERE` naturally gives (it does — any matching row satisfies `EXISTS`-style
`.limit(1)`).

**RBAC-E10 — Permission/subscription change mid-flow: role revoked between TenantGuard and PermissionsGuard**
Priority: High. Vanishingly small window, but real: revocation DB-commits in the microseconds
between `TenantGuard` resolving `request.context.storeId` and `PermissionsGuard` calling
`getCachedPermissions`. Expected: `PermissionsGuard` reads permissions fresh (or from a cache
already busted by the version check) at its own point in time — this is just normal
`resolveFromDb` behavior, no special handling needed, included here only to confirm there's no
assumption that "permissions were already established by TenantGuard" (they aren't — TenantGuard
only resolves store identity, `PermissionsGuard` is the sole permission-resolution point).

**RBAC-E11 — Abandonment: client abandons mid-checkout after a permission check passed but before mutation commits**
Priority: Medium. RBAC-scope note only: `PermissionsGuard` passing does not itself hold any
lock/reservation — if the client abandons after the 200-equivalent guard pass but before the
downstream handler finishes, no RBAC state needs cleanup (guards are stateless per-request).
Confirms RBAC has no "pending authorization" state to leak.

**RBAC-E12 — Time: clock skew between the app server and the DB affects `expiresAt`/critical-TTL math**
Priority: Medium. `resolvedAt` and `ageMs` are computed from `Date.now()` on the **app server**,
while `expiresAt`/`revokedAt` comparisons in SQL use `now()` on the **DB server**. If the two
clocks drift by, say, 90 seconds, a role could appear expired in the DB slightly before/after
the app server's cache considers it stale, or vice versa. Not itself a bug (both are internally
consistent), but flag as an operational risk worth monitoring (NTP drift alerting), not a code
fix — OQ-12.

**RBAC-E13 — Long/unusual input: extremely long custom role name / entity code probing**
Priority: Low. A crafted `@RequirePermissions({entity: 'A'.repeat(10000) as EntityCode, ...})`
can't actually happen (entity is a compile-time literal in decorators, not user input) — but
`readScopedSource`'s `raw` (store id from `param`/`query`/`body`/`header`) **is** fully
user-controlled and could be an extremely long string. Expected: `resolveAccessibleStore`'s
`accessibleIds.includes(raw)` is a simple array membership check — a 100KB garbage string
simply won't match any real store id, falls through to 404, no crash, no ReDoS (no regex
involved in this path).

**RBAC-E14 — Device/platform: mobile offline replay header spoofing (`X-Client-Mode: offline_replay`)**
Priority: High. Traces to `@OnlineOnly()`. A malicious/buggy client sends
`x-client-mode: offline_replay` on a live, connected request to bypass some online-only
business rule via replay semantics. Expected: `PermissionsGuard` rejects with `403
ONLINE_REQUIRED` regardless of whether the request is *actually* an offline replay — the header
itself is the sole signal RBAC trusts; this is a coarse but effective gate, not a
replay-authenticity check (that lives elsewhere, e.g. nonce/timestamp replay protection per
`docs/backend/rbac.md` BR-RBAC-013). Confirm `@OnlineOnly` routes are exactly the ones where
this coarseness is acceptable (i.e. not relying on it as the *only* replay defense).

**RBAC-E15 — Location-removal regression: no orphaned `@LocationContext`/`LocationGuard` reference remains**
Priority: Critical (this diff's biggest structural change). Since `location.guard.ts`,
`LOCATION_CONTEXT_KEY`, `@LocationContext`, `ResolvedStoreContext.locationId`, the `Location`
entity, and `STORE_OWNER_CRUD.Location` were all deleted in this diff: (a) confirm the project
still **compiles** (a controller still referencing the deleted `LocationGuard`/`@LocationContext`
would be a TypeScript compile error, not a runtime gap — verify via `tsc`/`nx build` rather than
just grep, since grep already found zero remaining references); (b) confirm `RouteCoverageValidator`
no longer requires or references `LOCATION_CONTEXT_KEY` (confirmed by diff); (c) — the
substantive regression risk — **any product requirement that previously relied on
location-level scoping ("this cashier can only see Location X's orders/inventory/shifts") is
now completely unenforced at the store level**: a role granted `Order.view`/`Inventory.view` at
the store grants visibility/action across every location physically operated under that store.
This must be explicitly confirmed as an accepted, intentional descope (OQ-4) before this ships,
since it is a silent capability-widening for any store that previously depended on
location-level isolation.

**RBAC-E16 — Location-removal regression: DB schema no longer references `locations`/`user_location_mappings`**
Priority: High. Confirm the `locations`/`userLocationMappings` Drizzle schema tables and any
pending/applied migration cleanly remove or leave inert the underlying DB tables — grep
confirms zero references in `schema.ts` post-diff; verify the migration journal
(`apps/backend/drizzle/meta/_journal.json`, shown modified in git status) actually drops or
intentionally retains those tables, and that no other module (sync engine, reports) still
queries them directly, bypassing RBAC's already-completed removal.

---

## 5. Coverage summary matrix

| Requirement / Rule | Satisfied case(s) | Violated case(s) | Gap? |
|---|---|---|---|
| BR-RBAC-001 (route coverage: guard presence) | BR09, BR12 | BR09(violated half), BR10, BR11 | none |
| BR-RBAC-002 (store isolation, no cross-store bleed) | BR01, H01, C04 | BR02, BR18, P09 | none |
| BR-RBAC-003 (union of roles) | H08, BR03 | BR04 | none |
| BR-RBAC-004 (reads never subscription-blocked) | BR07 | — (owned by SubscriptionStatusGuard, out of RBAC scope) | boundary-of-responsibility only |
| BR-RBAC-007 (denial audit before 403) | H03 (implicit) | F06 | **contradiction found — OQ-10** |
| BR-RBAC-008 / H-6 (version-mismatch cache bust) | BR05 | — (mismatch is itself the "trigger," not a pass/fail rule) | none |
| BR-RBAC-009 (critical 30s TTL) | B01 | BR06 | none, BR06b documents the asymmetric read-side behavior |
| BR-RBAC-010 (point-in-time offline auth) | E07, E09 | E08 | E09 needs an executable test, not just prose |
| BR-RBAC-011 (timing-oracle-safe 404) | — | BR02 | none |
| BR-RBAC-014 (STORE_OWNER_CRUD full coverage) | — (boot passes today) | BR13 | none |
| BR-RBAC-015 (SCREAMING_SNAKE special codes) | — (all current codes pass) | BR14, B07 | none |
| BR-RBAC-018 (corrupt cache = safe miss) | N06–N10 | — (all cases here are inherently "violation → safe recovery") | none |
| New rule: `@RequireSpecial` alone forces PermissionsGuard | BR09 (satisfied half) | BR09 (violated half) | none |
| Custom-role default seed vs absent entities | P01 (satisfied), matrix table | P01 (violated) | none |
| CRUD × special independence | P05 (case A + B) | P05 | none |
| Role state: active→revoked, active→expired, deleted-role cascade | S01, S03 | S04 (cascade timing) | S02/S05 need controller-level trace-through, not just this module |
| SUPER_ADMIN_CRUD/SPECIAL wiring | — | P06 | **confirmed dead config — OQ-1**, not itself a failing test but a design question |
| Location entity/guard full removal | E15, E16 | — | **OQ-4/OQ-5 — needs explicit product sign-off**, not a code defect |

**Gaps requiring resolution before this module is production-signed-off:**
1. OQ-10 (F06): `docs/backend/rbac.md` BR-RBAC-007 says audit failure should fail-closed
   (propagate); the shipped `permissions.guard.ts` code explicitly swallows audit failures and
   still throws the 403. These are different behaviors for "what happens to the *request*" (both
   end in the same 403 either way, so functionally this may be a non-issue) but very different
   for *"does an audit-pipe outage ever allow silent unaudited denials to pile up without
   alerting"* — needs a decision, then either the code or the PRD updated to match.
2. OQ-9 (F04): confirm the role-revocation call site wraps `invalidateUserStoreCache` in its
   own error handling so a Redis outage during a revocation can't fail the revocation request
   itself (the DB-side revoke should always commit even if cache-busting fails, and the cache
   should self-heal within the 5m/30s TTL regardless).
3. OQ-4/OQ-5: explicit product sign-off that location-level scoping is intentionally descoped
   for this release, not an accidental deletion.

---

## 6. Priority roll-up (run first)

**Critical (money / auth / data-integrity / concurrency / cross-tenant):**
BR02, BR06, BR08, BR09, BR10, BR11, BR13, BR18, N01, N03, N04, N06, F01, F03, F04, F05, F06,
C02, C07, P01, P02, P03, P05, P07, P09, S01, S05, S08, E07, E08, E15, H01, H05.

**High:** BR01, BR04, BR05, BR06b, BR12, BR14, BR17, N02, N05, N07, N11, F02, F09, C01, C03,
C06, P04, P06, P08, S04, S06, E05, E06, E09, E10, E14, E16, H02–H04, H06, H08, B01, B03, B04, B08.

**Medium:** BR15, BR16, N08–N10, N12, F08, C04, C05, C08, S02, S03, S07, E01–E04, E11, E12,
B02, B05–B07, B09.

**Low:** BR10-restated variants, F10, C06 (data-cleanliness half), S02, B06, B10, E13.

Test in roughly this order: boot-time integrity/route-coverage (BR08–BR16, S08) → tenant
isolation (BR01/BR02/P09/C07) → cache correctness/staleness (BR05/BR06/BR06b/B01) → CRUD/special
matrix per role (P01–P05, full matrix table) → offline point-in-time (E07–E09) → failure modes
(F01–F09) → concurrency (C01–C08) → remaining edge cases.

---

## 7. Open questions

- **OQ-1** — `SUPER_ADMIN_CRUD`/`SUPER_ADMIN_SPECIAL` are defined, boot-validated, but never
  read by any guard or service (`SuperAdminGuard` is a boolean membership check only). Is this
  matrix intended for future wiring (entity-granular admin permissions), or should it be
  removed/marked explicitly experimental to avoid a future contributor assuming it's live?
- **OQ-2** — `STORE_OWNER_SPECIAL` and `SUPER_ADMIN_SPECIAL` are byte-for-byte identical to the
  full `SPECIAL_ACTIONS` catalogue (every declared action, no exceptions). Is it intentional
  that a store owner and platform super-admin have exactly the same special-action reach (e.g.
  both can `TRANSFER_OWNERSHIP`, both can `REMOTE_WIPE` any device)? Worth an explicit
  "yes, by design" confirmation given how sensitive `TRANSFER_OWNERSHIP`/`REMOTE_WIPE` are.
- **OQ-3** — `PRICE_OVERRIDE` and `DISCOUNT_APPLY` on `Order` are **not** in
  `CRITICAL_SPECIAL_ACTIONS` (5m TTL, not 30s). Given these directly affect transaction amounts,
  should they be critical like `REFUND`/`VOID`? Confirm with product/finance.
- **OQ-4** — The entire `Location` scoping layer (entity, guard, decorator, context field) was
  deleted in this diff. Is sub-store location isolation intentionally descoped for this
  release (with a plan to reintroduce later per `docs/backend/rbac.md` §26.1–26.3, which still
  describes it as *target* design), or was this an unintended regression from a rebase/merge?
  This materially changes what "correct" means for every test in §3.7/§4 E15.
- **OQ-5** — If location scoping returns later, will `docs/backend/rbac.md` §26 (which
  currently describes location as a *target*, not-yet-built feature) be reconciled with the
  fact that a *working* `LocationGuard` existed and was then removed? The PRD and code history
  are currently telling two different stories about maturity level.
- **OQ-6** (BR06b) — A revoked custom role's grants can still authorize `view`/read actions for
  up to ~5 minutes (standard cache TTL) after revocation, by design. Is that acceptable for all
  entities, or should certain sensitive reads (e.g. `Report.VIEW_HISTORY`, `Customer.EXPORT`)
  also be pinned to the 30s critical TTL even though they're `view`/non-critical-special today?
- **OQ-7** — Should `fetchCrudPermissions`/`resolveFromDb` defensively validate
  `rolePermissions.action` against `isCrudAction` the same way it already defensively validates
  `entityCode` against `isEntityCode`, in case the DB enum is ever loosened or a migration
  leaves a decommissioned action value behind?
- **OQ-8** — `@StepUpAuth({within})` duration parsing (`parseDurationMs`) throws at **request
  time** on a malformed spec, not at boot alongside the other matrix-integrity checks. Should
  this be validated at startup so a bad spec fails the deploy instead of 500ing every live
  request to that route?
- **OQ-9** — Does the role-revocation service wrap `RbacService.invalidateUserStoreCache` in
  its own error handling, so a Redis outage during revocation can't fail the revocation
  request itself? (This file's method has no try/catch of its own, unlike the read/write cache
  paths in the same service.)
- **OQ-10** — `docs/backend/rbac.md` BR-RBAC-007 states a failed audit write should
  "reject and propagate to the caller (fail-closed)," but `permissions.guard.ts`'s `denyAudit`
  explicitly catches and swallows audit failures, still throwing the original `ForbiddenException`
  regardless. Which behavior is actually intended — best-effort audit (current code) or
  fail-closed on audit-pipe outage (current PRD text)? These differ on whether an audit-pipe
  outage should ever surface as a 500 (alerting signal) vs. silently continue denying without a
  paper trail.
- **OQ-11** — Is there a DB unique constraint on `(roleFk, entityCode, action)` for
  `rolePermissions` and `(roleFk, entityCode, actionCode)` for `roleSpecialPermissions`, to
  prevent duplicate-but-harmless grant rows from accumulating (relevant to clean revocation
  bookkeeping, not to live enforcement correctness)?
- **OQ-12** — What is the acceptable clock-skew tolerance between the app server(s) (source of
  `Date.now()` for cache freshness) and the DB server (source of `now()` for
  `expiresAt`/`revokedAt` comparisons)? Worth an explicit NTP-drift monitoring/alerting
  recommendation given how much of this module's correctness (30s critical window especially)
  depends on both clocks agreeing.