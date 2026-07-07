import { appliersRegistry } from '../appliers/appliers.registry';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { pullChanges } from '../transport/sync-transport';
import { applyChangesPage } from './apply-changes';
import { retryFailedApplies } from './retry-failed-applies';
import type { SyncDb } from '../db/types';

/** Steady-state delta pull (sync-engine.md §7, mobile-11 §5). Drains
 *  `has_more` fully before idling — a partial drain leaves the client
 *  artificially behind until the next scheduler tick. */
export async function pullDeltaToCompletion(db: SyncDb, storeId: string): Promise<void> {
  let hasMore = true;
  while (hasMore) {
    const cursor = await syncCursorRepository.get(db, storeId);
    if (!cursor) {
      throw new Error(`[sync] no delta cursor for store ${storeId} — cold start must run first`);
    }

    const result = await pullChanges(storeId, cursor, appliersRegistry.entityTypes());
    await applyChangesPage(db, storeId, result.changes, result.sync_cursor, result.server_time);
    hasMore = result.has_more;
  }

  // Now that every page's rows are committed, re-attempt any DLQ rows whose
  // missing-FK parent may have arrived in this drain (mobile-10 §3).
  await retryFailedApplies(db, storeId, new Date().toISOString());
}
