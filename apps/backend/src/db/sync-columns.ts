import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Columns every synced, client-writable table carries (sync-engine.md §3/§4):
 *
 * - `guuid` — the client-visible sync key. Clients upsert pulled rows and
 *   address mutations by this, never by the server `id`.
 * - `rowVersion` — optimistic-lock version for master-data updates (§11).
 *   The `sync_touch_row` DB trigger bumps it on UPDATE unless the statement
 *   already did (so version-gated handler updates aren't double-bumped).
 * - `modifiedAt` — the server-assigned delta watermark (BR-SYNC-002). It is
 *   maintained by the trigger, never by application code, and is read back at
 *   µs precision via `to_char(.., 'US')` — see sync/us-timestamp.ts (S-8).
 *
 * A FACTORY, not a shared object: `.unique()` bakes the constraint name into
 * the builder instance, so a shared spread would emit the same index name on
 * every table (schema-wide collision). Each table gets fresh builders.
 */
export const syncColumns = () => ({
  guuid:      uuid('guuid').notNull().defaultRandom().unique(),
  rowVersion: integer('row_version').notNull().default(1),
  modifiedAt: timestamp('modified_at', { withTimezone: true }).notNull().defaultNow(),
});