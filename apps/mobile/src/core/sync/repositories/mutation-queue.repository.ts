import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { mutationQueue } from '../db/schema';
import type { SyncDb } from '../db/types';

export type MutationAction = 'create' | 'update' | 'delete';
export type MutationQueueStatus =
  'pending' | 'inflight' | 'applied' | 'rejected' | 'conflict' | 'dead';
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
  /** Prior row state for action='update'/'delete' — restored on terminal
   *  rejection (C5). Omit for 'create' (there is no prior row). */
  preImage?: unknown;
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
      preImage:
        entry.preImage === undefined ? null : JSON.stringify(entry.preImage),
      status: 'pending',
      attempts: 0,
      createdAt: entry.now,
    });
  },

  /** Drain order: priority DESC (HIGH before LOW), then FIFO within a tier —
   *  parent-before-child ordering (parent_guuid dependency) is the caller's
   *  job once composite/POS mutations exist; master-data writes have no
   *  cross-mutation dependency today. */
  async takeDrainable(
    db: SyncDb,
    storeId: string,
    limit: number,
  ): Promise<MutationQueueRow[]> {
    return db
      .select()
      .from(mutationQueue)
      .where(
        and(
          eq(mutationQueue.storeId, storeId),
          eq(mutationQueue.status, 'pending'),
        ),
      )
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
  async markRejected(
    db: SyncDb,
    mutationId: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'rejected', errorCode, errorMessage, lastFailureAt: now })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /** Stale row_version — keep queued with the server's row attached; the
   *  resolver rebases and enqueues a FRESH mutation (new mutation_id), it
   *  never resurrects this row. */
  async markConflict(
    db: SyncDb,
    mutationId: string,
    serverRow: unknown,
  ): Promise<void> {
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
  async recordRetryLater(
    db: SyncDb,
    mutationId: string,
    now: string,
  ): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'pending', lastFailureAt: now })
      .where(eq(mutationQueue.mutationId, mutationId));
  },

  /**
   * TRANSPORT failure of a whole in-flight batch — offline, timeout, 5xx, or
   * rate-limited (429) — the server never evaluated any mutation in the batch,
   * so nothing here indicates any single mutation is bad. Reset each row to
   * 'pending' so the next drain re-submits it, WITHOUT touching `attempts`:
   * an extended offline period or a saturated server must never age an honest
   * queued write toward 'dead' (that's what `recordPoisonFailureBatch` is
   * for — a genuinely non-retryable rejection). `lastFailureAt`/`errorMessage`
   * still update, so the failure is visible without threatening the row.
   *
   * WITHOUT this, a thrown `pushDelta` left the batch stranded in 'inflight'
   * forever — `takeDrainable` only re-selects 'pending', so those writes never
   * synced and no error surfaced (the canonical offline-write-loss bug).
   */
  async recordTransportFailureBatch(
    db: SyncDb,
    mutationIds: string[],
    errorMessage: string,
    now: string,
  ): Promise<void> {
    if (mutationIds.length === 0) return;
    await db
      .update(mutationQueue)
      .set({
        status: 'pending',
        lastFailureAt: now,
        errorMessage,
      })
      .where(inArray(mutationQueue.mutationId, mutationIds));
  },

  /**
   * POISON-signal batch failure — the server gave a definitive, non-retryable
   * rejection for the WHOLE batch (a 4xx other than 429, e.g. a malformed
   * request body `pushDelta`'s Zod schema rejects), or silently dropped a
   * mutation's result despite an otherwise-successful response. Retrying the
   * identical payload will fail identically, so — unlike
   * `recordTransportFailureBatch` — this DOES bump `attempts` in ONE
   * statement (a 100-row batch must not fan out to 100 round-trips on the
   * error path), quarantining a row to 'dead' past MAX_ATTEMPTS_BEFORE_DEAD so
   * one poison mutation can't block the queue forever (mirrors the server's
   * own POISON_MUTATION_MAX_FAILURES, tracked independently client-side).
   */
  async recordPoisonFailureBatch(
    db: SyncDb,
    mutationIds: string[],
    errorMessage: string,
    now: string,
  ): Promise<void> {
    if (mutationIds.length === 0) return;
    await db
      .update(mutationQueue)
      .set({
        attempts: sql`${mutationQueue.attempts} + 1`,
        status: sql`CASE WHEN ${mutationQueue.attempts} + 1 >= ${MAX_ATTEMPTS_BEFORE_DEAD} THEN 'dead' ELSE 'pending' END`,
        firstFailureAt: sql`COALESCE(${mutationQueue.firstFailureAt}, ${now})`,
        lastFailureAt: now,
        errorMessage,
      })
      .where(inArray(mutationQueue.mutationId, mutationIds));
  },

  /**
   * Immediately dead-letter mutations too old to safely replay (C2 / S-35).
   * A mutation older than the server's idempotency TTL may have had its
   * idempotency row purged already, so re-pushing it would re-execute the
   * business write (a double sale). Unlike `recordPoisonFailureBatch` this does
   * NOT count attempts — the mutation is terminally unsafe to resend, so it goes
   * straight to 'dead' for owner review rather than aging there over retries.
   */
  async markExpiredBatch(
    db: SyncDb,
    mutationIds: string[],
    now: string,
  ): Promise<void> {
    if (mutationIds.length === 0) return;
    await db
      .update(mutationQueue)
      .set({
        status: 'dead',
        errorCode: 'IDEMPOTENCY_EXPIRED',
        errorMessage:
          'mutation exceeded the server idempotency window and was not resent (would risk a duplicate)',
        firstFailureAt: sql`COALESCE(${mutationQueue.firstFailureAt}, ${now})`,
        lastFailureAt: now,
      })
      .where(inArray(mutationQueue.mutationId, mutationIds));
  },

  /**
   * Crash recovery — reset any rows orphaned in 'inflight' by a hard app-kill
   * between `markInflight` and reconcile back to 'pending'. Called once on store
   * open, INSIDE the scheduler's exclusive guard, so no push can be genuinely
   * in flight when it runs; in steady state it matches nothing.
   */
  async resetOrphanedInflight(db: SyncDb, storeId: string): Promise<void> {
    await db
      .update(mutationQueue)
      .set({ status: 'pending' })
      .where(
        and(
          eq(mutationQueue.storeId, storeId),
          eq(mutationQueue.status, 'inflight'),
        ),
      );
  },

  async listByStore(db: SyncDb, storeId: string): Promise<MutationQueueRow[]> {
    return db
      .select()
      .from(mutationQueue)
      .where(eq(mutationQueue.storeId, storeId));
  },

  /**
   * Entity guuids with an UNRESOLVED local mutation — pending (queued), inflight
   * (mid-push), or conflict (awaiting user rebase). The pull applier uses this
   * as the pending-mutation shadow (B1 / INV-11): it must NOT overwrite a row
   * whose local value is still authoritative-pending, or a delta pull landing
   * between a local optimistic edit and its push silently clobbers the edit.
   *
   * 'rejected'/'dead' are deliberately EXCLUDED: those are terminal, so the
   * pulled server row is the truth and should be allowed to correct the
   * never-accepted optimistic value. Only upserts are shadowed against this set,
   * never deletes — a skipped delete would not re-deliver (the server advances
   * the cursor by what it sent) and would resurrect the row (§8, worse).
   */
  async liveGuuids(db: SyncDb, storeId: string): Promise<Set<string>> {
    const rows = await db
      .select({ entityGuuid: mutationQueue.entityGuuid })
      .from(mutationQueue)
      .where(
        and(
          eq(mutationQueue.storeId, storeId),
          inArray(mutationQueue.status, ['pending', 'inflight', 'conflict']),
        ),
      );
    return new Set(rows.map((r) => r.entityGuuid));
  },

  /**
   * All queue rows for a record's client guuid (image-offline-architecture.md
   * P1-11). The image uploader reads this to answer "has this record's create
   * synced, or did it permanently fail?" — `entity_guuid` is globally unique, so
   * no entity-type filter is needed and the check stays polymorphic. The queue is
   * small (only undrained mutations), so an un-indexed scan is fine.
   */
  async findByEntityGuuid(
    db: SyncDb,
    entityGuuid: string,
  ): Promise<MutationQueueRow[]> {
    return db
      .select()
      .from(mutationQueue)
      .where(eq(mutationQueue.entityGuuid, entityGuuid));
  },

  async remove(db: SyncDb, mutationId: string): Promise<void> {
    await db
      .delete(mutationQueue)
      .where(eq(mutationQueue.mutationId, mutationId));
  },
};
