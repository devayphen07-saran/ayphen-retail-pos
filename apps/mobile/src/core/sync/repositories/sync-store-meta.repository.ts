import { eq } from 'drizzle-orm';
import { syncStoreMeta } from '../db/schema';
import type { SyncDb } from '../db/types';

/** Client-only per-store bookkeeping outside the opaque delta cursor — see the
 *  `syncStoreMeta` table comment. Currently just the last-synced
 *  `permissions_version`, used to detect a permission grant across opens. */
export const syncStoreMetaRepository = {
  async getPermissionsVersion(db: SyncDb, storeId: string): Promise<number | null> {
    const [row] = await db
      .select({ permissionsVersion: syncStoreMeta.permissionsVersion })
      .from(syncStoreMeta)
      .where(eq(syncStoreMeta.storeId, storeId))
      .limit(1);
    return row?.permissionsVersion ?? null;
  },

  async setPermissionsVersion(
    db: SyncDb,
    storeId: string,
    permissionsVersion: number,
    now: string,
  ): Promise<void> {
    await db
      .insert(syncStoreMeta)
      .values({ storeId, permissionsVersion, updatedAt: now })
      .onConflictDoUpdate({
        target: syncStoreMeta.storeId,
        set: { permissionsVersion, updatedAt: now },
      });
  },
};
