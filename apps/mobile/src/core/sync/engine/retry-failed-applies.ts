import { appliersRegistry } from '../appliers/appliers.registry';
import { withTransaction } from '../db/transaction';
import { failedAppliesRepository } from '../repositories/failed-applies.repository';
import type { WireRow } from '../repositories/synced-table.repository';
import type { SyncDb } from '../db/types';

/** Poison cap — matches the push queue's dead-letter threshold. A row that has
 *  failed to apply this many times stops being retried: it stays in the DLQ
 *  (visible), but no longer burns a transaction every cycle. */
const RETRY_POISON_CAP = 7;

/** Max DLQ rows processed per cycle — without this, a DLQ that's grown large
 *  (extended offline period, a data-quality issue) gets fully re-queried and
 *  re-attempted on every single 5-minute tick forever. The next cycle picks
 *  up where this one left off. */
const RETRY_BATCH_SIZE = 50;

/**
 * Re-apply pull-side DLQ rows whose blocking dependency may now exist — a child
 * row that failed for a missing FK parent applies cleanly once a later page
 * delivered that parent (mobile-10 §3, the "retry where dependencies now exist"
 * step). Runs AFTER the delta pull drains, so any just-arrived parent is
 * already committed.
 *
 * All rows in the batch share ONE transaction (cuts transaction count from
 * O(batch size) to 1 in the common case), but each row's apply is still tried
 * and caught individually WITHIN it — a still-missing dependency must only
 * roll back and bump that one row's attempt count, not undo the rows that did
 * apply this pass. This differs from drain-queue.ts's whole-batch-then-
 * fallback shape deliberately: here a single row failing is the routine case
 * (that's the entire reason it's in the DLQ), not an exceptional one, so
 * catching per-row from the start is correct rather than an escape hatch.
 * Rows at the poison cap are left untouched.
 */
export async function retryFailedApplies(db: SyncDb, storeId: string, now: string): Promise<void> {
  const rows = await failedAppliesRepository.listRetryable(db, storeId, RETRY_POISON_CAP, RETRY_BATCH_SIZE);
  if (rows.length === 0) return;

  await withTransaction(db, async (tx) => {
    for (const row of rows) {
      const applier = appliersRegistry.get(row.entityType);
      if (!applier) continue; // entity not supported by this build — leave it for a later version

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch (err) {
        // An unparseable payload will never apply — bump attempts so the poison
        // cap retires it instead of re-parsing it forever.
        await failedAppliesRepository.recordAttempt(tx, row.id, `unparseable DLQ payload: ${String(err)}`, now);
        continue;
      }

      try {
        // Dispatch through the SAME method the original apply used — a delete
        // whose tombstone failed to apply must retry as a delete, not as an
        // upsert of its `{ guuid }` placeholder (apply-with-isolation.ts is
        // the only writer of this row, and always stamps `operation` to match).
        if (row.operation === 'delete') {
          const guuid = (parsed as { guuid?: unknown }).guuid;
          if (typeof guuid !== 'string') {
            throw new Error('delete DLQ row has no string guuid');
          }
          await applier.applyDeletes(tx, [guuid]);
        } else {
          await applier.upsertAll(tx, storeId, [parsed as WireRow]);
        }
        await failedAppliesRepository.deleteById(tx, row.id);
      } catch (err) {
        await failedAppliesRepository.recordAttempt(
          tx,
          row.id,
          err instanceof Error ? err.message : String(err),
          now,
        );
      }
    }
  });
}