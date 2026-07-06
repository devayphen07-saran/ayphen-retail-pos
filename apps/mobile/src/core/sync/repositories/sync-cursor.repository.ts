import { eq } from 'drizzle-orm';
import { syncCursors } from '../db/schema';
import type { SyncDb } from '../db/types';

/**
 * The opaque per-store delta cursor (mobile-11 §13). `token` is the server's
 * HMAC-signed blob — read and written verbatim, never parsed. Nowhere in this
 * repository (or anywhere else) should a caller inspect its contents.
 */
export const syncCursorRepository = {
  async get(db: SyncDb, storeId: string): Promise<string | null> {
    const [row] = await db
      .select({ token: syncCursors.token })
      .from(syncCursors)
      .where(eq(syncCursors.storeId, storeId))
      .limit(1);
    return row?.token ?? null;
  },

  /** Upsert — called from inside the SAME transaction as the rows the cursor
   *  advances past (INV-9). Never call this outside that transaction. */
  async set(db: SyncDb, storeId: string, token: string, now: string): Promise<void> {
    await db
      .insert(syncCursors)
      .values({ storeId, token, updatedAt: now })
      .onConflictDoUpdate({
        target: syncCursors.storeId,
        set: { token, updatedAt: now },
      });
  },

  /** Store eviction / 410 SYNC_HORIZON_EXCEEDED recovery — drop the cursor so
   *  the next open cold-starts this store from scratch. */
  async clear(db: SyncDb, storeId: string): Promise<void> {
    await db.delete(syncCursors).where(eq(syncCursors.storeId, storeId));
  },
};
