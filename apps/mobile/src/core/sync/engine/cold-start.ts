import { appliersRegistry } from '../appliers/appliers.registry';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { syncInitProgressRepository } from '../repositories/sync-init-progress.repository';
import { pullInitial } from '../transport/sync-transport';
import { withTransaction } from '../db/transaction';
import { upsertWithIsolation } from './apply-with-isolation';
import type { SyncDb } from '../db/types';

export interface ColdStartStepResult {
  allComplete: boolean;
}

/**
 * One page of cold start (sync-engine.md §5, mobile-11 §4). Loop this until
 * `allComplete` — the SERVER decides which entity comes next (dependency
 * order) when no `entity_type` is given; the client's job is just to resume
 * correctly after a crash.
 *
 * Resume rule: prefer the LOCAL `in_progress` row's cursor over asking the
 * server to pick fresh. The server also tracks per-device progress and would
 * happily resume on its own, but it marks a page "sent" the moment it's
 * generated — not when the client confirms it was durably applied. If the
 * app crashes after receiving a page but before this function's transaction
 * commits, the server already believes that page was delivered. Local
 * progress is the only record of what was ACTUALLY applied, so it — not a
 * bare re-call — is what re-requests that exact page via the `cursor` param.
 */
export async function runColdStartStep(db: SyncDb, storeId: string): Promise<ColdStartStepResult> {
  const localRows = await syncInitProgressRepository.listFor(db, storeId);
  const resume = localRows.find((r) => r.phase === 'in_progress');

  const result = await pullInitial(storeId, appliersRegistry.entityTypes(), {
    entityType: resume?.entityType,
    cursor: resume?.cursor ?? undefined,
  });

  // Rows + progress + (on the final page) the delta cursor all commit
  // TOGETHER, in ONE transaction (INV-9's cold-start counterpart). Splitting
  // the final cursor write into a separate call after this one — as this
  // function used to — means a crash between the two leaves every entity
  // marked 'completed' locally but no delta cursor, so the next `openStore()`
  // sees no cursor and re-runs cold start FROM SCRATCH even though nothing
  // was actually lost (wasteful, not corrupting, but entirely avoidable).
  await withTransaction(db, async (tx) => {
    if (result.entity_type) {
      const applier = appliersRegistry.get(result.entity_type);
      const phase = result.has_more ? 'in_progress' : 'completed';

      // Isolate a poison row (bad type, missing required field) instead of
      // letting it block this entity's cold start forever — the batch upsert
      // falls back to one row at a time, recording only the row(s) that
      // fail to the pull-side DLQ (mobile-10 §3); the page still commits and
      // progress still advances past it.
      if (applier) {
        await upsertWithIsolation(tx, storeId, result.entity_type, applier, result.upserts, result.server_time);
      }
      await syncInitProgressRepository.savePage(
        tx,
        storeId,
        result.entity_type,
        result.page_cursor,
        phase,
        result.server_time,
      );
    }

    if (result.all_entities_complete && result.next_delta_cursor) {
      await syncCursorRepository.set(tx, storeId, result.next_delta_cursor, result.server_time);
    }
  });

  return { allComplete: result.all_entities_complete };
}

/** Drive cold start to completion — call once when a store is opened for the
 *  first time (or after a 410 SYNC_HORIZON_EXCEEDED reset). */
export async function runColdStart(db: SyncDb, storeId: string): Promise<void> {
  let done = false;
  while (!done) {
    const { allComplete } = await runColdStartStep(db, storeId);
    done = allComplete;
  }
}
