import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { appliersRegistry } from '../appliers/appliers.registry';
import { mutationQueueRepository, type MutationQueueRow } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';
import { resolveConflict as reportConflictResolution } from '../transport/sync-transport';
import type { WireRow } from '../repositories/synced-table.repository';
import { logger } from '../../../utils/logger';

/**
 * Conflicts only ever arise from `update` (master-data.handler.ts's optimistic
 * lock) — `server_row` is guaranteed populated whenever `status='conflict'`;
 * the handler returns `rejected` instead for a missing/deleted entity, never
 * `conflict`. So neither branch here needs a "server deleted it" fallback.
 */

/**
 * Tell the backend its `sync_conflicts` row is dealt with — pure bookkeeping so
 * the server-side conflict log doesn't go stale (the client stays the source of
 * truth; the server never merges). Best-effort and fire-and-forget AFTER the
 * local resolution has already committed: a failed/again-rate-limited call must
 * never block or undo the user's choice, so we only log it.
 */
function reportResolvedToServer(
  storeId: string,
  mutationId: string,
  status: 'resolved' | 'discarded',
): void {
  void reportConflictResolution(storeId, mutationId, { status }).catch((err) => {
    logger.warn('[sync] could not report conflict resolution to server', err);
  });
}

/**
 * Discard the local edit, adopt the server's version. One transaction: the
 * applied row and the queue-row removal must commit together, or a crash
 * between them leaves the conflict reappearing even though local data is
 * already correct (harmless but confusing — still worth the same discipline
 * every other commit point in this engine follows).
 */
export async function takeServerVersion(storeId: string, row: MutationQueueRow): Promise<void> {
  const applier = appliersRegistry.get(row.entityType);
  const serverRow = JSON.parse(row.serverRow as string) as WireRow;

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    if (applier) {
      await applier.upsertAll(tx, storeId, [serverRow]);
    }
    await mutationQueueRepository.remove(tx, row.mutationId);
  });

  // Local edit thrown away in favour of the server's row → the client's
  // mutation was discarded.
  reportResolvedToServer(storeId, row.mutationId, 'discarded');
}

/**
 * Keep the local edit — rebase it onto the server's row_version and resubmit
 * under a FRESH mutation_id (never resurrect the conflicted one). Removing
 * the old row and enqueueing the new one must commit together: a crash
 * between them would otherwise leave a stale 'conflict' row AND a new
 * 'pending' row for the same logical edit, showing as a phantom duplicate in
 * the Sync Issues list forever.
 */
export async function resubmitMine(storeId: string, row: MutationQueueRow): Promise<void> {
  const serverRow = JSON.parse(row.serverRow as string) as WireRow;
  const now = new Date().toISOString();

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await mutationQueueRepository.remove(tx, row.mutationId);
    await mutationQueueRepository.enqueue(tx, {
      mutationId: ulid(),
      storeId,
      entityType: row.entityType,
      entityGuuid: row.entityGuuid,
      action: row.action,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      expectedRowVersion: Number(serverRow.row_version),
      clientModifiedAt: now,
      parentGuuid: row.parentGuuid ?? undefined,
      priority: row.priority,
      now,
    });
  });

  // The original conflict is being resolved by rebasing + resubmitting the
  // local edit under the server's fresh row_version.
  reportResolvedToServer(storeId, row.mutationId, 'resolved');

  requestImmediateSync();
}
