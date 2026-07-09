import { eq } from 'drizzle-orm';
import { syncStoreMeta } from '../db/schema';
import type { SyncDb } from '../db/types';

/** Client-only per-store bookkeeping outside the opaque delta cursor — see the
 *  `syncStoreMeta` table comment. Tracks the last-synced `permissions_version`
 *  (detects ANY permission change across opens) and the last-synced
 *  `entity:action` grant set (lets permission-rebase.ts tell a GRANT apart
 *  from a REVOKE, not just "something changed"). */
export const syncStoreMetaRepository = {
  async getPermissionsVersion(db: SyncDb, storeId: string): Promise<number | null> {
    const [row] = await db
      .select({ permissionsVersion: syncStoreMeta.permissionsVersion })
      .from(syncStoreMeta)
      .where(eq(syncStoreMeta.storeId, storeId))
      .limit(1);
    return row?.permissionsVersion ?? null;
  },

  async getPermissions(db: SyncDb, storeId: string): Promise<string[] | null> {
    const [row] = await db
      .select({ permissions: syncStoreMeta.permissions })
      .from(syncStoreMeta)
      .where(eq(syncStoreMeta.storeId, storeId))
      .limit(1);
    if (!row?.permissions) return null;
    try {
      return JSON.parse(row.permissions) as string[];
    } catch {
      return null;
    }
  },

  async setPermissionsVersion(
    db: SyncDb,
    storeId: string,
    permissionsVersion: number,
    permissions: string[],
    now: string,
  ): Promise<void> {
    const encoded = JSON.stringify(permissions);
    await db
      .insert(syncStoreMeta)
      .values({ storeId, permissionsVersion, permissions: encoded, updatedAt: now })
      .onConflictDoUpdate({
        target: syncStoreMeta.storeId,
        set: { permissionsVersion, permissions: encoded, updatedAt: now },
      });
  },
};
