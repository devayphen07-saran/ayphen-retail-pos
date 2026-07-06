import { failedAppliesRepository } from '../repositories/failed-applies.repository';
import type { SyncApplier } from '../appliers/applier.types';
import type { SyncDb } from '../db/types';
import type { WireRow } from '../repositories/synced-table.repository';

/**
 * Apply one entity's upserts, isolating a poison row instead of letting it
 * block the rest of the page (or, for cold start, the rest of that entity's
 * pages) forever. A batch failure (one row's bad type, a missing required
 * field) falls back to one-row-at-a-time so every OTHER row still applies;
 * only the row(s) that fail individually are recorded to the pull-side DLQ
 * (mobile-10 §3) instead of being silently dropped — and the page still
 * commits, so the cursor/progress still advances past them. Re-requesting the
 * exact same bad row forever (the alternative — never advancing) would wedge
 * this store's sync permanently instead of just losing one row's visibility.
 */
export async function upsertWithIsolation(
  tx: SyncDb,
  storeId: string,
  entityType: string,
  applier: SyncApplier,
  rows: WireRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await applier.upsertAll(tx, storeId, rows);
  } catch {
    for (const row of rows) {
      try {
        await applier.upsertAll(tx, storeId, [row]);
      } catch (rowErr) {
        await failedAppliesRepository.record(tx, {
          storeId,
          entityType,
          entityGuuid: typeof row.guuid === 'string' ? row.guuid : String(row.id ?? 'unknown'),
          data: row,
          error: rowErr instanceof Error ? rowErr.message : String(rowErr),
          now,
        });
      }
    }
  }
}

/** Same isolation as `upsertWithIsolation`, for tombstone application. Less
 *  likely to hit the per-row fallback in practice (a guuid-list DELETE rarely
 *  partially fails), but cheap insurance against a driver-level error on one
 *  guuid taking the rest of the batch's deletes down with it. */
export async function deleteWithIsolation(
  tx: SyncDb,
  storeId: string,
  entityType: string,
  applier: SyncApplier,
  guuids: string[],
  now: string,
): Promise<void> {
  if (guuids.length === 0) return;
  try {
    await applier.applyDeletes(tx, guuids);
  } catch {
    for (const guuid of guuids) {
      try {
        await applier.applyDeletes(tx, [guuid]);
      } catch (rowErr) {
        await failedAppliesRepository.record(tx, {
          storeId,
          entityType,
          entityGuuid: guuid,
          data: { guuid },
          error: rowErr instanceof Error ? rowErr.message : String(rowErr),
          now,
        });
      }
    }
  }
}
