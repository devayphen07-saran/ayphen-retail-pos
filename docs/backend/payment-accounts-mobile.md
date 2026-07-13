# Payment Accounts (Mobile, v1) — Product Requirements Document

> **Status:** Draft for review · **Date:** 2026-07-10 · **Author:** BA/QA agent
> **Scope of this doc:** the *buildable v1* of payment-account management on mobile, grounded in the
> **actual** backend schema and sync engine. It is deliberately narrower than the aspirational
> [payment-accounts.md](payment-accounts.md) (rich per-type model: bank/UPI/terminal columns, opening
> balance, split payments). Those richer fields are **deferred** here (§2.3 / DF-2).
>
> **Grounding (already in the codebase):** `payment_accounts` table
> [schema.ts:1253](../../apps/backend/src/db/schema.ts#L1253), `payment_methods` table
> [schema.ts:1225](../../apps/backend/src/db/schema.ts#L1225), backend sync push handler
> `PaymentAccountMutationHandler` (`apps/backend/src/sync/push/handlers/payment-account.handler.ts`),
> `paymentaccount` pull filter (`apps/backend/src/sync/registry/sync-filter.registry.ts:328`), RBAC
> `Payment` entity ([entity-catalogue.ts:53](../../apps/backend/src/common/rbac/entity-catalogue.ts#L53)).
> **Not yet built:** any default seeding, the `is_system` lock column, the online write API, and the
> mobile side (local read-cache table, pull applier, screens).

---

## 0. Architecture decision (READ FIRST) — online writes, offline reads

This feature does **not** use the offline-first optimistic-write pattern that Products/Customers use.
After analysis (the `Payment` entity is money-adjacent, and account creation is a rare, setup-time
action), the decision is:

- **Reads are offline.** The account **list** and every **dropdown/picker** render from a **local cache
  table** on the device — instant, works with no network.
- **Writes are online-only.** Create / edit / deactivate / delete are **direct API calls** that require
  connectivity. There is **no local optimistic write and no `mutation_queue` entry** for payment-account
  writes.
- **The local cache is a pull-only projection of the server.** The **only** writer of the local
  `payment_accounts` table is the **pull applier**. The write API never touches local storage directly.
- **Reconciliation after a write:** on a successful write the client **triggers an immediate sync pull**;
  the new/updated row comes down through the normal pull applier and then appears in the list/dropdowns.
- **Idempotency:** the client generates the `guuid` and sends it as the **idempotency key**; the server
  dedupes on it so a retry / double-tap cannot create two accounts (there is no local queue row to dedupe
  against).

**Why this model (vs offline-first):** local state has a *single writer* (pull), so the write path and the
read cache can never diverge or double-insert; creation gets **immediate authoritative validation**
(duplicate name, permission) with no "created offline then rejected on sync" surprise. The cost — you
cannot add/edit an account with no connectivity — is acceptable because account management is infrequent
and typically done at setup. See §6 for the exact flows and §13/OQ-2 for the rationale trail.

> ⚠️ This overrides earlier drafts of this PRD that described offline-first optimistic creation. All
> business rules, flows, and tests below reflect the **online-write / offline-read** model.

---

## 1. Overview

### 1.1 Problem statement
A store owner receives money through more than one channel — cash across the counter, and money that lands
in a bank/digital destination. The mobile app has **no screen to define where a payment lands**, and a
brand-new store starts with an **empty** payment-account list (nothing is seeded today), so the very first
sale has no account to attribute money to. The owner also can't later answer "how much did I take in cash
vs into the bank?"

### 1.2 Objective
Every store starts with two ready-to-use, **locked** payment accounts — **Cash** and **Bank** — and any
authorised user can **add their own** payment accounts (e.g. "HDFC Current", "PhonePe", "Petty Cash") from
a mobile create page. **Writes go straight to the server (online-required); the account list and pickers
read from a local cache that the sync pull keeps up to date.**

### 1.3 Success metrics
- **SM-1** 100% of newly created stores show exactly the Cash + Bank seeds on first mobile cold-start
  (≥2 `paymentaccount` rows returned by the initial pull).
- **SM-2** After a successful online create, the account appears in the list/pickers within one
  immediately-triggered pull (P95 < 2 s on a normal connection), and the offline list continues to render
  from cache with no network.
- **SM-3** **0** occurrences of a seeded Cash/Bank account being renamed, deactivated, or deleted
  (enforced server-side, not just hidden in UI).
- **SM-4** **0** duplicate accounts from a double-tap / retried create (idempotency-key dedupe).
- **SM-5** Every completed sale is attributable to exactly one active payment account (measured when
  checkout attribution — DF-1 — ships).

### 1.4 Background / context
- **Multi-tenancy:** every domain row is `store_fk → stores(id)` scoped
  ([schema.ts:1257](../../apps/backend/src/db/schema.ts#L1257)). **Payment accounts are per store**
  (confirmed requirement — not per location).
- **Sync engine (reads):** the mobile pull path is keyset-paginated deltas on `(modifiedAt, id)`; a
  registered **applier** writes pulled rows into a local table. Payment accounts reuse this pull path for
  **reads only**. (Unlike Products, they do **not** use the `mutation_queue` outbox for writes.)
- **Writes:** an **online write API** performs create/edit/delete server-side, reusing the same validation
  the sync push handler already implements (permission + tenant + unique-name + seed-lock). See §8/DR-6.
- **RBAC:** payment operations use the existing `Payment` entity. `STORE_OWNER` = `FULL`; new custom store
  roles default to `Payment: VIEW_ONLY`
  ([role-matrices.ts](../../apps/backend/src/common/rbac/role-matrices.ts)).
- **Seeding today:** `store.service.ts` `createStore` (lines 134–209) seeds only the STORE_OWNER role +
  permissions. **No payment accounts/methods are seeded.** This PRD adds Cash+Bank seeding to that same
  transaction.

### 1.5 Data-model decision (recorded)
**v1 uses the *simple* model** already present in the backend: `name`, optional `payment_method_fk`
(→ `payment_methods`, source of `kind`), `details` (jsonb, free-form), `is_default`, `is_active`, plus a
**new `is_system`** flag for the locked seeds. The rich per-type model (structured bank/UPI/terminal fields,
opening balance, split payments) from [payment-accounts.md](payment-accounts.md) is **deferred** (DF-2).
*Rationale:* the simple model is already ~80% built on the backend, so v1 ships fast; structured capture
arrives when reconciliation/reporting is prioritised.

---

## 2. Scope

### 2.1 In scope
- **IS-1** Seed **Cash** and **Bank** per store at store creation, both **locked** (`is_system = true`).
- **IS-2** Mobile **list** screen, reading from the **local cache** (offline): seeds first; active + inactive.
- **IS-3** Mobile **create** page — **online-required** direct write API (name, optional method/kind,
  optional free-form details, set-as-default).
- **IS-4** **Edit** a user-created account — online-required (rename, change method, edit details, set default).
- **IS-5** **Activate/deactivate** a user-created account — online-required (inactive = hidden from checkout,
  retained for history).
- **IS-6** **Delete** (soft) a user-created account — online-required, subject to not-in-use rule (BR-11).
- **IS-7** Enforce **locked seeds**: Cash & Bank cannot be renamed, deactivated, or deleted.
- **IS-8** **Reads via the existing pull path:** local read-cache `payment_accounts` table + a `paymentaccount`
  pull applier + permission-map entry. (The backend pull filter already exists.)
- **IS-9** **Online write API** for create/edit/delete that reuses the sync push handler's validation, keyed
  by the client-supplied `guuid` for idempotency.
- **IS-10** **RBAC gating** of every write on the `Payment` entity, enforced server-side.
- **IS-11** Backend: add `is_system` column + reject client-set/seed-targeting writes (BR-4/DR-1/DR-6).

### 2.2 Out of scope
- **OS-1** Web/admin console UI (mobile only).
- **OS-2** Creating/editing **payment methods** (`payment_methods` is pull-only).
- **OS-3** Reconciliation, settlement, bank-feed/gateway integrations.
- **OS-4** Multi-currency per account (store currency only).
- **OS-5** Structured per-type fields (IFSC, UPI id, terminal id, opening balance) — deferred (DF-2).
- **OS-6** **Offline creation/editing of accounts** — explicitly excluded by the §0 decision.

### 2.3 Deferred (with the trigger that flips each)
- **DF-1 Checkout attribution** — selecting which account received the money at checkout and writing it on
  the order/payment. *Trigger:* checkout/tender work scheduled. **This is the "the cash goes under the Cash
  account" behaviour the owner described.** BR-14 / BR-10 / BR-11 depend on it.
- **DF-2 Rich per-type model** — the full [payment-accounts.md](payment-accounts.md) schema. *Trigger:*
  structured reconciliation/reporting prioritised.
- **DF-3 Running balance / ledger** — per-account running total (a ledger projection; `CashMovement` exists).
  *Trigger:* per-account reporting prioritised.
- **DF-4 Reordering (`sort_order`)** — user ordering of accounts. *Trigger:* a store with many accounts asks.
- **DF-5 Offline writes** — should account management ever need to work fully offline, revisit §0 and move to
  the optimistic-write + `mutation_queue` pattern. *Trigger:* real user demand for offline account setup.

---

## 3. Actors & Permissions

| Actor | Description | Can do | Cannot do |
|---|---|---|---|
| **Store Owner** (`STORE_OWNER`) | Per-store immutable owner role, `Payment: FULL`. | View (offline); create/edit/delete/set-default/activate-deactivate (**online**). | Rename/deactivate/delete the Cash/Bank seeds (BR-4); act on another store (TenantGuard). |
| **Custom store role — granted** | Store role explicitly granted `Payment` create/edit/delete. | View (offline); whatever the grant allows (online). | Exceed its grant; touch seed lifecycle/name (BR-4). |
| **Custom store role — default** | New custom roles default to `Payment: VIEW_ONLY`. | View the list (offline); select at checkout (DF-1). | Create/edit/deactivate/delete. |
| **Cashier (typical)** | Usually `Payment: VIEW_ONLY`. | View (offline); select at checkout. | Manage accounts. |
| **Super Admin** (`SUPER_ADMIN`) | Platform support, `Payment: FULL`. | Support ops per platform policy. | (Not a store-facing actor here.) |
| **System (store-create txn)** | The `createStore` transaction. | Seed Cash + Bank as locked accounts. | — |

> **Enforcement point:** the **online write API** enforces `PermissionsGuard` (against `Payment` + action)
> and `TenantGuard` (`req.context.storeId`) **server-side**, reusing the same validation as the sync push
> handler. The mobile UI mirrors permissions/connectivity for UX only — it is **not** the enforcement point
> (BR-2).

---

## 4. User Stories & Acceptance Criteria

**US-1 — Seeded defaults.** As a store owner, I want Cash and Bank to already exist when my store is created.
- **AC-1.1** Given a new store, When first cold-start sync completes, Then exactly two accounts exist —
  "Cash" and "Bank" — both **active** and **locked** (`is_system = true`).
- **AC-1.2** Given the seeds, When I view the list, Then they appear first, badged as system/locked, with no
  rename/delete/deactivate affordance.
- **AC-1.3** Given store creation, When the txn commits, Then exactly one Cash and one Bank exist — never
  zero, never duplicated (idempotent; BR-1, EC-15).

**US-2 — Add an account (online).** As an authorised user, I want to add a payment account.
- **AC-2.1** Given `Payment: create` **and connectivity**, When I submit a valid new account, Then the client
  calls the write API with a client-generated `guuid`; on success it triggers an immediate pull and the
  account appears in the list/pickers.
- **AC-2.2** Given I am **offline**, When I open the create page, Then the "Add"/submit action is disabled
  with a clear "connect to add" message — no local row is created (BR-15).
- **AC-2.3** Given I lack `Payment: create`, When I open the list, Then no "Add" action shows; and a forced
  API call is rejected server-side (BR-2).
- **AC-2.4** Given a name duplicating an existing **active** account (trim/case-insensitive), When I submit,
  Then the API returns a duplicate error inline and nothing is created (BR-3).
- **AC-2.5** Given I double-tap submit or the request is retried, When both reach the server, Then only **one**
  account is created (idempotency on `guuid`; BR-16).
- **AC-2.6** Given the create returns 200 but the follow-up pull is slow/fails, When I return to the list,
  Then the account is shown as *syncing* (not failed) and appears once any pull lands (BR-17).

**US-3 — Set default.** As an authorised user, I want to mark one account as default so checkout pre-selects it.
- **AC-3.1** Given I set account B default (online), When it saves, Then B has `is_default = true` and every
  other account in the store has `is_default = false` — at most one default (BR-8).
- **AC-3.2** Given no default is set, When checkout opens (DF-1), Then **Cash** is the fallback default (BR-9).

**US-4 — Edit / deactivate (online).** As an authorised user, I want to rename/edit/deactivate an account I created.
- **AC-4.1** Given a **user-created** account and connectivity, When I rename/edit, Then the write API updates
  it and a pull reflects the change locally.
- **AC-4.2** Given a **seeded** account, When I open it, Then rename/deactivate/delete are absent/disabled, and
  any forced API call is rejected server-side (BR-4).
- **AC-4.3** Given I deactivate a user-created account, When checkout opens (DF-1), Then it is not offered, but
  historical references remain intact (BR-10).

**US-5 — Delete (online).** As an authorised user, I want to remove an account I no longer use.
- **AC-5.1** Given a user-created account that is **not default** and **not referenced** and connectivity,
  When I delete it, Then the API soft-deletes it (`deleted_at`) and a pull removes it from the local list (BR-11).
- **AC-5.2** Given an account that **is** default or **is** referenced (DF-1), When I delete it, Then the API
  blocks it with a clear message prompting deactivate / reassign-default first (BR-11, BR-8).

**US-6 — Attribute a sale (deferred, DF-1).** As a cashier, I want to select which account received the money.
- **AC-6.1** *(Deferred)* Given a sale being tendered, When I pick "Cash", Then the payment records against
  the Cash account. Full ACs authored when DF-1 is scheduled.

---

## 5. Business Rules

| ID | Rule | Type | Enforced where | Violation behaviour |
|---|---|---|---|---|
| **BR-1** | Every store has **exactly one** Cash and **one** Bank seeded account, created in the store-create txn. | Invariant | Backend `createStore` txn | Idempotent; retry does not duplicate. Seed failure rolls back the whole store-create txn (no partial store). |
| **BR-2** | Every write requires the matching `Payment` permission, enforced on the **online write API** (server-side). | Invariant | Write API (`PermissionsGuard`) | API returns 403; nothing changes; UI shows a permission message. |
| **BR-3** | `name` is **unique per store among non-deleted, active accounts**, compared trimmed + case-insensitive. | Invariant | Write API (authoritative) + mobile pre-check (UX) | API returns a duplicate error; existing row untouched; duplicate-name message shown. |
| **BR-4** | A **seeded** account (`is_system = true`) cannot be renamed, deactivated, or deleted; its method/details are immutable. | Invariant | Write API + mobile UI hides affordances | API rejects; UI never offers the action. |
| **BR-5** | `name` required, trimmed, 1–60 chars, not whitespace-only. | Invariant | Zod (mobile form + write API) | Field error; not submitted. |
| **BR-6** | Every account belongs to exactly one store; a user may only act on accounts in a store they can access. | Invariant | `TenantGuard` + `store_fk` scope | 404 STORE_NOT_ACCESSIBLE (timing-safe). |
| **BR-7** | `payment_method_fk`, if set, must reference a `payment_method` in the **same store**; kind derives from it. | Invariant | Write API (fk validation) | Rejected as invalid reference. |
| **BR-8** | **At most one** account per store may be `is_default = true`; setting a new default clears the prior one **atomically** in the same server transaction. | Invariant | Write API (single txn) | Two-default state is unreachable. |
| **BR-9** | If no account is default, **Cash** is the implicit fallback default. | Policy | Checkout/list read (DF-1) | N/A (read-time). |
| **BR-10** | Deactivating (`is_active = false`) hides from checkout but must not delete/alter historical references. | Invariant | Write API soft state + checkout filter (DF-1) | Historical rows remain valid; account still resolvable by id. |
| **BR-11** | A user-created account may be soft-deleted only if **not default** and **not referenced** (once DF-1 exists); else blocked. | Invariant | Write API | Delete rejected with "in use / is default" reason; account retained. |
| **BR-12** | Deletion is **soft** (`deleted_at`); no hard deletes on the app path. | Invariant | Write API + pull tombstone | N/A. |
| **BR-13** | Writes are **online-only**. There is no offline optimistic write and no `mutation_queue` entry for payment-account writes; the local cache is written **only** by the pull applier. | Invariant | Mobile write path + connectivity gate | Offline → submit disabled (BR-15); local cache never diverges from server. |
| **BR-14** | *(Deferred, DF-1)* A completed sale must be attributed to exactly one **active** account; the amount accrues to it. | Invariant | Checkout/payment write (DF-1) | Sale can't complete without a resolvable active account. |
| **BR-15** | With no connectivity, all account **writes** are blocked at the UI (submit disabled) with an actionable message; **reads stay fully available** from the local cache. | Invariant | Mobile connectivity gate | No write attempted; no stranded state. |
| **BR-16** | Every write carries a client-generated `guuid` used as the **idempotency key**; the server dedupes on it so a retry / double-submit yields one row, not two. | Invariant | Write API (upsert-by-guuid) | Second delivery returns the existing row; no duplicate. |
| **BR-17** | A write that returns 2xx is **committed on the server** even if the follow-up pull is delayed/fails; the client must treat it as *succeeded/syncing*, never *failed*. | Invariant | Mobile post-write handling | Row appears on the next pull; no false-failure shown. |

---

## 6. Flows

### 6.1 Primary flow — Add an account (online write, pull-reflected)
1. User opens **Payment accounts** → list renders from the **local cache** (offline-capable; seeds first).
2. User taps **Add** — shown only with `Payment: create`; **disabled when offline** with a "connect to add"
   hint (BR-15).
3. System shows the create form: **Name** (required), **Method/kind** (picker of the store's active
   `payment_methods`, optional), **Details** (optional free text/notes), **Set as default** (toggle, off).
4. User enters "HDFC Current", picks kind "bank", submits.
5. Client validates locally (BR-3/5/7 for fast feedback), **generates a `guuid`**, and calls the **online
   write API** with the payload + `guuid` (idempotency key). The form shows a "Saving…" state.
6. Server (reusing the sync push handler's validation) runs `PermissionsGuard` + `TenantGuard` + Zod +
   unique-name + seed-lock, inserts the row, and returns success. **Nothing is written to local storage by
   the write call.**
7. On success the client **triggers an immediate sync pull**. The form moves to "Syncing…" (or navigates
   back showing the row as *syncing*).
8. The **pull applier** writes the new row into the local cache → it now appears in the list and all
   dropdowns/pickers. The "syncing" marker clears.

### 6.2 Alternate flows
- **AF-1 Set default at creation.** Toggle on → server clears any prior default in the same txn (BR-8).
- **AF-2 Edit user-created account.** Open → edit → save (online) → write API updates → pull reflects it.
- **AF-3 Deactivate / reactivate.** Online write toggling `is_active` (user-created only, BR-10).
- **AF-4 Delete (eligible).** User-created, not default, not referenced → confirm → online soft-delete →
  pull removes it locally (BR-11/12).
- **AF-5 Post-write pull is slow/fails (BR-17).** Create returned 200 → account exists on server → shown as
  *syncing* → appears on the next successful pull. Never shown as failed.

### 6.3 Exception flows
- **EF-1 Duplicate name (BR-3).** Local pre-check blocks with "An account named '{name}' already exists." If
  it reaches the server, the API returns a duplicate error inline; nothing created.
- **EF-2 No permission (BR-2).** Stale UI / revoked before submit → API returns 403 → inline message; nothing
  created.
- **EF-3 Act on a seeded account (BR-4).** UI blocks; a forced API call is rejected server-side.
- **EF-4 Delete a default / in-use account (BR-11).** API blocks with reassign-default or deactivate guidance.
- **EF-5 Offline write attempt (BR-15).** Submit disabled with "Connect to the internet to add a payment
  account." No API call, no local row.
- **EF-6 Double-tap / retry (BR-16).** Same `guuid` re-sent → server returns the existing row → one account.
- **EF-7 Write 200 but pull fails (BR-17).** Account exists on server → shown as *syncing* → lands next pull.
- **EF-8 Concurrent default change (BR-8).** Two users set different defaults (both online) → each write is a
  server transaction; the later write wins; the store still has exactly one default; each device reflects it
  on its next pull.
- **EF-9 Concurrent edit vs delete (EC-6).** Two online writes on the same row are ordered by the server
  (rowVersion); an edit of an already-deleted row and a delete of an already-changed row are resolved
  deterministically by the API.
- **EF-10 Seeding fails during store create (BR-1).** Seed insert throws → whole `createStore` txn rolls back
  → no orphan store, no partial seed.
- **EF-11 Abandonment.** User opens the form and leaves before submit → no API call, nothing written → no
  stranded state.
- **EF-12 Store locked / subscription lapsed (EC-18).** `req.context.isLocked` → write API rejects per platform
  lock policy; the list still reads from cache (OQ-4).

---

## 7. State Machine

**Entity: payment account.** States: `Active`, `Inactive` (`is_active=false`), `Deleted` (`deleted_at` set).
`is_system` (seeded) constrains transitions. All non-seed transitions are driven by an **online write API**
call; the local cache reflects the new state on the next pull.

**Legal transitions**

| From | To | Trigger | Guard |
|---|---|---|---|
| (none) | Active | Seeded at store create | System only; `is_system=true` |
| (none) | Active | User create (online) | `Payment: create`; connectivity; unique name (BR-3) |
| Active | Inactive | Deactivate (online) | User-created only; `Payment: edit` |
| Inactive | Active | Reactivate (online) | User-created only; `Payment: edit`; name still unique among active (BR-3) |
| Active | Active | Edit fields / set-default (online) | user-created for edits; set-default per OQ-5 |
| Active/Inactive | Deleted | Soft-delete (online) | User-created; not default; not in use (BR-11) |

**Illegal transitions that MUST be rejected (server-side)**

- **IT-1** Active→Deleted on a **seeded** account (BR-4).
- **IT-2** Active→Inactive on a **seeded** account (BR-4).
- **IT-3** Rename a **seeded** account (BR-4).
- **IT-4** Deleted→any (resurrecting a soft-deleted row via edit) — tombstone is terminal on the app path.
- **IT-5** Active→Deleted while the account is the **current default** (BR-11) or **in use** (DF-1).
- **IT-6** Any transition producing **two defaults** in one store — unreachable (BR-8).
- **IT-7** Reactivate (Inactive→Active) when a **different active** account now holds the same name (BR-3).

---

## 8. Data Requirements

**Entity: `payment_accounts`** ([schema.ts:1253](../../apps/backend/src/db/schema.ts#L1253)) — existing server table.

| Field | Type | Req? | Immutable once set | Notes |
|---|---|---|---|---|
| `id` | uuid PK | yes | yes | Server authority. |
| `store_fk` | uuid → stores | yes | **yes** | Tenant scope; account can't move stores. |
| `name` | text | yes | no (user); **yes** (seed) | Trimmed, 1–60 chars, unique per store among active (BR-3). |
| `payment_method_fk` | uuid → payment_methods | no | no | Same-store method (BR-7); source of `kind`. |
| `details` | jsonb | no | no | Free-form notes / non-sensitive settlement hints. **No secrets** (NFR-5). |
| `is_default` | bool (default false) | yes | no | ≤1 true per store (BR-8). |
| `is_active` | bool (default true) | yes | no | Deactivate hides from checkout (BR-10). |
| **`is_system`** ⚠️ **NEW** | bool (default false) | yes | yes | **Does not exist yet.** Enforces locked seeds (BR-4). DR-1. |
| `guuid` | text, unique | yes | yes | Client-generated on create; the **idempotency key** (BR-16). Part of `syncColumns()`. |
| `row_version`, `modified_at` | syncColumns | yes | — | Optimistic-lock + delta watermark (trigger-maintained). |
| `created_at/by`, `updated_at/by`, `deleted_at/by` | auditColumns | — | — | `deleted_at` null = alive; soft-delete tombstone. |

**Identity:** `id` (server) / `guuid` (client-supplied idempotency key). Seeds additionally identified by
`is_system = true` (+ a stable discriminator — see OQ-1 — so checkout/reporting can reliably find "the Cash
account").

**Local read-cache (mobile):** a `payment_accounts` table on-device that mirrors the pulled columns. It is
**written only by the pull applier** — never by the write path (BR-13). Used by the list and all pickers.

**Required net-new work (data / infra):**
- **DR-1** Add `is_system boolean NOT NULL DEFAULT false` to `payment_accounts` (mirrors
  `payment_methods.is_system`) — new Drizzle migration + `_journal.json` entry. Without it, BR-4 is
  unenforceable. *(See OQ-1: also add a stable `system_key`/`kind` to distinguish Cash vs Bank.)*
- **DR-2** Backend seeding: insert Cash + Bank (`is_system=true`, `is_active=true`) idempotently inside the
  `createStore` transaction ([store.service.ts:134–209](../../apps/backend/src/stores/store/store.service.ts#L134)),
  alongside the existing STORE_OWNER role seeding.
- **DR-3** Mobile **reads:** create the local read-cache `payment_accounts` table in
  `apps/mobile/src/core/sync/db/schema.ts`; register a `paymentaccount` **pull applier** in
  `appliers/appliers.registry.ts`; add `paymentaccount → 'Payment'` to `permission-entity-map.ts`.
  (The backend pull filter already exists.) **No create/update/delete mutation-queue mutations** — writes are
  online (BR-13).
- **DR-4** Mobile **writes:** an API client for create/edit/deactivate/delete that (a) requires connectivity,
  (b) sends a client-generated `guuid`, (c) on success triggers an immediate pull, (d) treats 2xx as
  succeeded/syncing (BR-17).
- **DR-5** Mobile UI: list + create/edit screens with the connectivity gate (BR-15) and the *syncing* state
  (BR-17).
- **DR-6** Backend **write API:** expose create/edit/delete for payment accounts that **reuses the sync push
  handler's validation service** (permission + tenant + unique-name + seed-lock + single-default), keyed by
  `guuid` for idempotency (BR-16). Do **not** fork validation into a parallel path.
- **DR-7** Backend write path: **reject** client-supplied `is_system=true` on create (server owns the flag)
  and **reject** any write targeting an `is_system=true` row (BR-4).

**Retention/audit:** soft-delete only (BR-12); audit columns capture actor + timestamps; seeds cascade on
store delete (`ON DELETE CASCADE`).

---

## 9. Edge Cases

| ID | Scenario | Expected behaviour | Relates to |
|---|---|---|---|
| **EC-1** | First store, list opened before first sync | Loading → then the two seeds; never a "no accounts" dead-end post-sync. | US-1, NFR-1 |
| **EC-2** | "Cash " (trailing space) vs "Cash" | Duplicate; API rejects (trim + case-insensitive). | BR-3 |
| **EC-3** | emoji/RTL/unicode name | Accepted if 1–60 chars post-trim; stored/displayed faithfully; uniqueness normalised. | BR-5, BR-3 |
| **EC-4** | Name exactly 60 / 61 chars post-trim | 60 accepted; 61 rejected. | BR-5 |
| **EC-5** | Blank / whitespace-only name | Rejected. | BR-5 |
| **EC-6** | Two online writes: edit vs delete on same row | Server orders by rowVersion; edit-of-deleted rejected (IT-4); devices converge on next pull. | EF-9, IT-4 |
| **EC-7** | Two users set different defaults (online) | Later write wins; exactly one default; each device reflects on next pull. | BR-8, EF-8 |
| **EC-8** | Offline, tap Add | Submit disabled with "connect to add"; no API call, no local row. | BR-15, EF-5 |
| **EC-9** | Create returns 200, immediate pull fails | Account exists on server; shown as *syncing*; appears next pull; not shown as failed. | BR-17, EF-7 |
| **EC-10** | Delete a Bank account that is set default | Blocked (BR-11); prompt to reassign default. | EF-4 |
| **EC-11** | Deactivate an account referenced by past sales (DF-1) | Allowed; hidden from checkout; history intact. | BR-10 |
| **EC-12** | Delete an account referenced by past sales (DF-1) | Blocked; offer deactivate. | BR-11 |
| **EC-13** | Rename user account to a name held by a **deactivated** account | Allowed (uniqueness scoped to active — confirm OQ-3). | BR-3 |
| **EC-14** | 100+ accounts | List stays performant (virtualised); no hard cap (OQ-7). | NFR-2 |
| **EC-15** | `createStore` retried after partial failure | Seeding idempotent; never 0, never 2× Cash/Bank. | BR-1, EF-10 |
| **EC-16** | `payment_method_fk` from another store / deleted method | Rejected. | BR-7 |
| **EC-17** | Client sends `is_system=true` on create | Server forces false; only seeding sets it. | DR-7 |
| **EC-18** | Store locked (subscription lapsed) then add account | Write API rejects per lock policy; list still reads from cache. | EF-12, OQ-4 |
| **EC-19** | Set-as-default on a seeded Cash account | Allowed or not? → OQ-5 (recommend allowed — default ≠ rename). | OQ-5 |
| **EC-20** | Double-tap submit / retried request | Idempotent by `guuid`; server returns the existing row; one account. | BR-16, EF-6 |
| **EC-21** | Connection drops **mid-request** (no response received) | Client retries with the **same `guuid`**; server dedupes → one account; if still unknown, treat as pending, don't blind-resubmit with a new guuid. | BR-16, BR-17 |

---

## 10. Test Cases

> **Priority:** P0 = money/auth/data-integrity/concurrency · P1 = core flows · P2 = edge/UX. Every BR & US
> is covered (§15).

**Happy path**
- **TC-1** (P1, US-2) Online create "HDFC Current" → API 200 → immediate pull → appears in list/pickers.
- **TC-2** (P1, US-1/BR-1) New store → cold-start → list shows exactly Cash + Bank, both active, locked.
- **TC-3** (P1, US-3/BR-8) Set account B default (online) → B.is_default true, all others false, reflected on pull.

**Rules — satisfied & violated**
- **TC-4** (P0, BR-3 satisfied) Unique name accepted.
- **TC-5** (P0, BR-3 violated) Duplicate name ("Cash ", "cash") → API rejects; existing row untouched. (EC-2/EC-3)
- **TC-6** (P0, BR-4/IT-3) Rename Cash → API rejects; UI never offers it.
- **TC-7** (P0, BR-4/IT-1) Delete Bank → API rejects.
- **TC-8** (P0, BR-4/IT-2) Deactivate Cash → API rejects.
- **TC-9** (P0, BR-2 satisfied) User with `Payment: create` creates online → allowed.
- **TC-10** (P0, BR-2 violated) `Payment: VIEW_ONLY` forces a create API call → 403; nothing created. (EF-2)
- **TC-11** (P0, BR-8 violated attempt) Two online default-sets → exactly one default persists. (EC-7)
- **TC-12** (P0, BR-6 violated) Act on another store's account id → 404 STORE_NOT_ACCESSIBLE.
- **TC-13** (P1, BR-7 violated) `payment_method_fk` from another store → rejected. (EC-16)
- **TC-14** (P1, BR-11 satisfied) Delete user-created, non-default, unreferenced (online) → soft-deleted → pull removes.
- **TC-15** (P1, BR-11 violated) Delete a default / in-use account → API blocks with correct message. (EC-10/EC-12)
- **TC-16** (P1, BR-5 violated) Blank / 61-char name → rejected. (EC-4/EC-5)
- **TC-17** (P0, DR-7/EC-17) Client-supplied `is_system=true` on create → server forces false.

**Write model (online-only / reconciliation / idempotency)**
- **TC-18** (P0, BR-15/EC-8) Offline → Add/submit disabled with "connect to add"; no API call, no local row.
- **TC-19** (P0, BR-16/EC-20) Double-tap submit → **one** account created (same `guuid`).
- **TC-20** (P0, BR-16/EC-21) Connection drops mid-request → client retries same `guuid` → one account, no dup.
- **TC-21** (P1, BR-17/EC-9) Create 200 but immediate pull fails → shown as *syncing*, not failed; appears next pull.
- **TC-22** (P1, BR-13) Reads work fully offline (list + pickers) while writes are blocked offline.
- **TC-23** (P1, DR-3) A row created on another device appears here only after a pull (local cache = pull-only).

**State transitions — legal & illegal**
- **TC-24** (P1) Active→Inactive→Active on a user account (online) → succeeds; name uniqueness re-checked. (IT-7)
- **TC-25** (P0, IT-4) Edit a soft-deleted account → API rejects.
- **TC-26** (P1, IT-7/EC-13) Reactivate into a name now held by another active account → rejected.

**Store-seed / concurrency**
- **TC-27** (P0, EC-15/EF-10) `createStore` seed failure → whole store-create rolls back (no orphan store).
- **TC-28** (P0, EC-15) `createStore` retried → no duplicate Cash/Bank.
- **TC-29** (P2, EC-3) Unicode/emoji/RTL name → stored & displayed faithfully; uniqueness normalised.
- **TC-30** (P2, EC-14/NFR-2) 200 accounts → list scrolls smoothly; create still confirms < 2 s.
- **TC-31** (P1, EC-18/EF-12) Store locked → write API rejects, list still reads from cache.
- **TC-32** (P1, EC-6/EF-9) Concurrent edit-vs-delete (two online writes) → deterministic server resolution.

---

## 11. Non-Functional Requirements

- **NFR-1 Offline reads.** The list and all dropdowns/pickers render from the **local cache** with no network.
  Only **writes** require connectivity (BR-13/BR-15).
- **NFR-2 Performance.** List render P95 < 200 ms for ≤ 200 accounts (local, virtualised); after a successful
  online create, the account is visible within one immediately-triggered pull (P95 < 2 s on a normal connection).
- **NFR-3 Idempotency / replay-safe.** Every write carries a client `guuid` idempotency key; retries,
  double-taps, and mid-request drops never duplicate (BR-16, EC-20/EC-21). Server upsert is rowVersion-gated.
- **NFR-4 Authorization.** All writes are authorized **server-side** by the write API (`PermissionsGuard` +
  `TenantGuard`), reusing the sync push handler's validation (BR-2, DR-6). *(Note: the `Payment` entity's
  `isOfflineSafe = false` flag in the RBAC catalogue is currently inert metadata — nothing branches on it —
  and is **not** what makes this feature online-only; the online-write model is a deliberate design choice,
  see §0/OQ-2.)*
- **NFR-5 Security / secrets.** `details` must **not** store full card PANs/CVVs or full bank account numbers —
  only non-sensitive hints. No secret is logged.
- **NFR-6 Tenancy isolation.** Every read/write scoped by `store_fk`; cross-store returns 404 (timing-safe);
  pull deltas never leak across stores (scopeWhere already present in the filter).
- **NFR-7 Auditability.** Create/edit/delete stamp `created_by`/`updated_by`/`deleted_by` + timestamps;
  soft-delete retains rows (BR-12).
- **NFR-8 Sync ordering (reads).** `paymentaccount` pull dependencyOrder (110) is after `payment_method` (60),
  so a linked method exists locally before the account referencing it.
- **NFR-9 Observability.** Write-API rejections (permission / duplicate / locked-seed / locked-store / in-use)
  return a distinguishable reason so the UI shows the right message (§12).

---

## 12. UX Requirements

**Required states (list):** Loading (skeleton on first sync) · Populated (seeds first with lock badge, default
badged, inactive muted + "Inactive" tag) · Empty (must not occur for a synced store — show loading, not empty) ·
Offline (reads work; a persistent unobtrusive "offline — adding disabled" indicator; a just-created row may
show a *syncing* marker) · Error (recoverable, never a raw stack trace).

**Create form states:** Idle → **Saving…** (API in flight) → **Syncing…** (API succeeded, awaiting pull) →
Done. Offline: submit **disabled** with an inline hint.

**Feedback per action — exact copy (confirm wording, OQ-8):**
- Create success: *"Payment account added."* (after pull lands) / interim *"Syncing…"*.
- Offline write blocked: *"Connect to the internet to add a payment account."*
- Duplicate name: *"An account named "{name}" already exists."*
- Locked-seed edit/delete attempt (should be prevented): *"Cash and Bank can't be renamed or removed."*
- No permission: *"You don't have permission to manage payment accounts."*
- Delete blocked (default): *"This account is set as default. Choose another default before deleting it."*
- Delete blocked (in use): *"This account has recorded payments and can't be deleted. Deactivate it instead."*
- Write succeeded but pull pending: *"Saved. It'll show up in a moment."* (never an error — BR-17)
- Delete confirm (destructive): *"Delete "{name}"? This can't be undone."* — Cancel / Delete.

**Must NEVER happen:** a 2xx write shown as failed (BR-17) · a duplicate from double-tap (BR-16) · lost input
(a validation error preserves entered values) · a dead-end empty list on a real store · raw technical error
text · the seeded Cash/Bank appearing deletable/renamable · the list blocking on the network (reads are local).

**Accessibility/platform:** large-font & small-screen safe; iOS + Android parity; create form usable
one-handed; picker for method kind, toggles for default/active.

---

## 13. Assumptions & Open Questions

**Assumptions (proceeding under these):**
- **A-1** "Payment account" = a money-destination that is **also** the checkout tender (owner's description:
  pick "Cash" → amount lands under the Cash account). Balance/ledger is later (DF-3).
- **A-2** Scope is **per store** (confirmed).
- **A-3** Seeds are **Cash** and **Bank**, both **locked** — no rename/deactivate/delete (confirmed).
- **A-4** **Reads offline / writes online** (confirmed, §0). Local cache is a pull-only projection; writes are
  direct online API calls reflected by the next (immediately-triggered) pull.
- **A-5** The existing backend pull filter for `paymentaccount` is reusable for reads; the write API reuses the
  push handler's validation. Net-new backend work is seeding + the `is_system` column + the write endpoint's
  idempotency/lock rules.
- **A-6** v1 uses the **simple** model; the rich per-type model is deferred (DF-2).

**Open questions (each with a recommended default — a *proposal*, not a decision):**
- **OQ-1** *(schema)* Add a stable discriminator to seeds so checkout/reporting can find "the Cash account"
  regardless of any future rename of user accounts? **Recommend: add `is_system` + a nullable
  `system_key` (`'cash'`|`'bank'`).**
- **OQ-2** *(resolved)* Online-write vs offline-first: **resolved to online-write / offline-read** (§0). The
  `Payment: isOfflineSafe = false` flag is inert and did not drive this; the choice is deliberate because
  account creation is rare, setup-time, and money-adjacent, and benefits from immediate authoritative
  validation. Revisit only if real demand for offline account setup appears (DF-5).
- **OQ-3** Is name-uniqueness scoped to **active** accounts only, or all non-deleted (incl. inactive)?
  **Recommend: active only** (lets you retire "UPI-old" and reuse the name).
- **OQ-4** Store **locked** (subscription lapsed): block only writes, or hide the screen? **Recommend:
  read-only** (list from cache yes, write no), consistent with `isLocked` elsewhere.
- **OQ-5** Can a **seeded** account be set as **default**? **Recommend: yes** — default is a checkout
  convenience, not a rename/delete, so it doesn't violate "locked".
- **OQ-6** Do users pick a **method/kind** in v1, or is an account just name + (system) cash/bank type?
  **Recommend: optional method picker** from existing `payment_methods`, defaulting kind to "other".
- **OQ-7** Any **max** accounts per store? **Recommend: no hard cap**, soft-warn past ~20.
- **OQ-8** Confirm **exact user-facing copy** (§12) and localisation.
- **OQ-9** Is **Bank** a single generic locked bucket (specific banks added as new user accounts), or should
  the owner name their real bank? Since Bank is **locked (can't rename)**, this needs a product decision.
  **Recommend: Bank = generic bucket; specific banks added as user accounts.**
- **OQ-10** *(backend shape)* Should the write API be a **new REST controller** for payment accounts, or the
  **existing sync push endpoint** called synchronously while online? Either is acceptable **provided it reuses
  one validation service** (DR-6). **Recommend: whichever reuses the push handler's validation with least new
  surface** — decide at implementation.

---

## 14. Definition of Done

- [ ] `is_system` column added to `payment_accounts` (+ migration + `_journal.json`); server rejects
      client-set `is_system` and rejects writes on `is_system=true` rows (BR-4, DR-1, DR-7).
- [ ] `createStore` seeds exactly one Cash + one Bank (`is_system=true`) idempotently inside the existing
      transaction; seed failure rolls back store creation (BR-1, EF-10, TC-27/28).
- [ ] Mobile **reads**: local read-cache table, `paymentaccount` pull applier, permission-map entry (DR-3).
- [ ] Mobile **writes**: online API client with connectivity gate (BR-15), client `guuid` idempotency key
      (BR-16), immediate post-write pull, and 2xx-as-syncing handling (BR-17) (DR-4/DR-5).
- [ ] Backend **write API** reuses the sync push handler's validation (permission + tenant + unique-name +
      seed-lock + single-default), keyed by `guuid` (DR-6). No forked validation.
- [ ] Uniqueness (BR-3), locked-seed (BR-4), single-default (BR-8), not-in-use delete (BR-11) all enforced
      **server-side** and mirrored in UI.
- [ ] All **P0** test cases pass; **P1** pass; **P2** triaged. Idempotency (TC-19/20) and 2xx-as-syncing
      (TC-21) verified explicitly.
- [ ] Offline: reads work, writes blocked with a clear message (TC-18/TC-22).
- [ ] Every user-facing message matches approved copy (§12, OQ-8).
- [ ] OQ-1, OQ-9, OQ-10 resolved (they change data model / API shape materially).
- [ ] No seeded Cash/Bank account is deletable or renamable from any path (TC-6/7/8).

---

## 15. Traceability Matrix

| Requirement | Verified by |
|---|---|
| BR-1 | TC-2, TC-27, TC-28 |
| BR-2 | TC-9 (satisfied), TC-10 (violated) |
| BR-3 | TC-4 (satisfied), TC-5 (violated), TC-26, TC-29 |
| BR-4 | TC-6, TC-7, TC-8 (violated); US-4 UI checks |
| BR-5 | TC-1/TC-4 (satisfied), TC-16 (violated) |
| BR-6 | TC-12 |
| BR-7 | TC-13 (violated); TC-1 (satisfied) |
| BR-8 | TC-3 (satisfied), TC-11 (violated) |
| BR-9 | Checkout read (DF-1) — test authored with DF-1 |
| BR-10 | TC-24; EC-11 (DF-1) |
| BR-11 | TC-14 (satisfied), TC-15 (violated) |
| BR-12 | TC-14, TC-25 |
| BR-13 | TC-22, TC-23 |
| BR-14 | Deferred (DF-1) — **gap flagged** |
| BR-15 | TC-18 |
| BR-16 | TC-19, TC-20 |
| BR-17 | TC-21 |
| US-1 | TC-2 |
| US-2 | TC-1, TC-4, TC-5, TC-10, TC-18, TC-19 |
| US-3 | TC-3, TC-11 |
| US-4 | TC-6/7/8, TC-24 |
| US-5 | TC-14, TC-15, TC-25 |
| US-6 | Deferred (DF-1) — **gap flagged** |
| NFR-1 | TC-22 |
| NFR-2 | TC-1, TC-30 |
| NFR-3 | TC-19, TC-20 |
| NFR-4 | TC-9, TC-10, TC-12 |
| NFR-6 | TC-12 |
| IT-1..IT-7 | TC-6/7/8 (IT-1/2/3), TC-25 (IT-4), TC-15 (IT-5), TC-11 (IT-6), TC-26 (IT-7) |

**Known gaps (explicit):** BR-14 and US-6 (checkout attribution) are **deferred (DF-1)** and have no v1 test
cases — intentional, not an omission. All other BRs/USs have ≥1 satisfied and (where applicable) ≥1 violated test.