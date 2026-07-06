import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { appliersRegistry } from '../appliers/appliers.registry';
import { mutationQueueRepository, type MutationQueueRow } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';
import type { WireRow } from '../repositories/synced-table.repository';

/**
 * Conflicts only ever arise from `update` (master-data.handler.ts's optimistic
 * lock) — `server_row` is guaranteed populated whenever `status='conflict'`;
 * the handler returns `rejected` instead for a missing/deleted entity, never
 * `conflict`. So neither branch here needs a "server deleted it" fallback.
 */

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

  requestImmediateSync();
}
