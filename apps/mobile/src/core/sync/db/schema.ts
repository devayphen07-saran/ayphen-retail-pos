import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Local mirror of the backend sync registry (sync-engine.md §3, verified against
 * apps/backend/src/sync/registry/sync-filter.registry.ts and
 * apps/backend/src/sync/push/handlers/*). Field names/nullability follow the
 * wire projection each GenericSyncFilter actually selects — NOT the full
 * backend row — so a column missing here means the backend doesn't sync it.
 *
 * All synced tables are partitioned by `storeId` (a column, not a separate
 * SQLite file — "partition" here means WHERE storeId = :active, and eviction
 * of an unused store is a DELETE, not a file operation).
 *
 * Every synced row carries `modifiedAt` as the µs-precision ISO string the
 * server renders it as (us-timestamp.ts) — stored verbatim as TEXT so it never
 * round-trips through a JS Date and loses precision (S-8).
 */

const bool = (name: string) => integer(name, { mode: 'boolean' });

// ─── A1. Reference / config — pull-only ─────────────────────────────────────

export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  guuid: text('guuid').notNull(),
  storeId: text('store_id').notNull(), // == id; kept for a uniform WHERE storeId=? across repositories
  name: text('name').notNull(),
  gstNumber: text('gst_number'),
  address: text('address'), // JSON blob, stored as text
  phone: text('phone'),
  email: text('email'),
  invoicePrefix: text('invoice_prefix'),
  isActive: bool('is_active'),
  locked: bool('locked'),
  modifiedAt: text('modified_at').notNull(),
});

export const units = sqliteTable('units', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  name: text('name').notNull(),
  abbreviation: text('abbreviation'),
  allowsFractions: bool('allows_fractions'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

export const taxRates = sqliteTable('tax_rates', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  name: text('name').notNull(),
  ratePercent: text('rate_percent').notNull(), // canonical string, not float (money-adjacent precision)
  isInclusive: bool('is_inclusive'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

/**
 * `store_fk` is nullable on the SERVER (globalOrStoreScope — a global lookup
 * has no owning store), but `fromWire` always stamps the CALLER's active
 * storeId locally (never left null, even for a global row) — so this table
 * declares `storeId` NOT NULL and gives it a COMPOSITE primary key with `id`,
 * not a single-column one. A global row (e.g. `BUSINESS_CATEGORY`'s `id`) is
 * the SAME server id regardless of which store pulls it; with `id` alone as
 * the PK, upsertAll's onConflictDoUpdate(target: id) would let the SECOND
 * store's sync silently overwrite the FIRST store's local `storeId` stamp on
 * that shared row — a multi-store owner switching stores on one device would
 * see a global lookup value vanish from the store that synced it first. The
 * composite key gives each (store, lookup) pair its own local row instead.
 */
export const lookups = sqliteTable(
  'lookups',
  {
    id: text('id').notNull(),
    storeId: text('store_id').notNull(),
    guuid: text('guuid').notNull(),
    lookupTypeFk: text('lookup_type_fk').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order'),
    isHidden: bool('is_hidden'),
    /** Not confirmed in the current pull projection — assumed necessary so the
     *  client can hide edit/delete affordances the server would reject anyway
     *  (LOOKUP_VALUE_PROTECTED, master-data.handler.ts guardRow). Flag with
     *  backend if this ever comes through as null for a genuinely system row. */
    isSystem: bool('is_system'),
    isActive: bool('is_active'),
    rowVersion: integer('row_version').notNull(),
    modifiedAt: text('modified_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.id] })],
);

export const paymentMethods = sqliteTable('payment_methods', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  kind: text('kind'),
  sortOrder: integer('sort_order'),
  isSystem: bool('is_system'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

// ─── A2. Catalog / master — writable offline ────────────────────────────────

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  name: text('name').notNull(),
  sku: text('sku'),
  barcode: text('barcode'),
  categoryLookupFk: text('category_lookup_fk'), // resolved server-side FROM category_lookup_guuid on push
  unitFk: text('unit_fk'),
  taxrateFk: text('taxrate_fk'),
  sellingPrice: text('selling_price').notNull(), // canonical 2dp string (payload-helpers.ts `money`)
  costPrice: text('cost_price'),
  mrp: text('mrp'),
  hsnCode: text('hsn_code'),
  trackInventory: bool('track_inventory'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

export const productCases = sqliteTable('product_cases', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  productFk: text('product_fk').notNull(),
  name: text('name').notNull(),
  quantity: text('quantity').notNull(), // up to 3dp (payload-helpers.ts `quantity`)
  barcode: text('barcode'),
  sellingPrice: text('selling_price'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  guuid: text('guuid').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  gstNumber: text('gst_number'),
  customerTypeLookupFk: text('customer_type_lookup_fk'),
  creditLimit: text('credit_limit'),
  isActive: bool('is_active'),
  rowVersion: integer('row_version').notNull(),
  modifiedAt: text('modified_at').notNull(),
});

// ─── B. Client-only bookkeeping (NOT server tables) ─────────────────────────

/** One opaque HMAC-signed delta cursor per store_fk. Stored verbatim — the
 *  app must never parse or reconstruct `token` (mobile-11 §13). */
export const syncCursors = sqliteTable('sync_cursors', {
  storeId: text('store_id').primaryKey(),
  token: text('token').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Cold-start resume position per (store, entity) — mirrors the server's
 *  sync_init_progress row 1:1 so a crash mid-cold-start resumes exactly. */
export const syncInitProgress = sqliteTable(
  'sync_init_progress',
  {
    storeId: text('store_id').notNull(),
    entityType: text('entity_type').notNull(),
    cursor: text('cursor'), // last page_cursor seen (entityType:lastId), or null
    phase: text('phase', { enum: ['in_progress', 'completed'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.entityType] })],
);

/** Outbound mutation queue (mobile-10 §3 `pending_mutations`). One row per
 *  queued write; `status` is the authoritative queue-drain state machine. */
export const mutationQueue = sqliteTable('mutation_queue', {
  mutationId: text('mutation_id').primaryKey(), // ULID — also the idempotency key the server dedupes on
  storeId: text('store_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityGuuid: text('entity_guuid').notNull(),
  action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
  payload: text('payload').notNull(), // JSON-encoded mutation payload (server wire shape)
  expectedRowVersion: integer('expected_row_version'), // required for action='update'
  clientModifiedAt: text('client_modified_at').notNull(), // server-clock-aligned queue time
  parentGuuid: text('parent_guuid'),
  priority: integer('priority').notNull().default(0),
  status: text('status', {
    enum: ['pending', 'inflight', 'applied', 'rejected', 'conflict', 'dead'],
  })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  serverRow: text('server_row'), // JSON — populated on status='conflict'
  firstFailureAt: text('first_failure_at'),
  lastFailureAt: text('last_failure_at'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
});

/** Pull-side DLQ — a server row that couldn't apply locally (missing FK,
 *  schema mismatch). Surfaced like the push DLQ (mobile-10 §3). */
export const failedApplies = sqliteTable(
  'failed_applies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: text('store_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityGuuid: text('entity_guuid').notNull(),
    // Which applier method `data` should retry through — without this, retry
    // always called upsertAll(), so a failed DELETE (data = `{ guuid }`) was
    // replayed as an upsert forever and its tombstone never actually retried.
    operation: text('operation', { enum: ['upsert', 'delete'] }).notNull().default('upsert'),
    data: text('data').notNull(), // JSON — the row (upsert) or `{ guuid }` (delete) that failed to apply
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: text('last_attempt_at'),
    lastError: text('last_error'),
  },
  // One DLQ row per (store, entity, guuid) — a repeatedly-failing row bumps
  // `attempts` in place instead of spawning a duplicate every retry cycle.
  (t) => [
    uniqueIndex('failed_applies_store_entity_unq').on(t.storeId, t.entityType, t.entityGuuid),
  ],
);

/** Local schema version gate — migrate-before-sync (INV-5). A single row. */
export const schemaMeta = sqliteTable('schema_meta', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  migratedAt: text('migrated_at').notNull(),
});

/** Client-only per-store sync bookkeeping that is NOT part of the cursor's
 *  opaque token. Today it holds one thing: the `permissions_version` this store
 *  was last synced under. A permission GRANT bumps that version server-side,
 *  but a cold start done while the user lacked `view` on an entity anchored
 *  that entity's delta watermark at cold-start time — so pre-existing rows
 *  (older than the watermark) would never delta-backfill once the grant lands
 *  (S-5, the cold-start counterpart of the delta re-grant path). Detecting the
 *  version bump on open lets us re-cold-start and pick those rows up. */
export const syncStoreMeta = sqliteTable('sync_store_meta', {
  storeId: text('store_id').primaryKey(),
  permissionsVersion: integer('permissions_version'),
  /** JSON-encoded `string[]` of the `entity:action` grants last synced under
   *  (permission-rebase.ts) — lets a version bump be diffed for a REVOKED
   *  `view` grant, not just detected as "something changed". */
  permissions: text('permissions'),
  updatedAt: text('updated_at').notNull(),
});
