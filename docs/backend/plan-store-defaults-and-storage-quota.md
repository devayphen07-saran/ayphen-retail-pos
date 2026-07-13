# Implementation Plan — Store Default Seeding & Storage Quota

> Two independent, additive features ported from the Ayphen 3.0 (legacy Java) reference:
> **(A)** seed usable defaults when a store is created, and **(B)** meter total file
> storage per account as a plan entitlement. Ship **A first** (low risk, additive), then **B**.
>
> All file references are to `apps/backend/src/` unless noted.

---

## Background — why these two

Ayphen 3.0's `getStarted()` seeded sensible defaults (Walk-In customer, default category,
tax/invoice settings) so a new tenant never faced an empty app, and its
`CompanyStorageAllocation` gave every tenant a storage quota (fixed 1 GB). Our current
backend does neither:

- `StoreService.createStore` (`stores/store/store.service.ts:134-209`) creates only the
  store + `STORE_OWNER` role + owner assignment. A merchant lands in an empty app.
- Entitlements are `max_stores` / `max_devices_per_store` / `max_products` only
  (`db/schema.ts:72`, `subscription/entitlement.service.ts:6-9`). The two-phase file-upload
  feature has per-file and per-record caps (`files_config`) but **no aggregate ceiling** —
  an account can upload unbounded storage.

Both gaps are worth closing. Everything else in 3.0 (owner-as-role, unlinked billing models,
stub webhook, multi-app catalog) is either already done better here or ERP over-engineering —
**do not port it**.

---

# Part A — Seed store defaults on create

**Goal:** on store creation, provision a **Walk-In customer** (retail POS needs an anonymous
quick-sale customer), a **default product category**, and **default tax/invoice settings** —
inside the existing store-create transaction so it's all-or-nothing.

## A1. Where it goes

Extend the transaction in `stores/store/store.service.ts:134-209`, immediately after the owner
role mapping is written and before the first-store trial / audit steps:

```
uow.execute(tx):
  lockAccount → recheck max_stores
  insertStore
  insertStoreOwnerRole → seedStoreOwnerPermissions → insertRoleMapping
  seedStoreDefaults(store.id, userId, tx)      ← NEW
  (first store) startTrial
  bumpUserPermissionsVersion
  audit STORE_CREATED
```

It **must** run inside the same `uow.execute` so a seeding failure rolls the whole store back —
never leave a half-provisioned store.

## A2. New code

### `StoreDefaultsSeeder` (new file: `stores/store/store-defaults.seeder.ts`)

A dedicated service injected into `StoreService`, with one method:

```ts
async seed(storeId: string, userId: string, tx: DbTransaction): Promise<void>
```

Kept separate from `StoreService` so the create method stays readable and the default set is
easy to extend later (add default payment method, default units, etc.). Register it in
`stores.module.ts`.

### Repository inserts (add to `stores/store/store.repository.ts`)

All take the caller's `tx`:

- `insertDefaultCustomer(storeId, userId, tx)` → `customers` row:
  `{ name: 'Walk-In', storeFk: storeId, isActive: true, createdBy: userId, updatedBy: userId }`.
  Sync columns default themselves (`guuid` random, `rowVersion=1`, `modifiedAt` via trigger).
  Safe against `uk_customers_store_name` (new store → no collision).
- `insertDefaultCategory(storeId, userId, tx)` → default product category (e.g. `'General'`).
  **Verify the table name first** — `product_categories` vs `categories`.
- Default settings: `stores.invoicePrefix` already defaults to `'INV'` (`db/schema.ts:113`), so
  invoices are covered. **Only** add a settings-row seed if a dedicated store-settings/tax table
  exists — confirm before adding.

## A3. Sync considerations (offline-first — important)

Seeded `customers` / category rows are **server-authored** but land in client-writable synced
tables. This is safe **because** `syncColumns()` (`db/sync-columns.ts`) gives them a valid
`guuid` + `rowVersion=1` + trigger-maintained `modifiedAt`, so they flow to the device on the
next delta / initial pull exactly like any pulled row (the client upserts by `guuid`).

Verify before shipping:

1. The store-open / initial-sync path pulls `customers` **and** the category table (both carry
   an `idx_*_sync` index, so they should already be in the sync set).
2. The client initial-sync tolerates rows it did not author (it will — it upserts pulled rows by
   `guuid`).

**Rule:** seed **only** tables already in the sync set. Never seed a row the client can't receive.

## A4. Idempotency & edge cases

- Seeding runs exactly once, inside the create tx — no re-run path, no idempotency key needed.
- If a merchant later deletes the Walk-In customer, **do not** recreate it — it's a starter, not
  an invariant.
- **Do NOT seed a dummy product.** `getSetupStatus.productAdded`
  (`stores/store/store.repository.ts:308`) counts products; a seeded product would falsely mark
  onboarding complete and pollute inventory. Seeding a *category* is fine — the checklist counts
  products, not categories.

## A5. Tests

- **Unit:** `seed()` inserts expected rows with correct `storeFk` / `createdBy`.
- **Integration:** `createStore` → assert Walk-In customer + default category exist with the
  right `storeFk`; force a seed failure and assert the store insert rolled back (nothing persists).
- **Sync:** initial-sync for the new store returns the seeded rows.

## A6. Effort & risk

~½ day. **Low risk** — purely additive and transactional. The only real pitfall is seeding a
non-synced table, avoided by A3.

---

# Part B — Storage quota as a metered entitlement

**Goal:** cap **total committed file storage per account**, modeled like `max_stores`. Today
`files_config` bounds per-file and per-record size/count, but nothing bounds an account's aggregate.

## B1. Entitlement wiring

- Add `'max_storage_bytes'` to `EntitlementKey` in `subscription/entitlement.service.ts:6-9`.
- ⚠️ **CRITICAL SEED STEP.** `EntitlementService.get` returns **0 = blocked** for a *missing*
  row (`subscription/entitlement.service.ts:24-38` — a missing row means "plan doesn't grant
  this," never "unlimited"). Therefore you **must** seed `plan_entitlements` with a
  `max_storage_bytes` value for **every** plan, including `free`, or **all uploads break
  instantly**. This is the single biggest rollout risk.
  - Suggested values: `free` = 1 GB (matches 3.0), paid tiers higher, `enterprise` = `NULL`
    (unlimited). `NULL` value = unlimited; **missing row** = blocked — these are different.

## B2. Aggregation strategy — use a counter column

Two ways to know an account's current usage:

| Option | Approach | Cost / commit | Accuracy |
|---|---|---|---|
| B-i | `SUM(size_bytes)` over `files ⋈ stores` by account, live rows only | O(files) scan every commit | exact |
| **B-ii (recommended)** | `accounts.storage_used_bytes` counter, updated in the same tx as every file insert/delete/restore | O(1) | exact if maintained everywhere + nightly reconcile |

**Recommend B-ii.** A metered quota is checked on the hot path; an O(files) SUM per upload
doesn't scale. This is 3.0's `CompanyStorageAllocation` idea done correctly. Add:

- Migration: `accounts.storage_used_bytes bigint NOT NULL DEFAULT 0`.
- Increment in `persistFiles` tx (`files/files.service.ts:245`); decrement in `deleteFile`;
  re-increment in `restoreFile` (`files/files.service.ts:318-335`). **Every** file lifecycle
  transition must touch the counter — miss one and it drifts.
- A **nightly reconcile cron** that recomputes each account's usage from `SUM(files.size_bytes)`
  and corrects drift. This safety net is what makes the counter trustworthy.

## B3. Enforcement point (with correct concurrency)

In `FilesService.commit` (`files/files.service.ts:115`), the existing `assertRecordBudget`
(`:180`) is **record-scoped**. Add an **account-scoped** check performed **authoritatively inside
`persistFiles`' transaction** — not before it — because a pre-check is TOCTOU-able (two concurrent
commits both pass, both write). This is the same lesson as the `max_stores` gate
(`stores/store/store.service.ts:136-150`):

```
persistFiles(tx):
  lock account row (SELECT … FOR UPDATE)              # serialize concurrent commits
  used  = account.storage_used_bytes
  limit = entitlements.get(accountId, 'max_storage_bytes', tx)
  batchBytes = Σ temp.sizeBytes
  if (limit !== null && used + batchBytes > limit) → throw StorageLimitReachedError
  insert files… + storage_used_bytes += batchBytes + delete temps
```

- `accountId` comes from `this.ctx.getAccountId()` — **no extra query** (TenantGuard already
  resolved it; `common/request-context/request-context.service.ts:41`). Add a
  `requireAccountId()` mirroring `requireStoreId()` (`files/files.service.ts:413`).
- Add a cheap **pre-check outside the tx** too (fast-fail before the slow S3 copy in
  `copyStaged`), for UX — but the authoritative gate stays inside the locked tx. Same
  belt-and-suspenders pattern store-create uses.

## B4. Error + client contract

- Add `STORAGE_LIMIT_REACHED` to `common/error-codes.ts` and a `StorageLimitReachedError`
  (402/403, mirroring `STORE_LIMIT_REACHED`), including `{ limit, used }` in the payload.
- Mobile: the uploader (`apps/mobile/src/core/sync/image-uploader.ts`) must treat this as a
  **terminal, non-retryable** commit failure (like `orphaned`) and surface
  "storage full — upgrade plan," never retry in a loop.

## B5. Migration ordering (ship as one atomic unit, before code)

1. Add `accounts.storage_used_bytes` (default 0).
2. **Backfill** it from existing files:
   `UPDATE accounts a SET storage_used_bytes = COALESCE((SELECT SUM(f.size_bytes) FROM files f
   JOIN stores s ON s.id = f.store_fk WHERE s.account_fk = a.id AND f.deleted_at IS NULL), 0)`.
3. Seed `plan_entitlements.max_storage_bytes` for **all** plans (B1).
4. **Then** deploy the enforcement code.

If step 3 is missed or lands after the code, every upload returns "blocked." Steps 1–3 go in one
migration; code deploys after.

## B6. Tests

- Under limit → commit succeeds; counter increases by batch bytes.
- At limit → `STORAGE_LIMIT_REACHED`; no files written; counter unchanged; staged claims released.
- `NULL` limit (enterprise) → always allowed.
- Delete / restore adjust the counter correctly.
- **Concurrency:** two parallel commits that individually fit but jointly exceed → exactly one
  succeeds (proves the `FOR UPDATE` lock).
- Reconcile cron corrects an artificially drifted counter.
- **Seed-gap regression:** a plan missing the entitlement blocks upload (guards B1's risk).

## B7. Effort & risk

~1.5–2 days. **Medium risk**, concentrated entirely in B1/B5 (seed gap → total upload outage).
The enforcement logic itself is a clean copy of the `max_stores` pattern already trusted.

---

# Sequencing & summary

| Order | Feature | Effort | Risk | Blast radius |
|---|---|---|---|---|
| 1 | **A** — store default seeding | ½ day | Low | New stores only |
| 2 | **B** — storage entitlement | 1.5–2 days | Medium (seed gap) | All uploads |

- **Do A first** — isolated and additive.
- **Then B** — treat the `plan_entitlements` seed + `storage_used_bytes` backfill as a single
  atomic migration that ships **before** the enforcement code.

## Open questions to confirm before coding

1. **Part A:** exact **product-category table name** (`product_categories` vs `categories`), and
   whether a dedicated **store-settings / tax** table exists for defaults beyond `invoicePrefix`.
2. **Part A:** confirm `customers` and the category table are both in the **initial-sync pull set**.
3. **Part B:** desired **per-plan storage values** (free / paid tiers / enterprise-unlimited).
4. **Part B:** confirm the mobile uploader's terminal-failure handling path so
   `STORAGE_LIMIT_REACHED` is surfaced, not retried.

## Explicitly out of scope (3.0 patterns NOT to port)

- Owner-as-a-role → we correctly use `accounts.ownerUserFk` (column). Do not regress.
- Two unlinked billing models (`Subscription` vs `RecurringPlan`) → keep our single
  `account_subscriptions` as source of truth.
- Stub payment webhook → ours is wired; do not copy.
- Multi-application catalog / company-as-customer-of-root → ERP over-engineering, irrelevant.
