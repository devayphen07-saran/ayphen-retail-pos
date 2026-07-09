# QA Test Cases — Lookup + Reference Data

**Scope:** `apps/backend/src/lookup/**` and `apps/backend/src/reference-data/**`
**Mode:** QA (read from actual implementation) + BA (rules restated from code/comments/schema)
**Author:** BA/QA agent (per `docs/agent/CLAUDE-ba-qa-testcases.md`)
**Date:** 2026-07-08

---

## 0. Endpoint inventory (as implemented)

| # | Method & Path | Controller | Guards (in order) | Permission | Notes |
|---|---|---|---|---|---|
| 1 | `GET /countries` | `ReferenceDataController` | `MobileJwtGuard` | none | `StoreContext('none')`. Any authenticated user, any store/subscription state. |
| 2 | `GET /currencies` | `ReferenceDataController` | `MobileJwtGuard` | none | Same as above. |
| 3 | `GET /lookup/types` | `LookupTypeController` | `MobileJwtGuard`, `SuperAdminGuard` | platform SUPER_ADMIN only | `StoreContext('none')`. Not reachable by ordinary store users. |
| 4 | `POST /lookup/types` | `LookupTypeController` | `MobileJwtGuard`, `SuperAdminGuard` | platform SUPER_ADMIN only | Creates a new lookup category. No update/deactivate endpoint exists. |
| 5 | `GET /lookup/:typeCode/values` | `LookupValuesController` | `MobileJwtGuard` only | none | `StoreContext('none')`. Returns **global-only** values (`store_fk IS NULL`). No `TenantGuard`/`PermissionsGuard`/`SubscriptionStatusGuard` — usable before a store exists (create-store wizard). |
| 6 | `GET /stores/:storeId/lookup/:typeCode/values` | `LookupController` | `MobileJwtGuard`, `TenantGuard`, `PermissionsGuard`, `SubscriptionStatusGuard` | `Lookup.view` | Returns global + this store's custom active/non-hidden values. Reads are never blocked by `SubscriptionStatusGuard` (GET is in `READ_METHODS`). |
| 7 | `POST /stores/:storeId/lookup/:typeCode/values` | `LookupController` | same stack | `Lookup.create` | Creates a store-custom value (`is_system=false`). |
| 8 | `PATCH /stores/:storeId/lookup/values/:guuid` | `LookupController` | same stack | `Lookup.edit` | Optimistic-locked update (`expected_row_version` required). |
| 9 | `DELETE /stores/:storeId/lookup/values/:guuid` | `LookupController` | same stack | `Lookup.delete` | Soft delete (`is_active=false`), `204`. |

**No caching layer of any kind for the lookup/reference data itself** — every read is a direct Postgres query. (RBAC *permissions* are Redis-cached by `PermissionsGuard`/`RbacService`, and the *subscription* snapshot is Redis-cached by `SubscriptionStatusGuard`, but the lookup/reference-data rows themselves are never cached — so there is no staleness/invalidation problem for the data itself: a write is visible on the very next read.)

---

## 1. Feature understanding (BA)

### 1.A Lookup module (`src/lookup/**`)

**What it is:** A generic, user-extensible dropdown-value engine. `lookup_type` is the category (`PAYMENT_TERMS`, `REASONS`, `BUSINESS_CATEGORY`, `STATE`, …, ~19 seeded categories); `lookup` holds the values under each category. Values are either:
- **System/global** (`is_system=true`, `store_fk=NULL`) — seeded once, shared by every account/store, read-only via the API.
- **Store-custom** (`is_system=false`, `store_fk=<storeId>`) — created by a store's own users, editable/deletable only by that store.

**Actors:**
- **Platform super-admin** — manages `lookup_type` categories (`/lookup/types`).
- **Any authenticated mobile user** (any role, even with no store yet) — reads global values via `/lookup/:typeCode/values` (used by the create-store wizard for `BUSINESS_CATEGORY` / `GST_REGISTRATION_TYPE` / `STATE` before a store exists).
- **Store member with `Lookup.view`** (granted to every default custom role) — reads merged global+store values via `/stores/:storeId/lookup/:typeCode/values`.
- **Store owner** (or a custom role explicitly granted `Lookup.create`/`edit`/`delete` — only `STORE_OWNER` gets these by default) — manages store-custom values.

**Inputs/outputs:** JSON REST, snake_case on the wire (`LookupValueMapper`/`LookupTypeMapper`), camelCase internally.

**Business rules / invariants (as implemented):**
- **BR-1 (system protection):** a value with `is_system=true` can never be edited or deleted via the API.
- **BR-2 (store ownership):** only the owning store can edit/delete its own custom value; a value from another store (or a global value) is **404**, not 403 — existence is not leaked cross-tenant.
- **BR-3 (visibility):** listing merges global (`store_fk IS NULL`) + this store's own (`store_fk = storeId`) values, filtered to `is_active=true AND is_hidden=false`, ordered by `sort_order`, capped at 500 rows (defensive, not real pagination — no `limit`/`offset`/`cursor` params exist).
- **BR-4 (uniqueness):** `code` must be unique **per lookup type, across ALL stores** (`uk_lookup_type_code` is a plain, non-partial unique index on `(lookup_type_fk, code)` — it does **not** exclude soft-deleted rows). Two different stores cannot both have a custom value with the same code under the same type, and **a soft-deleted value's code is never released for reuse** (see §7 Open Questions — this looks unintended).
- **BR-5 (optimistic locking on update):** `PATCH` requires `expected_row_version`; a stale version yields `409 LOOKUP_VALUE_VERSION_CONFLICT` with the current version in `details.currentRowVersion`. `row_version` is only bumped by `updateValue` — **soft-delete does not bump it.**
- **BR-6 (soft delete):** `DELETE` sets `is_active=false`; there is **no restore/reactivate endpoint** (`is_active` is not settable via `UpdateLookupValueDtoSchema`), and a deleted value's code stays permanently blocked from reuse (BR-4).
- **BR-7 (type resolution):** every values endpoint resolves `typeCode` via an exact, case-sensitive `eq()` lookup against `lookup_type.code`; unknown code → `404 LOOKUP_TYPE_NOT_FOUND`.

**Acceptance criteria (inferred):**
- Global wizard dropdowns work with zero store context and zero subscription/permission checks.
- Store dropdowns show system + store-custom values, never another store's custom values.
- Only `STORE_OWNER`-tier permission can mutate store-custom values; system values are immutable everywhere.
- Concurrent edits never silently last-write-win; the client is told to refresh.

**State machine (lookup value):**
```
                 create (is_active=true, is_hidden=false, row_version=1)
                        │
                        ▼
        ┌────────► ACTIVE / VISIBLE ◄────────┐
        │ (edit, row_version++)              │ (edit is_hidden=false)
        │                                     │
        ▼                                     │
ACTIVE / HIDDEN (is_hidden=true) ──────────────┘
        │
        │ (delete, any state, row_version unchanged)
        ▼
   INACTIVE (is_active=false)  ── no transition back exists via API ──► (dead end)
        │
        └─ BUG/GAP: PATCH's WHERE clause doesn't check is_active, so an
           inactive row can still be "edited" (label/description/sort_order/
           is_hidden changed, row_version bumped) while remaining invisible
           to every listing query. See §7.
```

**Assumptions/ambiguities flagged (confirm with product/dev):**
1. Is BR-4's "code blocked forever after delete, even across stores" intentional, or should the unique constraint be partial (`WHERE is_active`) / scoped per-store?
2. Is it intentional that `PATCH` can silently mutate a soft-deleted (`is_active=false`) row? Should it 404/409 instead?
3. Is it intentional that lookup **types** have no update/deactivate endpoint (create-only, forever)?
4. Is it intentional that `GET /lookup/:typeCode/values` (global) has **zero** RBAC/subscription/store gating — reachable by any authenticated user regardless of role or subscription state?
5. Is `sort_order` meant to allow negative values / arbitrarily large values (no bounds in the Zod schema beyond `int()`), given the DB column is a 32-bit `integer`?

### 1.B Reference-data module (`src/reference-data/**`)

**What it is:** Two static/semi-static master tables — `country` (ISO 3166-1 alpha-2 + calling code) and `currency` (ISO 4217 + symbol) — exposed read-only, account-level (not store-scoped), for dropdowns needed before a store exists (e.g. address country, currency picker in the create-store wizard).

**Actors:** any authenticated mobile user (`MobileJwtGuard` only — no `TenantGuard`, no permission check, no subscription check).

**Business rules:**
- **BR-8:** only `is_active=true` rows are ever returned; there is no way for a client to request inactive/all rows, and no filtering/search/pagination parameters exist at all.
- **BR-9:** no `ORDER BY` clause on either query — row order is **not guaranteed** by SQL semantics (currently stable only because Postgres tends to return heap order for an unmodified table; this is not a documented guarantee).
- **BR-10:** `CountryRepository`/`CurrencyRepository` have no row cap (`listActive` runs unbounded) — safe today (~250 countries / ~180 currencies) but is a "bound everything" gap if the tables ever grow unexpectedly.

**Acceptance criteria:** any authenticated user gets the full active country/currency list, unfiltered, regardless of their store/subscription/permission state.

---

## 2. Coverage plan

| Dimension | Applies? | Approx. cases |
|---|---|---|
| Happy paths | Yes | 10 |
| Business rules (satisfied + violated) | Yes | 20 |
| Boundaries | Yes | 14 |
| Negative/invalid | Yes | 16 |
| Failure & recovery | Yes (Redis/DB dependency paths) | 6 |
| Concurrency | Yes (row_version race, duplicate-code race, concurrent delete+edit) | 7 |
| Permissions/roles | Yes (Lookup.view/create/edit/delete, SUPER_ADMIN, tenant isolation) | 12 |
| State transitions | Yes (active→hidden→inactive, illegal transitions) | 8 |
| Cross-cutting (tenancy, subscription gating, offline replay) | Yes | 10 |
| UX/experience | Partial — backend-only scope, so covered as response-shape/empty-state cases | 6 |

Total: **~109 cases** below (grouped by area within each endpoint group).

---

## 3. Test cases

### 3.1 Reference Data — `GET /countries`, `GET /currencies`

**RD-01 — Happy path: list countries**
Area: happy | Criticality: High | Traces to: BR-8
Preconditions: authenticated user with a valid JWT, no store required.
Input/Data: `GET /countries`
Steps: 1) Call with valid `Authorization: Bearer <jwt>`.
Expected result: `200`, JSON array of `{code, name, calling_code}` for every `is_active=true` country (e.g. `{code:"IN", name:"India", calling_code:"91"}`); inactive countries excluded.

**RD-02 — Happy path: list currencies**
Area: happy | Criticality: High | Traces to: BR-8
Input/Data: `GET /currencies`
Expected result: `200`, array of `{code, name, symbol}` (e.g. `{code:"INR", name:"Indian Rupee", symbol:"₹"}`), only active rows.

**RD-03 — No store / no subscription required**
Area: rule (satisfied) | Criticality: High | Traces to: 1.B actors, `StoreContext('none')`
Preconditions: user has zero stores created yet (mid create-store wizard); OR user's account subscription is `expired`/`paused`.
Steps: `GET /countries` and `GET /currencies`.
Expected result: `200` in both cases — never blocked by store absence or subscription status (no `TenantGuard`/`SubscriptionStatusGuard` on this controller).

**RD-04 — Inactive country/currency excluded**
Area: rule (satisfied) | Criticality: Medium | Traces to: BR-8
Preconditions: a country row exists with `is_active=false` (e.g. a deprecated/merged territory code).
Steps: `GET /countries`.
Expected result: the inactive row is **not** present in the response.

**RD-05 — Empty table**
Area: boundary (empty) | Criticality: Low | Traces to: BR-8
Preconditions: `country`/`currency` tables empty (fresh env, seed not yet run).
Steps: `GET /countries`, `GET /currencies`.
Expected result: `200`, `[]` — not an error, not `404`.

**RD-06 — Missing/invalid JWT**
Area: negative | Criticality: Critical | Traces to: `MobileJwtGuard`
Input/Data: no `Authorization` header, or an expired/tampered JWT.
Expected result: `401 Unauthorized` (`MISSING_AUTH`/JWT-invalid code); no data leaked.

**RD-07 — No client-side filtering/search available**
Area: negative | Criticality: Low | Traces to: BR-8 (no query params implemented)
Input/Data: `GET /countries?search=ind`, `GET /countries?is_active=false`.
Expected result: query params are silently ignored — full active list returned regardless (documents current behavior; not a bug, just "no such feature").

**RD-08 — Ordering not guaranteed**
Area: edge/UX | Criticality: Low | Traces to: BR-9
Steps: seed/update a country row (e.g. re-save "India" via a migration) and call `GET /countries` twice.
Expected result: no documented/guaranteed order; if the client sorts client-side (by `name`) this is a non-issue — flag if the mobile client assumes server order is stable, since there's no `ORDER BY`.

**RD-09 — Large reference table (scale boundary)**
Area: boundary | Criticality: Low | Traces to: BR-10
Preconditions: hypothetically thousands of currency rows (e.g. future crypto-currency support).
Expected result: no pagination exists — the endpoint would return everything in one payload; flag as a scale risk, not a currently-reproducible bug (only ~180 ISO currencies exist today).

**RD-10 — Concurrent read during a reference-data migration**
Area: failure/consistency | Criticality: Medium | Traces to: BR-8, no caching
Preconditions: a DB migration is mid-flight adding new countries (e.g. adding a new ISO code).
Steps: call `GET /countries` while the migration transaction is uncommitted.
Expected result: standard Postgres read-committed semantics — reader sees only committed rows; no partial/uncommitted rows ever returned (no app-level risk here since there's no caching to go stale).

---

### 3.2 Lookup Types — `GET/POST /lookup/types` (platform admin)

**LTY-01 — Happy path: super-admin lists types**
Area: happy | Criticality: Medium | Traces to: 1.A actors
Preconditions: caller holds the platform `SUPER_ADMIN` role.
Steps: `GET /lookup/types`.
Expected result: `200`, all ~19 seeded categories plus any created since, `{code, title, description}` each — **including inactive ones** (`listAll()` has no `is_active` filter, unlike value listing).

**LTY-02 — Happy path: super-admin creates a new category**
Area: happy | Criticality: Medium | Traces to: 1.A
Input/Data: `POST /lookup/types` `{ "code": "LOYALTY_TIER", "title": "Loyalty Tier", "description": "Customer loyalty tiers" }`
Expected result: `201`/`200` with `{code:"LOYALTY_TIER", title:"Loyalty Tier", description:"..."}`; row created `is_active=true` by default; audit event `LOOKUP_TYPE_CREATED` logged.

**LTY-03 — Non-admin blocked (permission, violated)**
Area: permission | Criticality: Critical | Traces to: `SuperAdminGuard`
Preconditions: caller is a `STORE_OWNER` (not platform admin).
Steps: `GET /lookup/types`, `POST /lookup/types`.
Expected result: `403 PERMISSION_DENIED` for both — ordinary store users, including owners, can never reach this controller.

**LTY-04 — Duplicate type code (rule, violated)**
Area: rule/negative | Criticality: High | Traces to: BR-4-analog on `lookup_type.code`
Preconditions: `PAYMENT_TERMS` already exists.
Input/Data: `POST /lookup/types` `{code:"PAYMENT_TERMS", title:"Dup"}`
Expected result: `409 LOOKUP_CODE_EXISTS`, `"A lookup with this code already exists"`; no row created.

**LTY-05 — Concurrent identical create (concurrency)**
Area: concurrency | Criticality: High | Traces to: service comment on TOCTOU
Steps: two super-admin requests `POST /lookup/types {code:"LOYALTY_TIER", ...}` fire simultaneously.
Expected result: exactly one succeeds (`200`/`201`); the other gets `409 LOOKUP_CODE_EXISTS` via the DB unique-violation catch (`rethrowUniqueViolationAs`), not a `500` and not two rows created.

**LTY-06 — Validation: missing/invalid fields**
Area: negative | Criticality: High | Traces to: `CreateLookupTypeDtoSchema`
Input/Data: `POST /lookup/types {}` ; `{code:"", title:"X"}` ; `{code:"X".repeat(41), title:"X"}` ; `{code:"X", title:""}` ; `{code:"X", title:"X".repeat(81)}` ; `{code:"X", title:"X", description:"D".repeat(201)}`
Expected result: `422 UNPROCESSABLE_ENTITY`, `errorCode: VALIDATION_FAILED`, `message` array with one entry per violated field (e.g. `"code: String must contain at least 1 character(s)"`). No row created for any variant.

**LTY-07 — No update/deactivate endpoint (gap)**
Area: state/gap | Criticality: Medium | Traces to: assumption #3
Steps: attempt `PATCH /lookup/types/:code` or `DELETE /lookup/types/:code`.
Expected result: `404` (route doesn't exist) — confirms categories are permanently create-only via this API today; flag as an open question, not a bug per se.

**LTY-08 — Unicode/long input in title/description**
Area: boundary | Criticality: Low | Traces to: `CreateLookupTypeDtoSchema`
Input/Data: `{code:"EMOJI_TEST", title:"🎉 Loyalty 忠诚度", description:"a".repeat(200)}` (exactly at max)
Expected result: `200`/`201`, stored and returned verbatim (UTF-8 safe); 200-char description accepted (boundary at-limit case), 201-char rejected (see LTY-06 variant).

---

### 3.3 Lookup Values — Global, no store — `GET /lookup/:typeCode/values`

**LVG-01 — Happy path: wizard reads BUSINESS_CATEGORY before any store exists**
Area: happy | Criticality: Critical | Traces to: 1.A actors, BR-3
Preconditions: authenticated user has zero stores.
Steps: `GET /lookup/BUSINESS_CATEGORY/values`.
Expected result: `200`, the 10 seeded global values (`GROCERY`, `PHARMACY`, …, `OTHER`), each `{guuid, code, label, description, sort_order, is_system:true, row_version}`; no `storeId` needed anywhere in the request.

**LVG-02 — Happy path: STATE dropdown for GST**
Area: happy | Criticality: High | Traces to: BR-3
Steps: `GET /lookup/STATE/values`.
Expected result: `200`, all seeded Indian states/UTs (`01 Jammu and Kashmir` … `27 Maharashtra`, etc.), ordered by `sort_order`.

**LVG-03 — Unknown type code**
Area: negative | Criticality: High | Traces to: BR-7
Input/Data: `GET /lookup/NOT_A_REAL_TYPE/values`
Expected result: `404 LOOKUP_TYPE_NOT_FOUND`.

**LVG-04 — Case sensitivity**
Area: boundary/negative | Criticality: Medium | Traces to: BR-7 (`eq()` exact match)
Input/Data: `GET /lookup/business_category/values` (lowercase)
Expected result: `404 LOOKUP_TYPE_NOT_FOUND` — codes are case-sensitive; the mobile client must send the exact seeded casing.

**LVG-05 — Global endpoint never returns store-custom values**
Area: rule/tenancy | Criticality: Critical | Traces to: docstring "a value stored under a specific store is never returned here"
Preconditions: Store A has added a custom `DISCOUNT_TYPE` value `LOYALTY10`.
Steps: call `GET /lookup/DISCOUNT_TYPE/values` (global endpoint) as any user, including a Store A member.
Expected result: `200`, only the 3 seeded global values (`PERCENT`, `FLAT`, `SCHEME`) — `LOYALTY10` is **absent**, even for Store A's own users, on this endpoint.

**LVG-06 — No RBAC/subscription gating**
Area: permission (satisfied — intentionally open) | Criticality: High | Traces to: assumption #4
Preconditions: caller's account subscription is `expired` (`PAYMENT_REQUIRED_STATUSES`), or caller has a role with zero permissions granted.
Steps: `GET /lookup/PAYMENT_TERMS/values`.
Expected result: `200` regardless — this route has no `TenantGuard`/`PermissionsGuard`/`SubscriptionStatusGuard`, by design (must work pre-store/pre-subscription-check). Confirm this is intentional (assumption #4), since it means a lapsed account still gets full read access to every global lookup category via this path.

**LVG-07 — Hidden global value excluded**
Area: rule | Criticality: Medium | Traces to: BR-3
Preconditions: a global value has `is_hidden=true` (deprecated system option).
Steps: `GET /lookup/<type>/values`.
Expected result: hidden value excluded from the array.

**LVG-08 — Empty category (zero global values)**
Area: boundary (empty) | Criticality: Low | Traces to: BR-3
Preconditions: a newly-created lookup type (via LTY-02) has no values yet.
Steps: `GET /lookup/LOYALTY_TIER/values`.
Expected result: `200`, `[]`.

**LVG-09 — Response shape / field mapping correctness**
Area: UX/contract | Criticality: Medium | Traces to: `LookupValueMapper`
Expected result: every item has exactly `{guuid, code, label, description, sort_order, is_system, row_version}` in snake_case; `description` is `null` (not omitted) when absent; `is_system:true` for every row returned here (global-only).

---

### 3.4 Lookup Values — Store-scoped list — `GET /stores/:storeId/lookup/:typeCode/values`

**LVS-01 — Happy path: merged global + store-custom list**
Area: happy | Criticality: Critical | Traces to: BR-3
Preconditions: Store S has a custom `REASONS` value `SHRINKAGE` (`Shrinkage`, `sort_order:99`).
Steps: `GET /stores/{S}/lookup/REASONS/values` as a member of S with `Lookup.view`.
Expected result: `200`, the 5 seeded global reasons **plus** `SHRINKAGE`, ordered by `sort_order` ascending.

**LVS-02 — Tenant isolation (rule, violated attempt)**
Area: rule/tenancy | Criticality: Critical | Traces to: BR-3
Preconditions: Store A has custom value `LOYALTY10` under `DISCOUNT_TYPE`; caller is a member of Store B (not A).
Steps: `GET /stores/{B}/lookup/DISCOUNT_TYPE/values`.
Expected result: `200`, only global values — `LOYALTY10` absent (Store B never sees Store A's custom values).

**LVS-03 — Storefront not accessible to caller**
Area: permission/tenancy | Criticality: Critical | Traces to: `TenantGuard` "identical response, timing-oracle safe"
Preconditions: caller has no membership in store `{X}` (or `{X}` doesn't exist at all).
Steps: `GET /stores/{X}/lookup/PAYMENT_TERMS/values`.
Expected result: `404 STORE_NOT_ACCESSIBLE` — identical whether the store doesn't exist or simply isn't accessible to this user (no existence leak).

**LVS-04 — Missing `Lookup.view` permission**
Area: permission (violated) | Criticality: High | Traces to: `RequirePermissions({entity:'Lookup', action:'view'})`
Preconditions: a custom role with `Lookup.view` explicitly revoked is assigned to the caller for store S.
Steps: `GET /stores/{S}/lookup/PAYMENT_TERMS/values`.
Expected result: `403 PERMISSION_DENIED`; a `PERMISSION_DENIED` SOC2 denial audit row is written before the exception (per `PermissionsGuard.denyAudit`).

**LVS-05 — Reads never blocked by subscription state**
Area: cross-cutting (rule, satisfied) | Criticality: Critical | Traces to: `SubscriptionStatusGuard` READ_METHODS bypass
Preconditions: Store S's account subscription is `paused`, `expired`, has `reconciliationStatus:'pending'`, or the store itself is `locked`.
Steps: `GET /stores/{S}/lookup/REASONS/values` in each subscription state.
Expected result: `200` in **every** case — GET is never gated; only writes are (see 3.5–3.7). Response still carries `X-Subscription-Version`/`X-Subscription-Warning` headers reflecting the real state.

**LVS-06 — Account has no subscription row at all (provisioning gap)**
Area: failure/first-run | Criticality: High | Traces to: `SubscriptionStatusGuard.loadSubscription` returns null unconditionally before the read/write branch
Preconditions: a freshly-provisioned account whose `account_subscriptions` row hasn't been created yet (race between account creation and subscription provisioning).
Steps: `GET /stores/{S}/lookup/REASONS/values`.
Expected result: `403 SUBSCRIPTION_NOT_FOUND` — **this blocks reads too**, since the null-subscription check runs before the `isRead` short-circuit. Flag as a real availability gap for a brand-new account (assumption/edge case — confirm whether subscription provisioning is guaranteed synchronous with account creation).

**LVS-07 — Unknown type code (store-scoped)**
Area: negative | Criticality: High | Traces to: BR-7
Input/Data: `GET /stores/{S}/lookup/NOT_A_TYPE/values`
Expected result: `404 LOOKUP_TYPE_NOT_FOUND`.

**LVS-08 — Malformed `storeId` (not a UUID)**
Area: negative | Criticality: Medium | Traces to: `ParseUUIDPipe`
Input/Data: `GET /stores/not-a-uuid/lookup/REASONS/values`
Expected result: `400 Bad Request` (Nest's `ParseUUIDPipe` validation failure) before `TenantGuard` even runs.

**LVS-09 — 500-row cap reached (boundary)**
Area: boundary | Criticality: Medium | Traces to: `LookupRepository.listByType` `.limit(500)` — "defensive cap, not real pagination"
Preconditions: a store has created 500+ custom values under one type (no app-level cap currently prevents this).
Steps: `GET /stores/{S}/lookup/<type>/values`.
Expected result: exactly 500 rows returned, silently truncated — no `hasMore`/pagination signal to the client. Flag as a genuine gap: an over-500 store can't see/manage its own tail values through this endpoint, and the mobile dropdown silently renders an incomplete list with no indication.

**LVS-10 — Empty result for a type with no store-custom values and only hidden globals**
Area: boundary (empty) | Criticality: Low | Traces to: BR-3
Preconditions: hypothetical type where every global value is `is_hidden=true` and the store has added nothing.
Expected result: `200`, `[]` — a legitimately empty dropdown, not an error.

---

### 3.5 Lookup Values — Create — `POST /stores/:storeId/lookup/:typeCode/values`

**LVC-01 — Happy path: store owner adds a custom value**
Area: happy | Criticality: High | Traces to: BR-2
Preconditions: caller is `STORE_OWNER` of store S.
Input/Data: `POST /stores/{S}/lookup/REASONS/values` `{code:"SHRINKAGE", label:"Shrinkage", description:"Inventory shrinkage", sort_order:10}`
Expected result: `200`/`201`, `{guuid, code:"SHRINKAGE", label:"Shrinkage", description:"Inventory shrinkage", sort_order:10, is_system:false, row_version:1}`; row created with `store_fk=S`; audit event `LOOKUP_VALUE_CREATED` logged.

**LVC-02 — Duplicate code within the same store/type (rule, violated)**
Area: rule/negative | Criticality: High | Traces to: BR-4
Preconditions: `SHRINKAGE` already exists for store S under `REASONS`.
Steps: `POST /stores/{S}/lookup/REASONS/values {code:"SHRINKAGE", label:"Dup"}`
Expected result: `409 LOOKUP_CODE_EXISTS`.

**LVC-03 — Duplicate code across DIFFERENT stores (rule — likely surprising, violated)**
Area: rule/negative | Criticality: Critical | Traces to: BR-4 (`uk_lookup_type_code` is global per type, not per-store)
Preconditions: Store A already created `SHRINKAGE` under `REASONS`. Store B (unrelated tenant) has never used that code.
Steps: `POST /stores/{B}/lookup/REASONS/values {code:"SHRINKAGE", label:"Shrinkage"}`
Expected result: `409 LOOKUP_CODE_EXISTS` for Store B too — **a code is a single global namespace per type across every tenant.** Store B's owner has no way to know *why* (the error doesn't reveal Store A exists), and no way to work around it except picking a different code. Confirm this is the intended multi-tenant design (see §7 Q1) — it reads like an unintended cross-tenant coupling for what's meant to be tenant-scoped data.

**LVC-04 — Recreate under a code that belongs to a soft-deleted value (rule — likely bug)**
Area: state/negative | Criticality: Critical | Traces to: BR-4/BR-6 (`existsByTypeAndCode` has no `is_active` filter; `uk_lookup_type_code` isn't partial)
Preconditions: Store S created `SHRINKAGE`, then deleted it (`DELETE .../values/{guuid}` → `is_active=false`).
Steps: `POST /stores/{S}/lookup/REASONS/values {code:"SHRINKAGE", label:"Shrinkage v2"}`
Expected result (as implemented): `409 LOOKUP_CODE_EXISTS` — the deleted row still occupies the code, permanently, with **no way to reclaim it** via the API (no restore/rename/hard-delete endpoint exists). Flag as the most impactful gap in this module — confirm expected behavior (§7 Q1/Q2).

**LVC-05 — Concurrent identical create (concurrency, same store)**
Area: concurrency | Criticality: High | Traces to: `rethrowUniqueViolationAs`
Steps: two simultaneous `POST .../REASONS/values {code:"SHRINKAGE", ...}` for the same store.
Expected result: exactly one `200`/`201`; the other `409 LOOKUP_CODE_EXISTS` (DB unique-violation path, not a `500`, not two rows).

**LVC-06 — Unknown type code**
Area: negative | Criticality: High | Traces to: BR-7
Input/Data: `POST /stores/{S}/lookup/NOT_A_TYPE/values {code:"X", label:"X"}`
Expected result: `404 LOOKUP_TYPE_NOT_FOUND`; no row created.

**LVC-07 — Validation: boundary lengths**
Area: boundary | Criticality: Medium | Traces to: `CreateLookupValueDtoSchema`
Input/Data: `code` at 40 chars (accept), 41 chars (reject); `label` at 80 (accept)/81 (reject); `description` at 200 (accept)/201 (reject); `code`/`label` empty string (reject, `min(1)`).
Expected result: exactly-at-limit accepted (`200`), one-over rejected (`422 VALIDATION_FAILED`), matching the DB column widths (`varchar(40)`/`varchar(80)`/`varchar(200)`) so no silent truncation is possible.

**LVC-08 — `sort_order` boundary/overflow**
Area: boundary | Criticality: Medium | Traces to: `sort_order: z.number().int().optional()` (no min/max) vs DB `integer` (32-bit)
Input/Data: `sort_order:0` (accept, default-equivalent); `sort_order:-5` (accept — no rule against negative); `sort_order:2147483647` (accept, int4 max); `sort_order:2147483648` (int4 overflow) or `sort_order:9999999999`
Expected result: `0`/`-5`/`2147483647` succeed; the overflow value should ideally be a clean `422`, but as implemented it isn't range-checked in Zod — it will fail at the DB layer with a Postgres numeric-overflow error, which is **not** one of the handled exception paths (`rethrowUniqueViolationAs` only maps `23505`) — expect this to surface as an unhandled `500`. Flag as a gap: add an upper bound to the Zod schema.

**LVC-09 — Missing required fields**
Area: negative | Criticality: High | Traces to: `CreateLookupValueDtoSchema`
Input/Data: `{}` ; `{label:"X"}` (missing `code`) ; `{code:"X"}` (missing `label`)
Expected result: `422 VALIDATION_FAILED` listing the missing field(s).

**LVC-10 — Wrong types / malformed JSON**
Area: negative | Criticality: Medium
Input/Data: `{code: 123, label: "X"}` (number instead of string); `{code:"X", label:"X", sort_order:"first"}` (string instead of number); non-JSON body.
Expected result: `422 VALIDATION_FAILED` for type mismatches; `400 Bad Request` for unparseable JSON (body-parser level, before reaching the Zod schema).

**LVC-11 — Whitespace / unicode / emoji in code & label**
Area: boundary | Criticality: Low | Traces to: no trim/charset restriction in schema
Input/Data: `{code:" SHRINKAGE ", label:"収縮 🔻"}` (leading/trailing space in code, unicode+emoji in label)
Expected result: accepted as-is (`200`), stored byte-for-byte — `" SHRINKAGE "` and `"SHRINKAGE"` are **different** codes (no trim), so this is a duplicate-that-isn't-caught edge case worth calling out to product (a store could accidentally create near-duplicate values that look identical in a UI that trims for display).

**LVC-12 — Permission: `Lookup.create` not granted (violated)**
Area: permission | Criticality: Critical | Traces to: `RequirePermissions({entity:'Lookup', action:'create'})`, "only STORE_OWNER gets these by default"
Preconditions: caller is a custom-role staff member (e.g. "Cashier") without an explicit `Lookup.create` grant.
Steps: `POST /stores/{S}/lookup/REASONS/values {...}`
Expected result: `403 PERMISSION_DENIED`; denial audit row written; no value created.

**LVC-13 — Writes blocked on lapsed subscription (rule, violated)**
Area: cross-cutting/negative | Criticality: Critical | Traces to: `SubscriptionStatusGuard`
Preconditions/Steps, expected result per status (all on `POST .../values`):
  - `status:'paused'` → `403 SUBSCRIPTION_SUSPENDED`.
  - `status:'expired'` → `402 SUBSCRIPTION_PAYMENT_REQUIRED`.
  - `accessValidUntil` in the past but status not yet flipped (reconciliation-cron lag) → `402 SUBSCRIPTION_PAYMENT_REQUIRED`.
  - `reconciliationStatus:'pending'` (account has an unresolved downgrade, e.g. too many stores) → `403 SUBSCRIPTION_RECONCILIATION_REQUIRED`, **even though lookup values aren't the over-limit resource** — this is a blanket account-wide write gate.
  - store `isLocked:true` (post-downgrade lock) → `403 STORE_LOCKED`.
  In every case: no value created, and the response still carries `X-Subscription-Version`/`X-Subscription-Warning` headers (guard stamps them itself since a thrown guard skips the normal response interceptor).

**LVC-14 — Writes allowed during trial/grace, with warning header**
Area: cross-cutting (rule, satisfied) | Criticality: Medium | Traces to: `SubscriptionStatusGuard.buildWarning`
Preconditions: `status:'trialing'` (with `accessValidUntil` in the future) or `status:'past_due'` within the 7-day grace window.
Steps: `POST /stores/{S}/lookup/REASONS/values {...}`
Expected result: `200`/`201`, value created; response header `X-Subscription-Warning: trialing:ends_at_<ISO>` or `past_due:grace_until_<ISO>` present so the client can nudge the user to renew.

**LVC-15 — Permission cache staleness after mid-session revoke**
Area: cross-cutting/concurrency | Criticality: Medium | Traces to: `PermissionsGuard.bustCacheOnVersionMismatch`
Preconditions: caller's `Lookup.create` grant is revoked by an owner while the caller's JWT still has the old `permissionsVersion` cached.
Steps: revoke the permission, then immediately `POST .../values` with the still-valid old JWT.
Expected result: if the JWT's `pv` differs from the account's current `permissionsVersion`, the cache is busted first and the fresh (revoked) permission set is enforced → `403 PERMISSION_DENIED` on this very request (no stale-allow window here, since the mismatch itself triggers the bust). If `pv` matches (e.g. permission changed without a `permissionsVersion` bump — shouldn't happen by design, but verify), the cached permission set could serve stale for up to its TTL.

**LVC-16 — Global endpoint has no create; store-scoped is the only write path**
Area: negative | Criticality: Low
Steps: attempt `POST /lookup/REASONS/values` (the global, no-store controller).
Expected result: `404 Not Found` — that controller only exposes `GET`; there is no way to add a *global* value via the public API at all (only seeding/migration can).

---

### 3.6 Lookup Values — Update — `PATCH /stores/:storeId/lookup/values/:guuid`

**LVU-01 — Happy path: edit label/description/sort_order**
Area: happy | Criticality: High | Traces to: BR-5
Preconditions: Store S owns value `SHRINKAGE` (`row_version:1`).
Input/Data: `PATCH /stores/{S}/lookup/values/{guuid} {label:"Inventory Shrinkage", sort_order:20, expected_row_version:1}`
Expected result: `200`, updated fields reflected, `row_version:2`; audit `LOOKUP_VALUE_UPDATED`.

**LVU-02 — Optimistic lock satisfied (rule, satisfied)**
Area: rule | Criticality: Critical | Traces to: BR-5
Preconditions: current `row_version:2`.
Input/Data: `{label:"X", expected_row_version:2}`
Expected result: `200`, succeeds, `row_version:3`.

**LVU-03 — Optimistic lock violated — stale version (concurrency)**
Area: concurrency/rule (violated) | Criticality: Critical | Traces to: BR-5
Preconditions: two admins A and B both load `SHRINKAGE` at `row_version:2`. A submits and succeeds (→`row_version:3`). B then submits with `expected_row_version:2`.
Steps: B's `PATCH {label:"B's edit", expected_row_version:2}`
Expected result: `409 LOOKUP_VALUE_VERSION_CONFLICT`, `"This lookup value was changed by someone else — refresh and try again"`, `details.currentRowVersion:3`. B's edit is **not** applied (no silent last-write-win — this is the exact regression the DTO comment says the REST endpoint used to have).

**LVU-04 — Edit a value soft-deleted by someone else mid-flight (concurrency, likely bug)**
Area: concurrency/state | Criticality: Critical | Traces to: BR-6 gap — `updateValue`'s SQL `WHERE` has no `is_active` check, and `softDeleteValue` never bumps `row_version`
Preconditions: caller A loads `SHRINKAGE` at `row_version:2`. Meanwhile caller B (or another session) `DELETE`s it (→ `is_active:false`, `row_version` still `2`).
Steps: A submits `PATCH {label:"Edited after delete", expected_row_version:2}`.
Expected result (as implemented): `200` **succeeds** — `loadEditableValue`/`findByGuuid` don't filter `is_active`, and the atomic update's `WHERE (guuid, store_fk, is_system=false, row_version=2)` still matches the deleted row. The value is updated (`row_version:3`, new label) while **remaining invisible** in every listing (still `is_active:false`). This is a real "zombie edit" bug: the client that issued the successful edit has no idea the record is actually deleted, and there's no reactivation, so the edit is silently lost from the user's perspective. Recommend: add `is_active=true` to the update `WHERE` clause, or have `loadEditableValue` treat `is_active:false` as not-found. Confirm with dev (§7 Q2).

**LVU-05 — System value: edit attempt (rule, violated)**
Area: rule/permission | Criticality: Critical | Traces to: BR-1
Preconditions: `guuid` belongs to a global seeded value (e.g. `PAYMENT_TERMS/COD`, `is_system:true`, `store_fk:NULL`).
Steps: `PATCH /stores/{S}/lookup/values/{guuid-of-COD} {label:"Hacked", expected_row_version:1}`
Expected result: `404 LOOKUP_VALUE_NOT_FOUND` — since `value.store_fk (NULL) !== storeId (S)`, `loadEditableValue` 404s **before** the `is_system` check is ever reached (a global system value is unreachable from any store's edit path purely on the store-mismatch check). Note: this makes the dedicated `is_system` branch in `loadEditableValue` effectively unreachable dead code given the current data model (no row is ever both `is_system:true` and `store_fk` set) — still valuable as defense-in-depth, but confirm whether a store-scoped system value is ever expected to exist (§7 Q3).

**LVU-06 — Cross-store edit attempt (tenancy, violated)**
Area: rule/tenancy | Criticality: Critical | Traces to: BR-2
Preconditions: value belongs to Store A; caller is a member of Store B with `Lookup.edit`.
Steps: `PATCH /stores/{B}/lookup/values/{A's guuid} {label:"X", expected_row_version:1}`
Expected result: `404 LOOKUP_VALUE_NOT_FOUND` (not `403`) — existence of Store A's value is not revealed to Store B.

**LVU-07 — Non-existent guuid**
Area: negative | Criticality: Medium
Input/Data: `PATCH /stores/{S}/lookup/values/{random-uuid} {label:"X", expected_row_version:1}`
Expected result: `404 LOOKUP_VALUE_NOT_FOUND`.

**LVU-08 — Malformed guuid**
Area: negative | Criticality: Low | Traces to: `ParseUUIDPipe`
Input/Data: `PATCH /stores/{S}/lookup/values/not-a-uuid {...}`
Expected result: `400 Bad Request`.

**LVU-09 — Missing `expected_row_version` (rule, violated)**
Area: negative | Criticality: High | Traces to: `UpdateLookupValueDtoSchema` (`expected_row_version` required, `positive()`)
Input/Data: `{label:"X"}` (no `expected_row_version`); `{label:"X", expected_row_version:0}`; `{label:"X", expected_row_version:-1}`
Expected result: `422 VALIDATION_FAILED` for all three — the field is mandatory and must be a positive integer; this is a deliberate hardening (per the DTO comment) over the old behavior where the REST endpoint didn't enforce the lock at all.

**LVU-10 — Empty patch body (no-op update)**
Area: boundary | Criticality: Low | Traces to: `UpdateLookupValueDtoSchema` all fields but the version are optional
Input/Data: `{expected_row_version:2}` (nothing else)
Expected result: `200`, `row_version` still increments to 3 (the `sql\`row_version + 1\`` runs unconditionally on any successful match) even though no visible field changed — confirm this "version churn on no-op" is acceptable (a client polling `row_version` to detect real change would see false positives).

**LVU-11 — Hide a value (`is_hidden` transition)**
Area: state (legal) | Criticality: Medium | Traces to: state machine
Input/Data: `{is_hidden:true, expected_row_version:2}`
Expected result: `200`; value now excluded from `listValues`/`listGlobalValues` but still exists/editable/deletable (distinct from soft-delete).

**LVU-12 — Un-hide a value**
Area: state (legal) | Criticality: Medium
Input/Data: `{is_hidden:false, expected_row_version:3}`
Expected result: `200`; value reappears in listings.

**LVU-13 — Attempt to set `is_active` directly (illegal — no such field)**
Area: negative/state | Criticality: Low | Traces to: schema doesn't expose `is_active`
Input/Data: `{is_active:true, expected_row_version:2}` (extra/unknown field)
Expected result: Zod schema silently strips unknown keys by default (no `.strict()`) — the field is ignored, not an error; value's active state is unaffected either way. Confirm whether silently dropping unknown fields (vs. rejecting them) is intended API behavior.

**LVU-14 — Validation boundaries on optional fields**
Area: boundary | Criticality: Medium | Traces to: `UpdateLookupValueDtoSchema`
Input/Data: `label` at 80/81 chars; `description` at 200/201 chars.
Expected result: at-limit accepted, over-limit `422 VALIDATION_FAILED`.

**LVU-15 — Permission: `Lookup.edit` not granted**
Area: permission (violated) | Criticality: Critical
Preconditions: caller lacks `Lookup.edit` for store S.
Expected result: `403 PERMISSION_DENIED`.

---

### 3.7 Lookup Values — Delete — `DELETE /stores/:storeId/lookup/values/:guuid`

**LVD-01 — Happy path: soft delete**
Area: happy | Criticality: High | Traces to: BR-6
Preconditions: Store S owns `SHRINKAGE`.
Steps: `DELETE /stores/{S}/lookup/values/{guuid}`
Expected result: `204 No Content`, no body; `is_active` set `false`, `updated_at` bumped, `row_version` **unchanged**; `LOOKUP_VALUE_DELETED` audited; value disappears from `listValues`.

**LVD-02 — System value: delete attempt (rule, violated)**
Area: rule | Criticality: Critical | Traces to: BR-1/BR-2
Steps: `DELETE /stores/{S}/lookup/values/{guuid-of-a-global-system-value}`
Expected result: `404 LOOKUP_VALUE_NOT_FOUND` (store mismatch short-circuits before the `is_system` check, same as LVU-05).

**LVD-03 — Cross-store delete attempt (tenancy, violated)**
Area: rule/tenancy | Criticality: Critical | Traces to: BR-2
Expected result: `404 LOOKUP_VALUE_NOT_FOUND` for a Store B caller targeting Store A's value.

**LVD-04 — Double-delete / duplicate action (idempotency)**
Area: concurrency/duplicate | Criticality: Medium | Traces to: `softDeleteValue` has no `is_active` guard in its `WHERE`
Preconditions: `SHRINKAGE` already `is_active:false` from a prior delete.
Steps: `DELETE /stores/{S}/lookup/values/{guuid}` again.
Expected result: `204` again (not `404`/`409`) — `loadEditableValue` doesn't filter `is_active` so the pre-check still finds it, and the `UPDATE ... SET is_active=false` simply re-applies (no-op on the flag, `updated_at` bumped again). A second `LOOKUP_VALUE_DELETED` audit row is written. Confirm this silent-idempotent-success (vs. an expected `404`/`409 already deleted`) is the intended contract.

**LVD-05 — Non-existent guuid**
Area: negative | Criticality: Medium
Expected result: `404 LOOKUP_VALUE_NOT_FOUND`.

**LVD-06 — Malformed guuid**
Area: negative | Criticality: Low
Expected result: `400 Bad Request`.

**LVD-07 — Permission: `Lookup.delete` not granted**
Area: permission (violated) | Criticality: Critical
Expected result: `403 PERMISSION_DENIED`.

**LVD-08 — Delete blocked by lapsed subscription**
Area: cross-cutting | Criticality: High | Traces to: `SubscriptionStatusGuard`
Expected result: same matrix as LVC-13 (`SUBSCRIPTION_SUSPENDED` / `PAYMENT_REQUIRED` / `RECONCILIATION_REQUIRED` / `STORE_LOCKED`) applied to `DELETE`.

**LVD-09 — Delete then immediately re-list (staleness/consistency)**
Area: cross-cutting (no cache) | Criticality: Medium | Traces to: "no caching layer" (§0)
Steps: `DELETE .../values/{guuid}` then immediately `GET .../values`.
Expected result: the deleted value is **immediately** absent — no propagation delay, since there is no cache to invalidate. (Contrast with the RBAC-permission cache, which *does* have a bust step — this is data, not permissions.)

**LVD-10 — Delete a value, then try to recreate with the same code (state/rule interaction)**
Area: state/negative | Criticality: Critical | Traces to: BR-4/BR-6, duplicate of LVC-04 from the delete side
Steps: `DELETE` then `POST` with the identical `code`.
Expected result: `409 LOOKUP_CODE_EXISTS` — see LVC-04. This is the same critical gap viewed from the "delete" workflow: any store that deletes a mis-typed or unwanted custom value has **permanently burned that code** for its whole tenant-type namespace (not just its own store).

---

## 4. Edge-case scenarios (the ones teams miss)

**EC-01 — Empty / zero / null**
- Brand-new lookup type with zero values yet (LVG-08).
- `description` omitted entirely vs. sent as `""` — both should map to `null`/empty consistently; verify `""` isn't rejected by `min(1)` only on `code`/`label`, not `description` (description has no `min`, so `""` is valid and distinct from "field omitted" — confirm the mapper doesn't collapse `""` to `null`).
- Country/currency tables empty pre-seed (RD-05).

**EC-02 — First-run / fresh state**
- A brand-new account with a subscription row not yet provisioned → all reads blocked (`SUBSCRIPTION_NOT_FOUND`), including the store-scoped lookup GET (LVS-06). The *global* lookup endpoint and reference-data endpoints are unaffected (no such guard on them) — so the create-store wizard still works even in this exact failure window, which may be the saving grace that makes LVS-06 tolerable in practice. Worth confirming the wizard never calls the store-scoped endpoint before a store/subscription exists.
- First custom value ever created for a brand-new lookup type (no global seed data to merge with).

**EC-03 — Maximum / overflow**
- `code`/`label`/`description` at exactly their DB column width (LVC-07/LVU-14) — accepted; one char over — rejected cleanly by Zod (not a DB truncation).
- `sort_order` beyond 32-bit `integer` range (LVC-08) — not caught by Zod, likely surfaces as an unhandled DB error (500) instead of a clean 422.
- 500+ custom values under one type silently truncates the dropdown (LVS-09) with no pagination escape hatch.

**EC-04 — Decimals & rounding**
- Not applicable — no money/quantity fields in this module. `sort_order` is integer-only (`z.number().int()`); a fractional `sort_order` (e.g. `1.5`) should be rejected by `.int()` — verify (`422 VALIDATION_FAILED`).

**EC-05 — Duplicate / repeat**
- Duplicate code same store (LVC-02), duplicate code across stores (LVC-03 — surprising), duplicate code vs. a soft-deleted row (LVC-04/LVD-10 — likely bug), concurrent identical create (LVC-05), double-delete (LVD-04), whitespace-variant "duplicate" that isn't caught (`" SHRINKAGE "` vs `"SHRINKAGE"`, LVC-11).

**EC-06 — Out-of-order / concurrent identical**
- Two admins race a `PATCH` on the same value (LVU-03) — correctly rejected via row_version.
- A `DELETE` racing a `PATCH` on the same value (LVU-04) — **not** correctly rejected; this is the standout finding of this review.
- Two stores racing to claim the same code under the same type (LVC-05 variant across stores) — DB unique constraint still protects correctness (one wins, one gets 409), even though the cross-tenant coupling itself is questionable.

**EC-07 — Offline → sync**
- The `lookup` table carries `guuid`/`row_version`/`modified_at` and is listed as "a writable synced entity" in the schema comments (sync-engine.md §3 order 5) — meaning store-custom lookup values likely also flow through an offline sync-push path elsewhere in the codebase (outside the files reviewed here). If so, the same BR-4/BR-6 gaps (global code uniqueness surviving soft-delete, no `is_active` guard on update) apply there too and should be verified against the sync-push mutation handler for this table, not just this REST controller (the DTO comment explicitly says "same gate the sync-push mutation handler already enforces for this table" for `expected_row_version` — confirm the sync path also has the `is_active`-on-update gap or already guards against it).

**EC-08 — Permission/subscription change mid-flow**
- `Lookup.create`/`edit`/`delete` revoked between the mobile client loading a value and submitting the mutation (LVC-15).
- Subscription flips from trialing→expired between listing values (still allowed) and submitting a create (now blocked, LVC-13) — client must handle a `402` on a previously-fine flow.

**EC-09 — Abandonment / interruption**
- Not directly applicable server-side beyond: a client that fetched `row_version:2`, the user backgrounds the app, another edit lands (`row_version:3`), the user resumes and submits — correctly caught by LVU-03's optimistic-lock conflict.

**EC-10 — Time**
- `modified_at`/`created_at`/`updated_at` are all `timestamptz` — no timezone-specific business logic in this module; not a significant risk area here beyond standard UTC storage.

**EC-11 — Connectivity transitions**
- Redis outage during `SubscriptionStatusGuard`'s cache read/write — caught, falls back to DB read, write is best-effort (non-fatal) — verify this degrade path doesn't silently double the DB load under sustained Redis unavailability (every write request now does a full subscription-table read).
- Redis outage during `PermissionsGuard.bustCacheOnVersionMismatch` — caught and logged, not fatal, but means a permission bust can silently fail to happen (worst case: serves a cached permission set for its TTL instead of failing the request).

**EC-12 — Long/unusual input**
- Emoji/unicode/RTL in `label`/`title`/`description` (LTY-08, LVC-11).
- Leading/trailing whitespace not trimmed anywhere in this module (LVC-11).

**EC-13 — State edge**
- Acting on a soft-deleted record: `PATCH` succeeds when it probably shouldn't (LVU-04); `DELETE` succeeds idempotently (LVD-04); `POST` with the deleted record's old code always fails (LVC-04/LVD-10).
- A value's type deactivated after the value was created: since `lookup_type` has no deactivate endpoint, this state is currently unreachable via the API (only relevant if `is_active` on `lookup_type` is ever flipped by a future admin feature or direct DB op) — worth a case once such a feature exists ("does listing a value under a now-inactive type still work?" — currently `resolveType`/`findByCode` don't filter on `lookup_type.is_active` either, so it would still work).

**EC-14 — Device/platform**
- Not applicable — pure backend REST scope; no UI/device-specific behavior to test here (defer to mobile-client test suite for dropdown rendering/empty-state/long-label wrapping).

---

## 5. Coverage summary — requirement/rule → case matrix

| Rule / Requirement | Satisfied case(s) | Violated / negative case(s) |
|---|---|---|
| BR-1 System value immutable | — (immutability has no "satisfied" positive action) | LVU-05, LVD-02 |
| BR-2 Store ownership of custom values | LVC-01, LVU-01, LVD-01 | LVU-06, LVD-03, LVS-02 |
| BR-3 Merged global+store visibility, active+non-hidden only | LVS-01, LVG-01/02 | LVG-07 (hidden excluded), LVS-09 (cap truncation) |
| BR-4 Code uniqueness per type | LVC-01 (first use of a code) | LVC-02 (same store), LVC-03 (cross-store — flagged), LVC-04/LVD-10 (post-delete — flagged), LTY-04, LTY-05 |
| BR-5 Optimistic lock on update | LVU-01, LVU-02 | LVU-03 (stale version), LVU-09 (missing/invalid version) |
| BR-6 Soft delete, no restore | LVD-01 | LVD-04 (double-delete "succeeds" — flagged), LVU-04 (edit-after-delete "succeeds" — flagged) |
| BR-7 Type resolution, case-sensitive | LVG-01/02, LVS-01 | LVG-03/04, LVS-07 |
| BR-8 Reference data active-only, no filters | RD-01/02 | RD-04 (inactive excluded), RD-07 (params ignored) |
| BR-9 Reference data ordering not guaranteed | — | RD-08 (flagged, no test can "pass/fail" this — informational) |
| BR-10 Reference data unbounded query | RD-01/02 (fine at current scale) | RD-09 (flagged risk, not reproducible today) |
| Platform-admin-only lookup-type management | LTY-01/02 | LTY-03 |
| `Lookup.view` permission | LVS-01 | LVS-04 |
| `Lookup.create` permission | LVC-01 | LVC-12 |
| `Lookup.edit` permission | LVU-01 | LVU-15 |
| `Lookup.delete` permission | LVD-01 | LVD-07 |
| Tenant resolution (`TenantGuard`) | LVS-01 | LVS-03, LVS-08 |
| Subscription write-gate (reads always open) | LVS-05, LVC-14 | LVC-13, LVD-08 |
| Global lookup endpoint bypasses all gating | LVG-06 | — (this *is* the intended behavior; flagged as assumption #4 to confirm) |
| Validation (Zod schemas, all 3 DTOs) | LTY-08, LVC-07, LVU-14 (at-limit) | LTY-06, LVC-09/10/11, LVU-09/13 |
| State transition: active↔hidden | LVU-11, LVU-12 | — (both directions legal; no illegal transition exists here) |
| State transition: active→inactive (delete) | LVD-01 | LVU-04, LVD-04 (illegal-but-currently-allowed transitions back *into* the inactive state) |
| Concurrency: duplicate create race | LVC-05, LTY-05 | — |
| Concurrency: update vs. update race | LVU-02 | LVU-03 |
| Concurrency: update vs. delete race | — | LVU-04 (gap) |
| No caching / immediate read-your-write consistency | LVD-09 | — |

**Gaps identified (no clean passing case exists today — these need a product/dev decision before a "correct" expected result can be written):**
1. LVC-04 / LVD-10 — soft-deleted codes block reuse forever, cross-tenant, with no restore path.
2. LVU-04 — `PATCH` can silently mutate a soft-deleted row.
3. LVC-08 — `sort_order` overflow isn't validated, likely surfaces as a raw DB error.
4. LTY-07 — no way to update/deactivate a `lookup_type` once created.
5. LVS-09 — 500-row cap has no pagination fallback for stores that exceed it.

---

## 6. Priority roll-up (run these first)

**Critical (money/auth/data-integrity/concurrency — must pass before anything else):**
LVU-03, LVU-04, LVU-05, LVU-06, LVD-02, LVD-03, LVC-03, LVC-04, LVD-10, LVS-02, LVS-03, LTY-03, LVC-12, LVU-15, LVD-07, LVC-13, LVD-08, RD-06.

**High:**
LVS-01, LVS-04, LVS-05, LVS-06, LVG-03, LVG-05, LVC-01, LVC-02, LVC-05, LVC-06, LVC-07, LVC-09, LVU-01, LVU-02, LVU-09, LVD-01, LVD-04, LVG-06, LTY-04, LTY-05, LTY-06, RD-01, RD-02, RD-03.

**Medium / Low:**
everything else in §3 and the informational edge cases in §4 (EC-04, EC-10, EC-14).

---

## 7. Open questions (need product/dev confirmation)

1. **Is BR-4's global-per-type code uniqueness intentional across tenants**, or should `uk_lookup_type_code` really be scoped `(store_fk, lookup_type_fk, code)` for custom values (with a separate global-only uniqueness for system rows)? As implemented, Store A can permanently block Store B from ever using a given code under a shared type (LVC-03), and the error message doesn't explain why to Store B's owner.
2. **Should a soft-deleted value's code ever become reusable?** Currently `uk_lookup_type_code` isn't partial (`WHERE is_active`) and `existsByTypeAndCode` doesn't filter `is_active`, so it never does (LVC-04/LVD-10). If codes should be reusable after delete, this needs either a partial unique index or an `existsByTypeAndCode` fix plus a migration.
3. **Should `PATCH` reject edits to a soft-deleted (`is_active=false`) row?** As implemented it silently succeeds (LVU-04), bumping `row_version` and changing fields on an invisible row with no way to surface this back to the record. Recommend adding `is_active=true` to `LookupRepository.updateValue`'s `WHERE` and to `loadEditableValue`'s pre-check.
4. **Is a store-scoped `is_system=true` row ever expected to exist?** If never, the `is_system` branch in `LookupService.loadEditableValue` is dead code given the current data model (store-mismatch already 404s every global system row) — harmless as defense-in-depth, but worth a comment noting it's currently unreachable, or removing the ambiguity by seeding a test fixture that actually exercises it.
5. **Is `GET /lookup/:typeCode/values`'s total lack of RBAC/subscription gating intentional and permanent**, or is it meant to be tightened once the mobile client no longer needs pre-store access? (Currently: any authenticated user, any subscription state, any role, can read every global lookup category.)
6. **Should `lookup_type` support update/deactivate?** There's currently no way to fix a typo in a category's `title`/`description`, or retire a category, without a direct DB write.
7. **Should `sort_order` have an explicit upper/lower bound in the Zod schema** to avoid a raw Postgres overflow error reaching the client as an unhandled `500` (LVC-08)?
8. **Should the 500-row cap on `listByType`/`listAll` become real pagination** (cursor/offset) now that there's no app-level limit on how many custom values a store can create per type (the repository comment itself flags this as "a real gap")?
9. **Is double-`DELETE` expected to be silently idempotent** (`204` both times, LVD-04), or should a second delete on an already-inactive row return `404`/`409` to signal "nothing to delete"?
10. Does the offline **sync-push** mutation path for the `lookup` table share the same `is_active`-on-update gap as the REST `PATCH` (open question 3), given the DTO comment states they're meant to enforce "the same gate"?

---

*End of report — Lookup + Reference Data modules, `apps/backend/src/lookup/**` and `apps/backend/src/reference-data/**`.*
