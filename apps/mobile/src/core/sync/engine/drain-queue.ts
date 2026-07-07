import { appliersRegistry } from '../appliers/appliers.registry';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import {
  mutationQueueRepository,
  type MutationQueueRow,
} from '../repositories/mutation-queue.repository';
import { pushDelta } from '../transport/sync-transport';
import { isPoisonPushError } from '../transport/push-error-classifier';
import { withTransaction } from '../db/transaction';
import { applyChangesPage } from './apply-changes';
import { reconcileMutationResult } from './reconcile-mutation-result';
import type { SyncDb } from '../db/types';
import type { WireRow } from '../repositories/synced-table.repository';
import type {
  SyncMutationInput,
  MutationResultWire,
} from '../transport/sync-wire-types';

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
 * Reconcile ONE mutation result against the queue + the entity's local table.
 * Extracted so the caller can run it inside either one whole-batch transaction
 * (the common case) or its own single-row transaction (the isolation
 * fallback) — the reconciliation logic itself doesn't know or care which.
 *
 * Row swap + queue status commit TOGETHER (INV-10's push-side counterpart to
 * INV-9) — a crash between "authoritative row written" and "queue row marked
 * applied" must not leave the mutation stuck re-drainable forever, nor marked
 * applied with the swap never having happened.
 */
async function reconcileOneResult(
  tx: SyncDb,
  storeId: string,
  mutationResult: MutationResultWire,
  byMutationId: Map<string, MutationQueueRow>,
  now: string,
): Promise<void> {
  const action = reconcileMutationResult(mutationResult);
  const queueRow = byMutationId.get(mutationResult.mutation_id);

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
      await mutationQueueRepository.markConflict(
        tx,
        mutationResult.mutation_id,
        action.serverRow,
      );
      break;

    case 'rollback': {
      // Terminal server rejection — revert the optimistic local write so it
      // doesn't linger as a phantom row (duplicate SKU, business-rule denial
      // the client Zod can't catch). A create optimistically inserted a local
      // row keyed by guuid (enqueue-*.ts); delete it by guuid, mirroring
      // commit-applied's temp-row cleanup. update/delete rollback needs the
      // pre-image the enqueue must capture — none are enqueued yet, so when
      // enqueueUpdate*/enqueueDelete* land they MUST snapshot the prior row.
      if (queueRow?.action === 'create') {
        await appliersRegistry
          .get(queueRow.entityType)
          ?.applyDeletes(tx, [queueRow.entityGuuid]);
      }
      await mutationQueueRepository.markRejected(
        tx,
        mutationResult.mutation_id,
        action.code,
        action.message,
        now,
      );
      break;
    }

    case 'keep-queued':
      // retry_later — status stays 'pending', nothing local is touched.
      await mutationQueueRepository.recordRetryLater(
        tx,
        mutationResult.mutation_id,
        now,
      );
      break;
  }
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
export async function drainMutationQueueOnce(
  db: SyncDb,
  storeId: string,
): Promise<DrainResult> {
  const batch = await mutationQueueRepository.takeDrainable(
    db,
    storeId,
    MAX_BATCH,
  );
  if (batch.length === 0) return { drained: 0, hasMorePulled: false };

  const ids = batch.map((m) => m.mutationId);
  await mutationQueueRepository.markInflight(db, ids);

  const cursor = await syncCursorRepository.get(db, storeId);
  let result: Awaited<ReturnType<typeof pushDelta>>;
  try {
    result = await pushDelta(storeId, {
      syncCursor: cursor ?? undefined,
      supportedEntityTypes: appliersRegistry.entityTypes(),
      mutations: batch.map(toWireMutation),
    });
  } catch (err) {
    // Whole-batch push failure — reset the in-flight batch to 'pending' so the
    // next tick re-drains it, then rethrow so SyncScheduler.runExclusive can
    // apply rate-limit backoff / log. WITHOUT this the batch stays 'inflight'
    // forever (takeDrainable only re-selects 'pending') and the writes never
    // sync. Classified so offline/5xx/timeout/429 (transport's fault) can
    // never age a mutation toward 'dead' the way an actual batch-level
    // rejection (poison — see push-error-classifier.ts) does.
    const failNow = new Date().toISOString();
    const message = err instanceof Error ? err.message : 'push failed';
    if (isPoisonPushError(err)) {
      await mutationQueueRepository.recordPoisonFailureBatch(
        db,
        ids,
        message,
        failNow,
      );
    } else {
      await mutationQueueRepository.recordTransportFailureBatch(
        db,
        ids,
        message,
        failNow,
      );
    }
    throw err;
  }

  const now = new Date().toISOString();
  const byMutationId = new Map(
    batch.map((row) => [row.mutationId, row] as const),
  );

  // Reconcile the whole batch in ONE transaction — cuts transaction count from
  // O(batch size) to 1 in the common (no-failure) case, which is what most
  // batches are. Falls back to one transaction per result only if the
  // whole-batch attempt throws, isolating whichever single result caused it
  // instead of losing the rest of the batch's reconciliation to it (same
  // isolate-on-failure shape as apply-with-isolation.ts on the pull side).
  try {
    await withTransaction(db, async (tx) => {
      for (const mutationResult of result.mutation_results) {
        await reconcileOneResult(
          tx,
          storeId,
          mutationResult,
          byMutationId,
          now,
        );
      }
    });
  } catch {
    for (const mutationResult of result.mutation_results) {
      await withTransaction(db, (tx) =>
        reconcileOneResult(tx, storeId, mutationResult, byMutationId, now),
      );
    }
  }

  // Defensive: any batch row the server returned NO result for is still
  // 'inflight' — re-pend it so it re-drains instead of stranding. Unlike the
  // whole-batch catch above, this got a successful (200) response — the
  // server processed the batch and simply dropped this one result, a
  // poison-adjacent server-side anomaly rather than a connectivity issue, so
  // it DOES count toward the dead-letter cap if it keeps recurring.
  const answered = new Set(result.mutation_results.map((r) => r.mutation_id));
  const unanswered = ids.filter((id) => !answered.has(id));
  if (unanswered.length > 0) {
    await mutationQueueRepository.recordPoisonFailureBatch(
      db,
      unanswered,
      'no result returned by server',
      now,
    );
  }

  if (result.sync_cursor) {
    await applyChangesPage(
      db,
      storeId,
      result.changes,
      result.sync_cursor,
      result.server_time,
    );
  }

  return { drained: batch.length, hasMorePulled: result.has_more };
}
