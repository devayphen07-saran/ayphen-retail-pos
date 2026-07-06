import { and, eq } from 'drizzle-orm';
import { syncInitProgress } from '../db/schema';
import type { SyncDb } from '../db/types';

export type InitProgressPhase = 'in_progress' | 'completed';
export type InitProgressRow = typeof syncInitProgress.$inferSelect;

/** Cold-start resume position per (store, entity) — mirrors the server's own
 *  sync_init_progress table 1:1 so a crash mid-cold-start resumes exactly
 *  where the server's page_cursor left off. */
export const syncInitProgressRepository = {
  async listFor(db: SyncDb, storeId: string): Promise<InitProgressRow[]> {
    return db.select().from(syncInitProgress).where(eq(syncInitProgress.storeId, storeId));
  },

  async get(db: SyncDb, storeId: string, entityType: string): Promise<InitProgressRow | null> {
    const [row] = await db
      .select()
      .from(syncInitProgress)
      .where(and(eq(syncInitProgress.storeId, storeId), eq(syncInitProgress.entityType, entityType)))
      .limit(1);
    return row ?? null;
  },

  /** Upsert — commits in the SAME transaction as the page's applied rows
   *  (same INV-9 rule as the delta cursor: progress persists only alongside
   *  the rows it claims are in). */
  async savePage(
    db: SyncDb,
    storeId: string,
    entityType: string,
    cursor: string | null,
    phase: InitProgressPhase,
    now: string,
  ): Promise<void> {
    await db
      .insert(syncInitProgress)
      .values({ storeId, entityType, cursor, phase, updatedAt: now })
      .onConflictDoUpdate({
        target: [syncInitProgress.storeId, syncInitProgress.entityType],
        set: { cursor, phase, updatedAt: now },
      });
  },

  /** `reset=true` path — local wipe, cold-start this store from scratch. */
  async reset(db: SyncDb, storeId: string): Promise<void> {
    await db.delete(syncInitProgress).where(eq(syncInitProgress.storeId, storeId));
  },
};
