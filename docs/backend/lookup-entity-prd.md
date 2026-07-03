# PRD — Lookup & Entity Registry System (Ayphen Retail POS)

> **App:** Ayphen Retail POS (`apps/backend` — NestJS · Drizzle · PostgreSQL · Redis · offline-first mobile POS)
> **Status:** Draft / to build
> **Scope:** the reference-data (`lookup`) engine and the polymorphic entity registry (`entity_types`) — tables, flow, services, API, seed, sync, and enforcement — adapted from the ayphen-3.0 (Java ERP) design, corrected for an offline-first POS.
> **Related docs:** [`table-architecture.md`](./table-architecture.md) (§6 lookup, §33–§34 files/polymorphic), [`lookup-system.md`](./lookup-system.md), [`database-schema.md`](./database-schema.md).

---

## 1. Overview & goals

Two small systems underpin a lot of the app:

1. **Lookup engine** (`lookup_type` + `lookup`) — a generic table for user-extensible, store-specific dropdown lists (payment terms, reasons, expense categories…), so we don't create a dozen tiny enum tables and so store owners can add their own values at runtime.
2. **Entity registry** (`entity_types`) — the polymorphic anchor that lets shared tables (`files`, `notes`, `address`, `communication`, `contact_person`) attach to **any** parent entity (Product, Customer, Order…) through one table each.

**Goals**
- One reference engine for ~15 extensible lists — not 15 tables.
- Store owners add/reorder/hide their own values at runtime, offline-safe.
- Polymorphic attachments/notes/contacts without one join table per parent.
- **Type safety enforced at the database level** (not app-only), because mutations are built on-device and synced later — an app-layer guard runs too late.
- Everything syncs to the mobile SQLite client cleanly (stable `guuid`, `is_active` soft-delete).

**Non-goals (explicitly skipped — see §12)**
- The `has_table` / dynamic-table engine.
- The `application_entity` metadata-driven CRUD/audit engine.
- A generic `status` table (we use `text` enums).

---

## 2. Core design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Hybrid enum-vs-lookup.** Fixed, logic-bearing states stay `text` enums; only user-extensible labels use `lookup`. | Enums give compile-time type safety + `switch`-ability; lookup gives runtime extensibility. Using lookup for everything (as the Java ERP did) loses type safety on state machines. |
| D2 | **Enforce lookup type with a composite FK**, not app-code validation. Referencing rows store `(lookup_type_fk, lookup_fk)` and a composite FK guarantees the value belongs to the expected type. | Offline mutations are created on the device and synced later; a server-side `existsByTypeAndCode` guard is too late. The DB must enforce it. |
| D3 | **Per-type unique code**: `unique(lookup_type_fk, code)` — NOT globally unique code. | Two types must be able to share a code like `CASH`. The Java schema's global-unique `code` is a latent bug. |
| D4 | **`store_fk` on `lookup` (nullable)**: null = global seed value, set = store-custom value. | Multi-tenant POS: a store adds its own reasons/charges without touching global seed data. |
| D5 | **Reference by `guuid`**, drop the numeric `key` indirection. | Our sync model tracks rows by `guuid`; the Java `lookup.key` double-identifier is redundant. |
| D6 | **`entity_types` is the single polymorphic anchor.** Files/notes/address/communication/contact_person reference `entity_type_fk` + `record_guuid`. | One registry, sync-safe parent refs. |
| D7 | **Ship lookups + entity_types in the sync payload** (`/sync/initial` + delta). They are offline-safe reference data. | The device needs dropdowns + the entity registry offline. |
| D8 | **No dynamic-table engine, no application_entity metadata engine, no status table.** | ERP-scale flexibility that costs type safety and offline simplicity. |

---

## 3. Tables

Convention: `uuid` PK, `guuid` (uuidv7, unique) where synced, FKs `uuid`, money `bigint` paise, soft-delete `is_active`/`deleted_at`, `timestamptz`.

### 3.1 `lookup_type` — category definitions
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK, default random |
| code | varchar(40) | NN, **unique** — machine key (`PAYMENT_TERMS`, `REASONS`) |
| title | varchar(80) | NN — UI label |
| description | varchar(200) | nullable |
| is_active | boolean | NN, default true |
| created_at / updated_at | timestamptz | NN, default now |

*(No `has_table`/`is_custom_table` — we don't use the dynamic-table engine. Categories that need extra columns become real tables directly, e.g. `unit`, `tax_rate`.)*

### 3.2 `lookup` — the values
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique — sync key |
| lookup_type_fk | uuid | FK → lookup_type.id, NN |
| store_fk | uuid | FK → stores.id, **nullable** — null = global; set = store-custom |
| code | varchar(40) | NN |
| label | varchar(80) | NN — display |
| description | varchar(200) | nullable |
| sort_order | integer | NN, default 0 — dropdown order |
| is_hidden | boolean | NN, default false — hide without deleting |
| is_system | boolean | NN, default false — protected (user can't edit/delete) |
| is_active | boolean | NN, default true — soft-delete |
| created_by / updated_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |

**Indexes / constraints:**
- `unique(lookup_type_fk, code)` — per-type unique (D3).
- `index(lookup_type_fk)`, `index(store_fk)`.
- Sync-delta index `(store_fk, updated_at, id)` (once sync layer lands).

```ts
export const lookupType = pgTable('lookup_type', {
  id:          uuid('id').primaryKey().defaultRandom(),
  code:        varchar('code', { length: 40 }).notNull().unique(),
  title:       varchar('title', { length: 80 }).notNull(),
  description: varchar('description', { length: 200 }),
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const lookup = pgTable('lookup', {
  id:           uuid('id').primaryKey().defaultRandom(),
  guuid:        uuid('guuid').notNull().unique().$defaultFn(() => uuidv7()),
  lookupTypeFk: uuid('lookup_type_fk').notNull().references(() => lookupType.id),
  storeFk:      uuid('store_fk').references(() => stores.id),   // null = global
  code:         varchar('code', { length: 40 }).notNull(),
  label:        varchar('label', { length: 80 }).notNull(),
  description:  varchar('description', { length: 200 }),
  sortOrder:    integer('sort_order').notNull().default(0),
  isHidden:     boolean('is_hidden').notNull().default(false),
  isSystem:     boolean('is_system').notNull().default(false),
  isActive:     boolean('is_active').notNull().default(true),
  createdBy:    uuid('created_by'),
  updatedBy:    uuid('updated_by'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('lookup_type_code_uq').on(t.lookupTypeFk, t.code),
  index('idx_lookup_type').on(t.lookupTypeFk),
  index('idx_lookup_store').on(t.storeFk),
]);
```

### 3.3 `entity_types` — polymorphic anchor registry (already exists ✅, must be **wired**)
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| code | text | NN, unique — `Product`, `Customer`, `Order`… |
| label | text | NN |
| is_offline_safe | boolean | NN, default false — included in offline snapshot |
| supports_attachments | boolean | NN, default false — allows `files` rows |

*Seeded today but no repository reads it — the fix is to wire it and reference it by FK from the polymorphic tables.*

### 3.4 Composite-FK enforcement (D2) — how a `_lk_fk` is type-safe
A referencing table stores **both** the type and the value, and a composite FK ties them:
```ts
// example: customer.payment_term
paymentTermTypeFk: uuid('payment_term_type_fk'),   // = the PAYMENT_TERMS lookup_type id (constant)
paymentTermFk:     uuid('payment_term_fk'),
// composite FK → lookup(lookup_type_fk, id) so the DB guarantees the value is a PAYMENT_TERMS value
foreignKey({ columns: [t.paymentTermTypeFk, t.paymentTermFk], foreignColumns: [lookup.lookupTypeFk, lookup.id] })
```
Requires a **unique index on `lookup(lookup_type_fk, id)`** as the composite-FK target. This is the offline-safe replacement for the Java `@LookupExists` validator.

---

## 4. The polymorphic anchor — how `entity_types` is used

`entity_types` is the *target registry* that shared tables attach to. Each polymorphic child carries `entity_type_fk` (which kind) + `record_guuid` (which row, sync-safe) + `record_id` (internal, nullable).

Consumers (see [`table-architecture.md`](./table-architecture.md) §33–§34):
- **`files`** — attachments (product images, receipts, logos) via two-phase upload (`temporary_files` → `files`), gated by `files_config`.
- **`notes`** — free-text notes on any record.
- **`address`** — postal addresses (uses `lookup` type `ADDRESS_TYPE`).
- **`communication`** — email/phone/fax/website (uses `lookup` type `COMMUNICATION_TYPE`).
- **`contact_person`** — named contacts (uses `lookup` types `CONTACT_PERSON_TYPE`, `TITLE`).

**Rule:** no DB FK on `record_id`/`record_guuid` (polymorphic) — enforce parent existence in app + run an orphan-cleanup job.

---

## 5. End-to-end flow

```
1. SEED (deploy)
   - lookup_type: ~15 POS categories (§8).
   - lookup: global values (is_system=true) per category.
   - entity_types: Product, Customer, Order, Supplier, Store…

2. SYNC TO DEVICE (/sync/initial + delta)
   - Global lookups (store_fk = null) + this store's custom lookups + entity_types
     download into the mobile SQLite store. They are offline-safe reference data.

3. RENDER A DROPDOWN (offline or online)
   - Client reads lookup WHERE lookup_type_fk = <type> AND is_active AND NOT is_hidden
     ORDER BY sort_order — no network call needed (data is local).

4. USER PICKS A VALUE + SAVES A RECORD (may be offline)
   - e.g. customer.paymentTerm = <lookup guuid of 'NET30' under PAYMENT_TERMS>
   - The row stores (payment_term_type_fk, payment_term_fk). On sync, the composite FK
     guarantees the value is a PAYMENT_TERMS value — a bad ref is rejected at the DB, not
     silently accepted (D2).

5. STORE ADDS A CUSTOM VALUE (online)
   - POST /lookup/{typeCode}/values  → inserts lookup row with store_fk = <store>,
     is_system = false. Syncs down to that store's devices via delta.

6. POLYMORPHIC ATTACH
   - Add a note to a customer: notes(entity_type_fk = Customer, record_guuid = <cust guuid>, body).
   - Attach a product image: temporary_files (upload) → files (commit,
     entity_type_fk = Product, record_guuid = <product guuid>), limits from files_config.
```

---

## 6. Services & repositories (NestJS)

### `LookupModule`
- **`LookupRepository`**
  - `listByType(typeCode, storeId)` → global + store-custom values, active, non-hidden, ordered by `sort_order`. (Resolves `type_code → lookup_type_fk` once, cached.)
  - `resolve(typeCode, code, storeId?)` → one value (store-custom first, else global).
  - `insertValue({ typeCode, storeFk, code, label, ... })`.
  - `updateValue(guuid, patch)` — reject if `is_system`.
  - `softDeleteValue(guuid)` — reject if `is_system`.
- **`LookupTypeRepository`** — CRUD for types (admin-only).
- **`LookupService`** — orchestration + business rules (§9); resolves store from `RequestContext`.
- **`LookupCache`** (optional) — Redis cache of `lookup:{typeCode}:{storeId}` (short TTL) for hot server-side reads.

### `EntityTypesModule`
- **`EntityTypesRepository`** — `findByCode(code)`, `listOfflineSafe()`, `supportsAttachments(code)`. **This wires the currently-orphaned table.**
- Used by the polymorphic services (`FilesService`, `NotesService`, `AddressService`, `CommunicationService`, `ContactPersonService`) to resolve `entity_type_fk` by code and validate `supports_attachments` before allowing a `files` insert.

---

## 7. API

Base: `/api`. Store-scoped routes require the store context; type CRUD is owner/admin only.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/lookup/:typeCode/values` | Dropdown: active, non-hidden values (global + store-custom), ordered |
| `POST` | `/lookup/:typeCode/values` | Add a store-custom value (`is_system=false`) — owner |
| `PATCH` | `/lookup/values/:guuid` | Edit a value (rejected for `is_system`) — owner |
| `DELETE` | `/lookup/values/:guuid` | Soft-delete a value (rejected for `is_system`) — owner |
| `GET` | `/lookup/types` | List categories (admin) |
| `POST` | `/lookup/types` | Create a category (admin) |
| `GET` | `/entity-types` | List entity registry (mostly internal/sync) |

Response envelope per the global `ResponseInterceptor`. Values are returned with `guuid`, `code`, `label`, `sort_order`.

---

## 8. Seed data — POS lookup types

Seed these ~15 categories (`is_system=true` values shown as examples). Everything logic-bearing stays a `text` enum and is NOT seeded here.

| `lookup_type.code` | title | example values (code · label) |
|---|---|---|
| `PAYMENT_TERMS` | Payment Terms | `COD`·Cash on Delivery, `NET7`·Net 7, `NET15`·Net 15, `NET30`·Net 30 |
| `CUSTOMER_TYPE` | Customer Type | `WALK_IN`, `REGULAR`, `WHOLESALE`, `B2B` |
| `SUPPLIER_TYPE` | Supplier Type | `DISTRIBUTOR`, `MANUFACTURER`, `LOCAL` |
| `REASONS` | Reasons | `DAMAGED`, `EXPIRED`, `WRONG_ITEM`, `CUSTOMER_RETURN`, `STOCK_COUNT` |
| `EXPENSE_CATEGORY` | Expense Categories | `RENT`, `UTILITIES`, `SALARY`, `SUPPLIES`, `TRANSPORT` |
| `CHARGES` | Charges | `PACKING`, `DELIVERY`, `SERVICE` |
| `DISCOUNT_TYPE` | Discount Type | `PERCENT`, `FLAT`, `SCHEME` |
| `DELIVERY_OPTION` | Delivery Options | `PICKUP`, `HOME_DELIVERY`, `COURIER` |
| `DELIVERY_CONDITION` | Delivery Condition | `GOOD`, `DAMAGED`, `PARTIAL` |
| `STORAGE_TYPE` | Storage Type | `AMBIENT`, `CHILLED`, `FROZEN` |
| `ADDRESS_TYPE` | Address Type | `BILLING`, `SHIPPING`, `REGISTERED` |
| `COMMUNICATION_TYPE` | Communication Type | `PHONE`, `EMAIL`, `WHATSAPP` |
| `CONTACT_PERSON_TYPE` | Contact Person Type | `PRIMARY`, `ACCOUNTS`, `LOGISTICS` |
| `TITLE` | Salutation | `MR`·Mr., `MS`·Ms., `MRS`·Mrs. |
| `NOTIFICATION_TYPE` | Notification Type | `ORDER`, `STOCK`, `PAYMENT`, `SYSTEM` |
| `NOTIFICATION_PRIORITY` | Notification Priority | `LOW`, `NORMAL`, `HIGH`, `CRITICAL` |

Seed `entity_types`: `Product`, `ProductCategory`, `Customer`, `Supplier`, `Order`, `Store`, `Location`, `Expense`, `Purchase` — with `is_offline_safe` and `supports_attachments` set per entity.

---

## 9. Business rules

- **BR-1** `is_system=true` values are immutable — reject edit/delete (`403 LOOKUP_VALUE_PROTECTED`).
- **BR-2** Store-custom values (`store_fk` set) are editable only by that store's owner/admin.
- **BR-3** A dropdown returns **global + this store's** values, filtered `is_active AND NOT is_hidden`, ordered by `sort_order`.
- **BR-4** `code` is unique **per type** (D3); creating a duplicate code within a type → `409 LOOKUP_CODE_EXISTS`.
- **BR-5** Every `_lk_fk` write must carry the matching `_type_fk`; the composite FK (D2) rejects mismatches at the DB.
- **BR-6** Deleting a lookup value is a **soft-delete** (`is_active=false`); rows referencing it keep their FK (historical integrity).
- **BR-7** A `files` insert is allowed only if `entity_types.supports_attachments = true` for the target entity, and only within `files_config` limits (size/count/extension).
- **BR-8** Lookups and `entity_types` are read-mostly reference data — included in the offline sync snapshot; a value change bumps its `updated_at` for delta pickup.

---

## 10. Offline-sync integration (D7)

- **Initial sync** (`/sync/initial`): download all `entity_types`, all global `lookup` (store_fk null), and the store's custom `lookup`.
- **Delta** (`/sync/delta`): lookups changed since cursor (by `updated_at`), scoped to global + store.
- **Tombstones:** a hard-removed lookup emits a tombstone (guuid-keyed) so devices drop it; normal removals are `is_active=false` (soft) and sync as an update.
- **Client authoring:** a store owner adding a custom value while offline queues a `lookup` insert (with a client-generated `guuid`); on sync the server accepts it (store-scoped, `is_system=false`).
- **Referential safety on sync:** because a `_lk_fk` mutation carries `(type_fk, value_fk)`, the composite FK validates it server-side even though it was built offline.

---

## 11. Type-safety enforcement (replaces `@LookupExists`)

The Java ERP validated `_lk_fk` at request-binding with `@LookupExists` / `existsByTypeAndCode`. That runs on the server at write time — **too late for offline mutations**. Our enforcement is structural:

1. Add `unique(lookup_type_fk, id)` on `lookup` (composite-FK target).
2. Referencing rows store `(<x>_type_fk, <x>_fk)` and declare a composite FK → `lookup(lookup_type_fk, id)`.
3. The `_type_fk` is a fixed constant per column (the PAYMENT_TERMS type id, etc.), set by the service, never user-chosen.

Result: the database guarantees every `_lk_fk` points at a value of the correct type, whether the row was created online or synced from a device.

---

## 12. Explicitly NOT built (and why)

| Skipped (from ayphen-3.0) | Why |
|---|---|
| `has_table` / `is_custom_table` + `DynamicTableRepository` | Runtime-SQL generic-table engine — fights type safety and offline sync. Categories needing extra columns become real tables (`unit`, `tax_rate`) directly. |
| `lookup.key` numeric double-identifier | Redundant under a `guuid` sync model. |
| Global-unique `lookup.code` | Latent bug — replaced by per-type unique (D3). |
| `application_entity` + `application_operations_map_attributes` metadata engine | ERP metadata-driven-everything spine (RBAC + numbering + audit + approval). Replaced by store-scoped RBAC + on-device numbering + enum statuses. |
| generic `status` table + `entity_status_mapping` | We use `text` enums (type-safe, `switch`-able). |
| App-only `@LookupExists` validation as the sole guard | Insufficient across the offline sync boundary — replaced by composite FK (§11). |

---

## 13. Build plan

| Phase | Work | Depends on |
|---|---|---|
| **P0** | Wire `entity_types` (repository + seed check); add `unique(lookup_type_fk, id)` prerequisite | — |
| **P1** | Create `lookup_type` + `lookup` tables + migration; seed the ~15 POS types + global values | P0 |
| **P2** | `LookupModule` (repo/service/controller) + API (§7) + business rules (§9) | P1 |
| **P3** | Composite-FK enforcement pattern (§11) applied to the first consumers (customer/supplier payment terms, expense category) | P1 |
| **P4** | Polymorphic tables (`files`/`temporary_files`/`files_config`, `notes`, `address`, `communication`, `contact_person`) referencing `entity_types` + `lookup` | P0–P2 |
| **P5** | Sync integration: include lookups + entity_types in `/sync/initial` + delta + tombstones | P1, sync layer |

---

## 14. Acceptance criteria

- [ ] `entity_types` is read by at least one repository (no longer orphaned).
- [ ] A store owner can add a custom `REASONS` value via API; it appears in that store's dropdown and syncs to that store's devices only.
- [ ] `is_system` values cannot be edited or deleted (403).
- [ ] Two different lookup types can both have a value coded `CASH` (per-type unique holds).
- [ ] Writing a `payment_term_fk` that points at a non-PAYMENT_TERMS value is rejected by the database (composite FK), including on a synced-from-offline mutation.
- [ ] A note/attachment can be added to a Product and a Customer using the same `notes`/`files` table via `entity_type_fk` + `record_guuid`.
- [ ] A `files` insert is blocked when `entity_types.supports_attachments = false` or when `files_config` limits are exceeded.
- [ ] Global lookups + the store's custom lookups + `entity_types` download in `/sync/initial` and update via delta.

---

## 15. Summary

Take the **lookup engine** and the **entity-types polymorphic anchor** from ayphen-3.0 — but simplified and hardened for an offline-first POS: hybrid enum/lookup (D1), **composite-FK type enforcement** instead of app-only validation (D2), per-type-unique codes (D3), `store_fk` custom values (D4), `guuid` sync keys (D5), and full sync-payload inclusion (D7). Skip the dynamic-table engine, the `application_entity` metadata spine, and the generic status table — three pieces of ERP-scale flexibility that would cost type safety and offline simplicity. Net new tables: `lookup_type`, `lookup` (+ the already-planned `entity_types` wiring and the §33–§34 polymorphic tables).
