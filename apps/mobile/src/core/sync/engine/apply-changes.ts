import { appliersRegistry } from '../appliers/appliers.registry';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { withTransaction } from '../db/transaction';
import { upsertWithIsolation, deleteWithIsolation } from './apply-with-isolation';
import type { SyncApplier } from '../appliers/applier.types';
import type { SyncDb } from '../db/types';
import type { EntityChanges } from '../transport/sync-wire-types';

/** Just the lookup this function needs — lets tests inject a fake registry
 *  (e.g. an applier that throws) without mocking the real singleton. */
export interface ApplierLookup {
  get(entityType: string): SyncApplier | undefined;
  /** Registration order — parents before the tables that reference them
   *  (appliers.registry.ts's own ordering: store/unit/taxrate/lookup/
   *  payment_method before product before product_case; lookup before
   *  customer). Upserts apply in this order; deletes apply in REVERSE. */
  entityTypes(): string[];
}

/**
 * Apply one delta page and advance the cursor — used identically by
 * `/sync/changes` and the delta page piggybacked on `/sync/delta`'s response.
 *
 * INV-9 (the single most important rule in this whole module): the cursor
 * advances ONLY after the rows commit, in the SAME transaction. Persist the
 * cursor first (or in a separate tx) and a crash between the two silently
 * skips those rows forever — the server's no-gap watermark guarantees a row
 * committed during the read window is re-delivered, but only if the client
 * never told the server it already has it.
 */
export async function applyChangesPage(
  db: SyncDb,
  storeId: string,
  changes: Record<string, EntityChanges>,
  newCursorToken: string,
  now: string,
  registry: ApplierLookup = appliersRegistry,
): Promise<void> {
  // The server's `changes` object's key order is just its own JSON
  // serialization order — no cross-entity ordering guarantee (product_case
  // references product; product references unit/taxrate/lookup). The
  // registry's registration order already IS a valid parent-before-child
  // order, so upserts walk it forward and deletes walk it in REVERSE
  // (children before the parents they reference). Every entity's upserts
  // still land before any entity's deletes (BR-SYNC-021 per entity holds,
  // now more strongly — across entities too, not just within one).
  const orderedTypes = registry.entityTypes();

  await withTransaction(db, async (tx) => {
    for (const entityType of orderedTypes) {
      const entityChanges = changes[entityType];
      if (!entityChanges) continue;
      const applier = registry.get(entityType);
      if (!applier) continue; // defensive — we only ever request supported_entity_types
      await upsertWithIsolation(tx, storeId, entityType, applier, entityChanges.upserts, now);
    }

    for (const entityType of [...orderedTypes].reverse()) {
      const entityChanges = changes[entityType];
      if (!entityChanges) continue;
      const applier = registry.get(entityType);
      if (!applier) continue;
      await deleteWithIsolation(tx, storeId, entityType, applier, entityChanges.deletes.map((d) => d.guuid), now);
    }

    await syncCursorRepository.set(tx, storeId, newCursorToken, now);
  });
}
