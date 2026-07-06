import { eq } from 'drizzle-orm';
import { failedApplies } from '../db/schema';
import type { SyncDb } from '../db/types';

export type FailedApplyRow = typeof failedApplies.$inferSelect;

/** Pull-side DLQ (mobile-10 §3) — a server row that couldn't apply locally
 *  (missing FK not yet synced, schema mismatch). Surfaced like the push DLQ
 *  rather than silently dropped, so a persistent apply failure is visible. */
export const failedAppliesRepository = {
  async record(
    db: SyncDb,
    entry: { storeId: string; entityType: string; entityGuuid: string; data: unknown; error: string; now: string },
  ): Promise<void> {
    await db.insert(failedApplies).values({
      storeId: entry.storeId,
      entityType: entry.entityType,
      entityGuuid: entry.entityGuuid,
      data: JSON.stringify(entry.data),
      attempts: 1,
      lastAttemptAt: entry.now,
      lastError: entry.error,
    });
  },

  async listByStore(db: SyncDb, storeId: string): Promise<FailedApplyRow[]> {
    return db.select().from(failedApplies).where(eq(failedApplies.storeId, storeId));
  },
};
