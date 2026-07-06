import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { mutationQueue } from '../db/schema';
import type { SyncDb } from '../db/types';

export type MutationAction = 'create' | 'update' | 'delete';
export type MutationQueueStatus = 'pending' | 'inflight' | 'applied' | 'rejected' | 'conflict' | 'dead';
export type MutationQueueRow = typeof mutationQueue.$inferSelect;

export interface EnqueueInput {
  mutationId: string; // ULID — also the server idempotency key
  storeId: string;
  entityType: string;
  entityGuuid: string;
  action: MutationAction;
  payload: unknown; // server wire shape — JSON-stringified on write
  expectedRowVersion?: number; // required for action='update'
  clientModifiedAt: string;
  parentGuuid?: string;
  priority?: number;
  now: string;
}

const MAX_ATTEMPTS_BEFORE_DEAD = 7;

/**
 * The outbound queue (mobile-10 §3 `pending_mutations`). `status` is the
 * authoritative drain state machine — every transition here must match the
 * server's five-way result contract (sync-engine.md §9 / delta.service.ts):
 * applied/duplicate → 'applied'; conflict → 'conflict' (server_row attached);
 * rejected → 'rejected' (terminal, roll back the optimistic write at the
 * caller); retry_later → status is left EXACTLY as-is (still 'pending'/
 * 'inflight') — this is not a separate status, it's "do nothing and try
 * again next drain," which is why there's no markRetryLater transition below.
 */
export const mutationQueueRepository = {
  async enqueue(db: SyncDb, entry: EnqueueInput): Promise<void> {
    await db.insert(mutationQueue).values({
      mutationId: entry.mutationId,
      storeId: entry.storeId,
      entityType: entry.entityType,
      entityGuuid: entry.entityGuuid,
      action: entry.action,
      payload: JSON.stringify(entry.payload),
      expectedRowVersion: entry.expectedRowVersion ?? null,
      clientModifiedAt: entry.clientModifiedAt,
      parentGuuid: entry.parentGuuid ?? null,
      priority: entry.priority ?? 0,
      status: 'pending',
      attempts: 0,
      createdAt: entry.now,
    });
  },

  /** Drain order: priority DESC (HIGH before LOW), then FIFO within a tier —
   *  parent-before-child ordering (parent_guuid dependency) is the caller's
   *  job once composite/POS mutations exist; master-data writes have no
   *  cross-mutation dependency today. */
  async takeDrainable(db: SyncDb, storeId: string, limit: number): Promise<MutationQueueRow[]> {
    return db
      .select()
      .from(mutationQueue)
      .where(and(eq(mutationQueue.storeId, storeId), eq(mutationQueue.status, 'pending')))
      .orderBy(desc(mutationQueue.priority), asc(mutationQueue.createdAt))
      .limit(limit);
  },

  async markInflight(db: SyncDb, mutationIds: string[]): Promise<void> {
    if (mutationIds.length === 0) return;
    await db
      .update(mutationQueue)
      .set({ status: 'inflight' })
      .where(inArray(mutationQueue.mutationId, mutationIds));
  },

  /** `applied` or `duplicate` (treated identically — a replayed decision). */
  async markApplied(db: SyncDb, mutationId: string): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'applied' })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /** Terminal — caller must roll back whatever was optimistically applied
   *  locally BEFORE calling this (this only updates queue bookkeeping). */
  async markRejected(db: SyncDb, mutationId: string, errorCode: string, errorMessage: string, now: string): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'rejected', errorCode, errorMessage, lastFailureAt: now })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /** Stale row_version — keep queued with the server's row attached; the
   *  resolver rebases and enqueues a FRESH mutation (new mutation_id), it
   *  never resurrects this row. */
  async markConflict(db: SyncDb, mutationId: string, serverRow: unknown): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'conflict', serverRow: JSON.stringify(serverRow) })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /**
   * Server said `retry_later` (subscription paused/reconciliation-pending) —
   * NOT a failure and NOT subject to the dead-letter cap below: this can
   * legitimately persist for as long as the account stays in that transient
   * state (a subscription lapse is a business fact, not a bug), so aging it
   * toward 'dead' would wrongly quarantine an honest queued write. Stays
   * 'pending'; only observability fields move.
   */
  async recordRetryLater(db: SyncDb, mutationId: string, now: string): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'pending', lastFailureAt: now })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /**
   * Transient failure (network error, 5xx) — NOT a status change beyond
   * possible dead-lettering. Reset to 'pending' so the next drain picks it up
   * again, and bump diagnostics. Exceeding MAX_ATTEMPTS_BEFORE_DEAD quarantines
   * it to 'dead' so one poison mutation can't block the rest of the queue
   * forever (mirrors the server's own POISON_MUTATION_MAX_FAILURES, tracked
   * independently client-side).
   */
  async recordTransientFailure(
    db: SyncDb,
    mutationId: string,
    errorMessage: string,
    now: string,
  ): Promise<void> {
    const [row] = await db
      .select({ attempts: mutationQueue.attempts, firstFailureAt: mutationQueue.firstFailureAt })
      .from(mutationQueue)
      .where(eq(mutationQueue.mutationId, mutationId))
      .limit(1);
    const attempts = (row?.attempts ?? 0) + 1;
    await db
      .update(mutationQueue)
      .set({
        status: attempts >= MAX_ATTEMPTS_BEFORE_DEAD ? 'dead' : 'pending',
        attempts,
        firstFailureAt: row?.firstFailureAt ?? now,
        lastFailureAt: now,
        errorMessage,
      })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  async listByStore(db: SyncDb, storeId: string): Promise<MutationQueueRow[]> {
    return db.select().from(mutationQueue).where(eq(mutationQueue.storeId, storeId));
  },

  async remove(db: SyncDb, mutationId: string): Promise<void> {
    await db.delete(mutationQueue).where(eq(mutationQueue.mutationId, mutationId));
  },
};
