import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { syncInitProgressRepository } from '../repositories/sync-init-progress.repository';
import { syncStoreMetaRepository } from '../repositories/sync-store-meta.repository';
import type { SyncDb } from '../db/types';

/**
 * Re-cold-start a store whose `permissions_version` grew since it last synced.
 *
 * A cold start done while the user lacked `view` on an entity still anchors
 * that entity's delta watermark at cold-start time (initial-sync.service.ts
 * marks a no-view entity `completed` with an empty page). Once the user is
 * later GRANTED `view`, the delta path only re-delivers rows modified AFTER the
 * grant — every pre-existing row is older than the watermark and would stay
 * invisible forever (the cold-start counterpart of the delta re-grant path,
 * which is already handled server-side by not advancing the watermark, S-5).
 *
 * Rather than track which specific entities were withheld, we take the simple,
 * always-correct route: on a version INCREASE, wipe cold-start progress + the
 * cursor so the next open re-dumps everything under the new permission set.
 * Permission changes are rare, so the extra bandwidth is cheap insurance; local
 * unpushed mutations live in a separate queue and are untouched.
 *
 * Returns true iff a rebase was triggered. No-ops when: there is no cursor yet
 * (a fresh/uninitialised store cold-starts anyway), the current version is
 * unknown (snapshot not loaded), or no version was ever stamped (a store that
 * cold-started before this bookkeeping existed — can't retroactively detect a
 * past grant, but every future one is caught).
 */
export async function rebaseOnPermissionGrant(
  db: SyncDb,
  storeId: string,
  currentPermissionsVersion: number | null,
): Promise<boolean> {
  if (currentPermissionsVersion == null) return false;

  const cursor = await syncCursorRepository.get(db, storeId);
  if (!cursor) return false; // no steady state yet — cold start will run regardless

  const storedVersion = await syncStoreMetaRepository.getPermissionsVersion(db, storeId);
  if (storedVersion == null || currentPermissionsVersion <= storedVersion) return false;

  await syncInitProgressRepository.reset(db, storeId);
  await syncCursorRepository.clear(db, storeId);
  return true;
}
