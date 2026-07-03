# Lookup System — `lookup_type` & `lookup`

> **Source analysed:** `ayphen-3.0` (Java / Spring Boot monolith) — `src/main`
> **Purpose of this doc:** full reference for the generic lookup engine — table structure, seed catalogue, API, service/repository logic, usage across the schema, and the design trade-off — as a blueprint for adopting the same pattern into the Ayphen Retail POS backend.

---

## 1. What this is (one paragraph)

`lookup_type` + `lookup` are a **generic reference-data engine**: one two-table pair that replaces what would otherwise be ~80 tiny enum tables. `lookup_type` is the **catalogue of dropdown categories** (Months, Payment Terms, Customer Type…); `lookup` holds the **actual values** inside each category (January…December; Net 15/Net 30; Walk-in/Regular…). Every configurable dropdown, status, method, and frequency in the ERP lives here instead of in its own table, is served to the UI by one controller, and is referenced by other tables through a plain `*_lk_fk` foreign key.

---

## 2. Table structure

### 2.1 `lookup_type` — the category definitions

```sql
CREATE TABLE public.lookup_type (
    id              SERIAL PRIMARY KEY,           -- Primary key
    code            VARCHAR(30)  NOT NULL UNIQUE, -- Machine key: 'PAYMENT_TERMS', 'MONTHS'…
    title           VARCHAR(50)  NOT NULL,        -- Human label: 'Payment Terms', 'Months'
    description     VARCHAR(150) NULL,
    has_table       BOOLEAN DEFAULT FALSE,        -- true = also backed by a dedicated table
    is_active       BOOLEAN DEFAULT TRUE,         -- soft-enable
    is_custom_table BOOLEAN DEFAULT FALSE         -- true = values live in a custom table, not `lookup`
);
CREATE INDEX idx_lookup_type_id        ON public.lookup_type (id);
CREATE INDEX idx_lookup_type_is_active ON public.lookup_type (is_active);
```

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | internal PK |
| `code` | varchar(30) unique | machine key referenced everywhere in code via constants |
| `title` | varchar(50) | UI label for the category |
| `description` | varchar(150) null | optional |
| `has_table` | boolean | `true` → this type is *also* mirrored to / backed by a real table (needs columns beyond a label) |
| `is_custom_table` | boolean | `true` → the type's values live in a **custom** table, not as generic `lookup` rows (e.g. `VOLUMES`) |
| `is_active` | boolean | soft-enable |

### 2.2 `lookup` — the values

```sql
CREATE TABLE public.lookup (
    id             SERIAL PRIMARY KEY,
    key            INT8,                        -- Stable numeric key (what *_lk_fk columns store)
    code           VARCHAR(30) NOT NULL UNIQUE, -- Machine key: 'JAN', 'ACCRUAL', 'MRR'
    title          VARCHAR(50) NOT NULL,        -- Display label: 'January', 'Accrual', 'Mr.'
    description    VARCHAR(100),                -- Optional tooltip
    lookup_type_fk INT8        NOT NULL,        -- FK → lookup_type
    sort_order     INT4        NULL,            -- Display ordering in the dropdown
    is_hidden      BOOLEAN DEFAULT FALSE,       -- Show/hide in UI without deleting
    is_system      BOOLEAN DEFAULT FALSE,       -- System-defined (protected from user edit/delete)
    is_active      BOOLEAN DEFAULT TRUE         -- Soft-delete
);
CREATE INDEX idx_lookup_id        ON public.lookup (id);
CREATE INDEX idx_lookup_is_active ON public.lookup (is_active);
```

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | internal PK |
| `key` | int8 | a **stable numeric key** — this is the value stored in other tables' `*_lk_fk` columns |
| `code` | varchar(30) unique | machine key (resolved by code+type in service logic) |
| `title` | varchar(50) | display label |
| `description` | varchar(100) null | optional |
| `lookup_type_fk` | int8 | which category this value belongs to |
| `sort_order` | int4 | dropdown ordering |
| `is_hidden` | boolean | hide from UI without deleting |
| `is_system` | boolean | protected system value (user cannot edit/delete) |
| `is_active` | boolean | soft-delete |

> **Note on `key` vs `id`:** the schema stores *both*. `id` is the row PK; `key` is a separate stable integer that foreign columns reference (`findByKey`). This indirection lets rows be reordered/re-seeded without breaking existing `*_lk_fk` references. In a fresh design you can collapse these unless you need re-seed stability.

### 2.3 Entity mapping (JPA)

```java
@Entity @Table(name = "lookup")
public class Lookup extends BaseReferenceEntity {
    @Id @GeneratedValue(strategy = IDENTITY) private Long id;
    @Column(name = "key", nullable = false)   private Long key;
    @Column(name = "code", length = 30)       private String code;
    @Column(name = "title", length = 50)      private String title;
    @Column(name = "description", length = 100) private String description;
    @ManyToOne @JoinColumn(name = "lookup_type_fk", nullable = false)
    private LookupType lookupType;             // ManyToOne → LookupType
    // + sortOrder, isHidden, isSystem, isActive
}
```

`Lookup` **@ManyToOne → `LookupType`**. One type has many values.

---

## 3. Seed catalogue — all 78 lookup types

Seeded once at deploy via `ayphen-master-initial-data.sql` (~78 `lookup_type` rows, hundreds of `lookup` value rows). Grouped by domain:

**Company / config**
`RESIDENT_STATUS`, `MONTHS`, `REPORT_BASIS`, `DATA_TYPE`, `TITLE` (salutations), `FIRST_DAY_OF_WEEK`, `ROUNDING_METHOD`, `ROM` (Round Off Method), `REGISTRATION_TYPE`, `INDUSTRY_TYPE`, `BUSINESS_OPERATIONS`, `OPERATION_GROUPS`, `DATE_FORMAT`, `LANGUAGE`, `PERMISSION_TYPE`, `APPLICATION_ENTITY_TYPE`, `PLATFORM`(via `platform_lk_fk`).

**Tax / GST**
`TAX_SCOPE`, `FILING_FREQUENCY_TYPE`, `INVOICE_TYPE` (Sales/Purchase), `INVOICE_PROCESS`.

**Products / inventory**
`PRODUCT_TYPE` *(has_table)*, `DEFAULT_UNIT_MEASURE`, `VOLUMES` *(has_table, custom)*, `PR_GRP` (Product Group), `INV_MAP_TYPE`, `STRG` (Storage Ambience), `STYPE` (Storage Type), `ITEM_SECTION`.

**Customers / suppliers**
`CUSTOMER_TYPE`, `SUPPLIER_TYPE`, `SUB_TYPE`, `BILLING_TYPE`, `PAYMENT_TERMS`, `CREDIT_LIMIT_ACTION`, `CUS_NOTIFICATION`.

**Sales / pricing / discount**
`DISCOUNT_LEVEL`, `DISCOUNT_TYPE`, `MARKUP_TYPE`, `CHARGES`, `CHANNEL`, `REASONS`, `RFTYPE` (Refund Type), `TRANSACTION_ENTITY_CATEGORY`, `TRANSACTION_DETAIL`, `TRANSACTION_SUMMARY_TYPE`, `JOURNAL_RECORD_TYPE`.

**Delivery**
`DLVRY` (Delivery Options), `DLCDN` (Delivery Condition), `SLA_UNIT`.

**Filters / reporting (UI)**
`INVOICE_FILTERS`, `BILL_FILTERS`, `DATE_FILTERS`, `DATE_FILTER_LIMITED`, `TRX_FILTERS`, `AGING_FREQUENCY`, `AGING_FREQUENCY_STATEMENT`.

**Frequency / recurrence**
`FREQUENCY_TYPE`, `RECURSION_FREQUENCY_UNIT`, `RECURSION_STATUS`, `TSK_REC_FQ`, `TSK_REC_WOM`, `END_TYPE`, `BUDGET_PERIOD`, `PLAN_FRQ`.

**Expense / budget / project (PMS)**
`EXP_TYP` (Expense Types), `BILLABLE_LEVEL`, `BILLABLE_TYPE`, `PRO_BILL_TYP`, `PRO_ENG_TYP`, `PRO_BILL_RATE`, `TSK_TYP`, `WT_CAT` (Work Time Category), `PLAN_TYPE`, `PRE_DEP_TYP` (Dependency Types), `ACTIVITY_TYPE`.

**Notifications**
`NOTIFICATION_TYPE`, `NOTIFICATION_PRIORITY`, `NTF_CNL` (Notification Channel).

**Ops / audit / recon**
`AUDIT_ACTION`, `RECON_PROVIDER_LIST`.

### 3.1 Example value rows (from `lookup` seed)

```
key code    title            type          sort
1   RES     Resident         RESIDENT_STATUS  1
2   NRES    Non Resident     RESIDENT_STATUS  2
3   JAN     January          MONTHS           1
…   …       …                MONTHS           …
14  DEC     December         MONTHS           12
15  ACCRUAL Accrual          REPORT_BASIS     1   -- "Records transactions when earned"
16  CASH    Cash             REPORT_BASIS     2   -- "Records transactions when cash exchanged"
17  TEXT    Text Field       DATA_TYPE        1
18  SELE    Select List      DATA_TYPE        2
19  MRR     Mr.              TITLE            1
20  MSS     Ms.              TITLE            2
21  MRS     Mrs.             TITLE            3
22  ZERO    Zero Rated       TAX_SCOPE        1
23  DTAX    Destination Tax  TAX_SCOPE        2
31  NRST    Round Nearest    ROUNDING_METHOD  1
32  UP      Round Up         ROUNDING_METHOD  2
33  DOWN    Round Down       ROUNDING_METHOD  3
34  WARN    Warn             CREDIT_LIMIT_ACTION 1
35  BLCK    Block            CREDIT_LIMIT_ACTION 2
```

---

## 4. Who references it — the `*_lk_fk` columns

Other tables store a lookup value via a plain FK column suffixed `_lk_fk`. There are **21 distinct reference columns** across the schema:

```
resident_status_lk_fk            registration_type_lk_fk
default_cus_engagement_type_lk_fk fin_year_end_mon_lk_fk        -- (a MONTHS value)
billing_type_id_lk_fk            payment_term_id_lk_fk
gender_lk_fk                     title_lk_fk / salutation_id_lk_fk
status_lk_fk                     datatype_lk_fk
platform_lk_fk                   type_lk_fk (fk_type_lk_fk)

-- RBAC permission columns (application_entity):
create_lk_fk / fk_create_lk_fk   view_lk_fk / fk_view_lk_fk
edit_lk_fk   / fk_edit_lk_fk     delete_lk_fk / fk_delete_lk_fk
```

Examples:
- `company.registration_type_lk_fk` → a `REGISTRATION_TYPE` value.
- `company.resident_status_lk_fk` → a `RESIDENT_STATUS` value.
- `company_general_settings.fin_year_end_mon_lk_fk` → a `MONTHS` value.
- `customer.billing_type_id_lk_fk` / `payment_term_id_lk_fk` → `BILLING_TYPE` / `PAYMENT_TERMS`.
- `users.gender_lk_fk`, `users.title_lk_fk` → `GENDER` / `TITLE`.
- `application_entity.{create,view,edit,delete}_lk_fk` → `PERMISSION_TYPE` values (the RBAC matrix stores permission levels as lookups).

---

## 5. The flow (end to end)

```
1. SEED (deploy)
   ayphen-master-initial-data.sql inserts 78 lookup_type rows + hundreds of lookup rows.
   System values → is_system=true (protected).

2. CLIENT loads a dropdown
   GET /lookup/{lookupTypeCode}/data
     → LookupService.fetchLookupTypeData(typeCode)
     → LookupRepository.findByLookupTypeCodeAndIsActiveTrueOrderBySortOrder(typeCode)
     → returns [{code, title, key, sortOrder}, …] to render the dropdown.

3. USER saves a record with a dropdown selection
   e.g. Customer.billingType = 'NET30'
     → service validates: existsByLookupTypeCodeAndCodeAndIsActiveTrue('PAYMENT_TERMS','NET30')
       (guards that the code is legal FOR THAT TYPE — the DB can't enforce this)
     → resolves the Lookup row, stores its key in customer.payment_term_id_lk_fk.

4. READ back
   → join / findByKeyAndIsActiveTrue(key) to render 'Net 30' in the UI.

5. USER-EXTENSIBLE (non-system types)
   POST /lookup/{lookupTypeCode}/create → add a new value (is_system=false).
   PUT  /lookup/{lookupTypeCode}/update/{code}, DELETE .../delete/{code}.
```

---

## 6. API surface (`LookupController`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/lookup/{lookupTypeCode}/data` | Fetch all active values for a type (paged) — populates a dropdown |
| `POST` | `/lookup/{lookupTypeCode}/create` | Add a new value to a type (user-defined) |
| `PUT` | `/lookup/{lookupTypeCode}/update/{code}` | Edit a value |
| `DELETE` | `/lookup/{lookupTypeCode}/delete/{code}` | Soft-delete a value |
| `DELETE` | `/lookup/lookup-types/{lookupTypeCode}/data` | Bulk-delete values of a type |
| `POST` | `/lookup/lookup-types` | Create a new lookup **type** |
| `PUT` | `/lookup/lookup-type/{code}` | Edit a type |
| `DELETE` | `/lookup/lookup-type/{code}` | Delete a type |

`GET …/data` returns `Page<Map<String,Object>>` — generic key/value maps so any type renders uniformly on the client.

---

## 7. Resolution logic (`LookupRepository`)

Queries are by **code + type code**, so business logic reads in domain language, never magic ids:

```java
// Resolve one value within its type
Optional<Lookup> findByCodeAndLookupTypeCode(String code, String lookupTypeCode);
Optional<Lookup> findByCodeAndLookupTypeCodeAndIsActiveTrue(String code, String typeCode);

// Full ordered dropdown for a type
List<Lookup> findByLookupTypeCodeAndIsActiveTrueOrderBySortOrder(String lookupTypeCode);
List<Lookup> findByLookupTypeCodeAndIsActiveTrueOrderByKeyAsc(String lookupTypeCode);

// VALIDATION before saving a *_lk_fk (compensates for no DB type constraint)
boolean existsByLookupTypeCodeAndCodeAndIsActiveTrue(String typeCode, String code);
boolean existsByLookupTypeCodeAndCodeIgnoreCaseAndIsActiveTrue(String typeCode, String code);

// Reverse lookup from the stored numeric key
Optional<Lookup> findByKeyAndIsActiveTrue(Long key);

// Batch
List<Lookup> findAllByKeyInAndLookupTypeCode(List<Long> keys, String typeCode);
```

**Named constants** tie code→type so strings are never inlined:
- `LookupTypeConstants` → `LK_TYPE_MONTHS`, etc. (the type codes).
- `MasterKeyConstants` → `STORAGE_TYPE_DEFAULT_CODE`, `STORAGE_AMBIENCE_DEFAULT_CODE`, etc. (specific value codes).

Typical service usage (`CommonUtils`):
```java
// resolve a month value
lookupRepository.findByCodeAndLookupTypeCode(code, LookupTypeConstants.LK_TYPE_MONTHS)
    .orElseThrow(...);
// resolve defaults
lookupRepository.findByCodeAndLookupTypeCodeAndIsActiveTrue(
    MasterKeyConstants.STORAGE_TYPE_DEFAULT_CODE, LK_TYPE_STORAGE_TYPE);
// validate a submitted code belongs to its type before persisting
if (!lookupRepository.existsByLookupTypeCodeAndCodeAndIsActiveTrue(lookupCode, lookupKey)) { … reject … }
```

---

## 8. Why it's designed this way

| Benefit | How |
|---|---|
| **Avoid schema sprawl** | ~78 categories in 2 tables + 1 repo + 1 controller, instead of 78 enum tables/repos |
| **User-extensible dropdowns** | `POST /{type}/create` adds values at runtime; `is_system=false` = user-owned, `is_system=true` = protected |
| **UI fully backend-controlled** | `sort_order` (ordering), `is_hidden` (show/hide), `title` (label) — no frontend change to re-order or relabel |
| **Uniform client rendering** | every dropdown fetched the same way (`GET /{type}/data` → key/value maps) |
| **Escape hatch to real tables** | `has_table` / `is_custom_table` flags mark types that outgrew a simple label (e.g. `PRODUCT_TYPE`, `VOLUMES`, `DATE_FORMAT`) and are backed by a dedicated table, while still registered in `lookup_type` so the UI treats them uniformly |

---

## 9. Design trade-off (the one real weakness)

A `*_lk_fk` column is a **plain FK into `lookup`** — the database **cannot enforce that a value belongs to the correct type**. `customer.billing_type_id_lk_fk` could physically point at a `MONTHS` value. That is why nearly every write path calls `existsByLookupTypeCodeAndCode…` to validate the `(type, code)` pair **in application code** before saving.

- **Cost:** type-safety is discipline-based, not constraint-based. A missed validation = a silently wrong reference.
- **Mitigations** (recommended if adopting): (a) always validate `(type, code)` on write via a single shared helper; (b) optionally add a composite FK `(lookup_type_fk, id)` and store `lookup_type_fk` alongside the value on the referencing row so a real composite FK enforces the type; (c) keep `is_system` values immutable.

---

## 9A. Is this design correct for OUR app? — verdict

**Partially. Adopt it *selectively*, not wholesale.** Ayphen Retail POS is an **offline-first mobile POS**, not a server-centric accounting suite, so the calculus differs from ayphen-3.0 (which over-used the pattern). The correct design for us is a **hybrid**:

### The decision rule
> If TypeScript would ever `switch` on it, or business logic depends on a specific value → **enum / union type**.
> If it's just a label a user picks from a list they can extend at runtime → **lookup**.

### ✅ Use `lookup` for — runtime-extensible, store-specific, no logic

| Field / concept | Lookup type |
|---|---|
| Customer payment terms | `PAYMENT_TERMS` |
| Customer / supplier classification | `CUSTOMER_TYPE`, `SUPPLIER_TYPE` |
| Adjustment / void / return reasons | `REASONS` |
| Expense categories | `EXP_TYP` |
| Additional charges | `CHARGES` |
| Discount categories | `DISCOUNT_TYPE` |
| Delivery options / condition | `DLVRY`, `DLCDN` |
| Storage area / ambience | `STORAGE_TYPE`, `STRG` |
| Notification type / priority / channel | `NOTIFICATION_TYPE`, `NOTIFICATION_PRIORITY`, `NTF_CNL` |

These vary per store, users create new ones, nothing branches on them → one `lookup` table beats a dozen tiny tables.

### ❌ Do NOT use `lookup` for — fixed, logic-bearing state (use `text enum`)

Keep these as Postgres `text('…', { enum: [...] })` / TS union types (as your current schema already does):

| Field | Values | Why enum |
|---|---|---|
| `order.status` | pending_sync·completed·voided·refunded·partially_refunded | code `switch`es on it |
| `order.payment_status` | paid·credit·partial·refunded | logic branches |
| `order.supply_type` | intra_state·inter_state | drives CGST/SGST vs IGST tax logic |
| `order.document_type` | tax_invoice·sales_receipt·delivery_challan | fixed set |
| `product.tracking_type` | none·batch·serial·fefo | inventory logic keys off it |
| `refund.status`, `purchase.status`, `stock_adjustment.status` | fixed lifecycles | state machines |
| `inventory_movement.movement_type` | fixed | logic |
| `device_session.status`, subscription `status`, etc. | fixed | already enums ✅ |

Putting these in `lookup` would **lose compile-time type safety** (TS can't narrow a runtime string), **add a join to every read**, and **let an unhandled value exist** that your `switch` doesn't cover. ayphen-3.0 made this mistake with `REPORT_BASIS`, `DATA_TYPE`, `PERMISSION_TYPE`, `ROUNDING_METHOD` — don't copy it.

### Offline-first fixes (mandatory for us — ayphen-3.0 was always-online)

1. **Enforce type with a real composite FK, not app-code discipline.** Offline mutations are built on the phone and synced later, so a server-side `existsByTypeAndCode` guard is too late. Store `lookup_type_fk` on the referencing row and use a **composite FK `(lookup_type_fk, lookup_fk)`** so the DB guarantees the value matches the type — no bad `_lk_fk` can sync up.
2. **Ship lookups in the sync payload.** Lookups are `is_offline_safe` reference data: global lookups + the store's custom lookups must download in `/sync/initial` and update via delta. Wire them into the sync layer, not just a REST endpoint.
3. **Drop the numeric `key` indirection — reference by `guuid`.** ayphen-3.0 keeps both `id` and a separate stable `key`; in our guuid-based sync model that's redundant. Use `guuid` like every other syncable row.

### Two bugs in the source to fix on adoption

1. **`lookup.code` is globally unique in ayphen-3.0 — a latent bug** (two types can't both have a `CASH` value). Scope the unique index to **`(lookup_type_fk, code)`**.
2. **No per-store custom values.** Add **`store_fk` (nullable)**: null = global seed, set = a value this store created.

**Bottom line:** hybrid — enums for the ~10 fixed state fields, `lookup` for the ~12 extensible store lists, with the composite-FK / per-type-unique / `store_fk` / guuid fixes below. Blanket-adopting `lookup` for everything loses type safety on your state machines; skipping it entirely leaves a dozen redundant tables. The hybrid is right.

---

## 10. Adopting into Ayphen Retail POS (TS / Drizzle)

If you bring this pattern into `apps/backend`:

```ts
// lookup_type
export const lookupType = pgTable('lookup_type', {
  id:            uuid('id').primaryKey().defaultRandom(),
  code:          varchar('code', { length: 40 }).notNull().unique(),   // 'PAYMENT_TERMS'
  title:         varchar('title', { length: 80 }).notNull(),
  description:   varchar('description', { length: 200 }),
  hasTable:      boolean('has_table').notNull().default(false),
  isCustomTable: boolean('is_custom_table').notNull().default(false),
  isActive:      boolean('is_active').notNull().default(true),
});

// lookup
export const lookup = pgTable('lookup', {
  id:           uuid('id').primaryKey().defaultRandom(),
  lookupTypeFk: uuid('lookup_type_fk').notNull().references(() => lookupType.id),
  storeFk:      uuid('store_fk').references(() => stores.id),  // null = global; set = store-custom value
  code:         varchar('code', { length: 40 }).notNull(),
  label:        varchar('label', { length: 80 }).notNull(),
  description:  varchar('description', { length: 200 }),
  sortOrder:    integer('sort_order').notNull().default(0),
  isHidden:     boolean('is_hidden').notNull().default(false),
  isSystem:     boolean('is_system').notNull().default(false),
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('lookup_type_code_uq').on(t.lookupTypeFk, t.code),   // unique per type (not globally)
  index('idx_lookup_type').on(t.lookupTypeFk),
]);
```

**Carry-over rules:**
1. Query by **(typeCode, code)**, not raw id — keep business logic readable.
2. **Validate (type, code) before every write** to a `*_lk_fk` column via one shared guard.
3. Scope the unique index to **`(lookup_type_fk, code)`**, not global `code` (the Java schema's global-unique `code` is a latent bug — two types can't share a code like `CASH`).
4. Add `store_fk` (nullable) so a store can add its **own** values (Reasons, Charges) without touching global seed data.
5. Keep the `has_table` escape hatch for categories that later need real columns.

**POS lookup types worth seeding** (subset relevant to retail): `PAYMENT_TERMS`, `CUSTOMER_TYPE`, `SUPPLIER_TYPE`, `DISCOUNT_TYPE`, `RFTYPE` (Refund Type), `REASONS` (adjustment/void reasons), `CHARGES`, `STORAGE_TYPE`, `STRG` (Storage Ambience), `DLVRY` (Delivery Options), `DLCDN` (Delivery Condition), `EXP_TYP` (Expense Types), `MONTHS`, `TITLE`, `CHANNEL`, `ROUNDING_METHOD`, `CREDIT_LIMIT_ACTION`, `NOTIFICATION_TYPE`/`NOTIFICATION_PRIORITY`/`NTF_CNL`.

---

## 11. Summary

- **`lookup_type`** = catalogue of ~78 dropdown categories (code + title + `has_table`/`is_custom_table` flags).
- **`lookup`** = the values inside each category (code + label + `lookup_type_fk` + sort/hidden/system flags), stored/referenced by a stable `key`.
- **21 `*_lk_fk` columns** across the schema point into `lookup`.
- **One controller** (`LookupController`) serves and manages all dropdowns; **one repository** resolves by (code, type) and validates.
- **Strength:** massive schema-sprawl savings + runtime-extensible, UI-controlled dropdowns.
- **Weakness:** no DB-level guarantee a value matches its expected type → validate `(type, code)` in app code on every write. When adopting, scope the unique index per-type and add `store_fk` for store-custom values.
