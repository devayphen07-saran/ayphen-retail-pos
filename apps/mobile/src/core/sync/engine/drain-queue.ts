import { appliersRegistry } from '../appliers/appliers.registry';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { mutationQueueRepository, type MutationQueueRow } from '../repositories/mutation-queue.repository';
import { pushDelta } from '../transport/sync-transport';
import { withTransaction } from '../db/transaction';
import { applyChangesPage } from './apply-changes';
import { reconcileMutationResult } from './reconcile-mutation-result';
import type { SyncDb } from '../db/types';
import type { WireRow } from '../repositories/synced-table.repository';
import type { SyncMutationInput } from '../transport/sync-wire-types';

const MAX_BATCH = 100; // server Zod cap (sync.constants.ts MAX_MUTATIONS_PER_BATCH)

function toWireMutation(row: MutationQueueRow): SyncMutationInput {
  return {
    mutation_id: row.mutationId,
    entity_type: row.entityType,
    action: row.action,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    expected_row_version: row.expectedRowVersion ?? undefined,
    client_modified_at: row.clientModifiedAt,
    parent_guuid: row.parentGuuid ?? undefined,
  };
}

export interface DrainResult {
  drained: number;
  hasMorePulled: boolean;
}

/**
 * One push+pull round trip (sync-engine.md §9, mobile-11 §6). Push-before-pull
 * is enforced by the caller (SyncScheduler on reconnect) — this function only
 * handles one batch; looping while the queue is non-empty is the scheduler's
 * job so a huge backlog doesn't block a single tick indefinitely.
 *
 * Reconciling the FIVE result kinds is the one place a shortcut costs real
 * data: `retry_later` must never be handled like `rejected` (see
 * reconcile-mutation-result.ts) — it is intentionally the only branch below
 * that touches neither the optimistic local write nor a terminal queue status.
 */
export async function drainMutationQueueOnce(db: SyncDb, storeId: string): Promise<DrainResult> {
  const batch = await mutationQueueRepository.takeDrainable(db, storeId, MAX_BATCH);
  if (batch.length === 0) return { drained: 0, hasMorePulled: false };

  await mutationQueueRepository.markInflight(db, batch.map((m) => m.mutationId));

  const cursor = await syncCursorRepository.get(db, storeId);
  const result = await pushDelta(storeId, {
    syncCursor: cursor ?? undefined,
    supportedEntityTypes: appliersRegistry.entityTypes(),
    mutations: batch.map(toWireMutation),
  });

  const now = new Date().toISOString();
  const byMutationId = new Map(batch.map((row) => [row.mutationId, row] as const));

  for (const mutationResult of result.mutation_results) {
    const action = reconcileMutationResult(mutationResult);
    const queueRow = byMutationId.get(mutationResult.mutation_id);

    // Row swap + queue status commit TOGETHER (INV-10's push-side
    // counterpart to INV-9) — a crash between "authoritative row written"
    // and "queue row marked applied" must not leave the mutation stuck
    // re-drainable forever, nor marked applied with the swap never having
    // happened.
    await withTransaction(db, async (tx) => {
      switch (action.kind) {
        case 'commit-applied': {
          if (action.data && queueRow) {
            const applier = appliersRegistry.get(queueRow.entityType);
            if (applier) {
              // A local create optimistically used `guuid` as the temp `id`
              // (enqueue-*-mutation.ts) — the server's authoritative row
              // carries a DIFFERENT real id, so upsertAll's onConflictDoUpdate
              // (which matches on id) would insert a SECOND row instead of
              // replacing the temp one. Delete the temp row by guuid first;
              // guuid itself is stable across the swap.
              if (queueRow.action === 'create') {
                await applier.applyDeletes(tx, [queueRow.entityGuuid]);
              }
              await applier.upsertAll(tx, storeId, [action.data as WireRow]);
            }
          }
          await mutationQueueRepository.markApplied(tx, mutationResult.mutation_id);
          break;
        }

        case 'commit-duplicate':
          await mutationQueueRepository.markApplied(tx, mutationResult.mutation_id);
          break;

        case 'mark-conflict':
          await mutationQueueRepository.markConflict(tx, mutationResult.mutation_id, action.serverRow);
          break;

        case 'rollback':
          // The optimistic local write must be reverted by the FEATURE code
          // that made it (this engine has no opinion on what "revert" means
          // for a given entity) — this only updates queue bookkeeping so the
          // row stops being re-drained.
          await mutationQueueRepository.markRejected(tx, mutationResult.mutation_id, action.code, action.message, now);
          break;

        case 'keep-queued':
          // retry_later — status stays 'pending', nothing local is touched.
          await mutationQueueRepository.recordRetryLater(tx, mutationResult.mutation_id, now);
          break;
      }
    });
  }

  if (result.sync_cursor) {
    await applyChangesPage(db, storeId, result.changes, result.sync_cursor, result.server_time);
  }

  return { drained: batch.length, hasMorePulled: result.has_more };
}
