import { and, eq, lt, sql } from 'drizzle-orm';
import { failedApplies } from '../db/schema';
import type { SyncDb } from '../db/types';

export type FailedApplyRow = typeof failedApplies.$inferSelect;
export type FailedApplyOperation = 'upsert' | 'delete';

/** Pull-side DLQ (mobile-10 §3) — a server row that couldn't apply locally
 *  (missing FK not yet synced, schema mismatch). Surfaced like the push DLQ
 *  rather than silently dropped, so a persistent apply failure is visible.
 *  Keyed uniquely by (store, entity, guuid): a row that keeps failing bumps
 *  `attempts` in place instead of spawning a duplicate every retry cycle. */
export const failedAppliesRepository = {
  async record(
    db: SyncDb,
    entry: {
      storeId: string;
      entityType: string;
      entityGuuid: string;
      operation: FailedApplyOperation;
      data: unknown;
      error: string;
      now: string;
    },
  ): Promise<void> {
    const data = JSON.stringify(entry.data);
    await db
      .insert(failedApplies)
      .values({
        storeId: entry.storeId,
        entityType: entry.entityType,
        entityGuuid: entry.entityGuuid,
        operation: entry.operation,
        data,
        attempts: 1,
        lastAttemptAt: entry.now,
        lastError: entry.error,
      })
      .onConflictDoUpdate({
        target: [failedApplies.storeId, failedApplies.entityType, failedApplies.entityGuuid],
        set: {
          // Refresh to the latest failing payload — a newer server version of
          // the same row is what we want to retry, not the stale first one.
          // `operation` also refreshes: an upsert-then-delete for the same
          // guuid across two pull pages must overwrite the stale upsert intent
          // with the newer delete, not retry the wrong operation forever.
          operation: entry.operation,
          data,
          attempts: sql`${failedApplies.attempts} + 1`,
          lastAttemptAt: entry.now,
          lastError: entry.error,
        },
      });
  },

  /** DLQ rows still worth retrying — under the poison cap. Ordering doesn't
   *  matter: each retries independently. `limit` bounds how many this ONE
   *  call returns — without it, a DLQ that's grown large gets fully re-queried
   *  and re-attempted every single cycle, forever; the caller processes at
   *  most `limit` per pass and lets the next cycle continue the rest. */
  async listRetryable(db: SyncDb, storeId: string, maxAttempts: number, limit: number): Promise<FailedApplyRow[]> {
    return db
      .select()
      .from(failedApplies)
      .where(and(eq(failedApplies.storeId, storeId), lt(failedApplies.attempts, maxAttempts)))
      .limit(limit);
  },

  async listByStore(db: SyncDb, storeId: string): Promise<FailedApplyRow[]> {
    return db.select().from(failedApplies).where(eq(failedApplies.storeId, storeId));
  },

  /** A retry attempt failed again — bump the counter and refresh the error so
   *  the poison cap eventually retires a permanently-broken row. */
  async recordAttempt(db: SyncDb, id: number, error: string, now: string): Promise<void> {
    await db
      .update(failedApplies)
      .set({ attempts: sql`${failedApplies.attempts} + 1`, lastAttemptAt: now, lastError: error })
      .where(eq(failedApplies.id, id));
  },

  /** Retry succeeded (or the user dismissed it) — drop the DLQ row. */
  async deleteById(db: SyncDb, id: number): Promise<void> {
    await db.delete(failedApplies).where(eq(failedApplies.id, id));
  },
};