import { appliersRegistry } from '../appliers/appliers.registry';
import { SYNC_ENTITY_PERMISSION } from '../appliers/permission-entity-map';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { syncInitProgressRepository } from '../repositories/sync-init-progress.repository';
import { syncStoreMetaRepository } from '../repositories/sync-store-meta.repository';
import type { SyncDb } from '../db/types';

/**
 * Re-cold-start a store whose `permissions_version` grew since it last synced,
 * and purge any locally-cached entity whose `view` grant was just REVOKED.
 *
 * GRANT direction: a cold start done while the user lacked `view` on an entity
 * still anchors that entity's delta watermark at cold-start time
 * (initial-sync.service.ts marks a no-view entity `completed` with an empty
 * page). Once the user is later GRANTED `view`, the delta path only
 * re-delivers rows modified AFTER the grant — every pre-existing row is older
 * than the watermark and would stay invisible forever (the cold-start
 * counterpart of the delta re-grant path, which is already handled
 * server-side by not advancing the watermark, S-5). Rather than track which
 * specific entities were withheld, we take the simple, always-correct route:
 * on a version INCREASE, wipe cold-start progress + the cursor so the next
 * open re-dumps everything under the new permission set. Permission changes
 * are rare, so the extra bandwidth is cheap insurance; local unpushed
 * mutations live in a separate queue and are untouched.
 *
 * REVOKE direction: the wipe-and-recold-start above does NOT delete rows
 * already cached locally — a re-cold-start only stops re-adding them, it
 * never removes what's there. Since this app is offline-first, local SQLite
 * IS the read boundary (no server round trip backstops a list render), so a
 * revoked `view` grant must actively purge the matching table or the data
 * stays fully readable on-device indefinitely. We diff the last-synced
 * permission set against the current one (SYNC_ENTITY_PERMISSION maps a sync
 * entity_type to its RBAC entity code) and delete every local row for any
 * entity that lost `${entity}:view`.
 *
 * Returns true iff a rebase was triggered. No-ops when: there is no cursor yet
 * (a fresh/uninitialised store cold-starts anyway), the current version is
 * unknown (snapshot not loaded), or no version was ever stamped (a store that
 * cold-started before this bookkeeping existed — can't retroactively detect a
 * past grant/revoke, but every future one is caught).
 */
export async function rebaseOnPermissionGrant(
  db: SyncDb,
  storeId: string,
  currentPermissionsVersion: number | null,
  currentPermissions: string[] | null,
): Promise<boolean> {
  if (currentPermissionsVersion == null) return false;

  const cursor = await syncCursorRepository.get(db, storeId);
  if (!cursor) return false; // no steady state yet — cold start will run regardless

  const storedVersion = await syncStoreMetaRepository.getPermissionsVersion(db, storeId);
  if (storedVersion == null || currentPermissionsVersion <= storedVersion) return false;

  const storedPermissions = await syncStoreMetaRepository.getPermissions(db, storeId);
  if (storedPermissions && currentPermissions) {
    const revokedEntityTypes = new Set(
      Object.entries(SYNC_ENTITY_PERMISSION)
        .filter(
          ([, entity]) =>
            storedPermissions.includes(`${entity}:view`) &&
            !currentPermissions.includes(`${entity}:view`),
        )
        .map(([syncEntityType]) => syncEntityType),
    );
    for (const syncEntityType of revokedEntityTypes) {
      await appliersRegistry.get(syncEntityType)?.deleteAllForStore(db, storeId);
    }
  }

  await syncInitProgressRepository.reset(db, storeId);
  await syncCursorRepository.clear(db, storeId);
  return true;
}
