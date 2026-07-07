import { createTestDb } from '../db/__testing__/create-test-db';
import { rebaseOnPermissionGrant } from './permission-rebase';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { syncInitProgressRepository } from '../repositories/sync-init-progress.repository';
import { syncStoreMetaRepository } from '../repositories/sync-store-meta.repository';

const NOW = '2026-01-01T00:00:00.000Z';
const STORE = 'store-A';

async function seedSyncedStore(
  db: ReturnType<typeof createTestDb>,
  permissionsVersion: number,
) {
  await syncCursorRepository.set(db, STORE, 'cursor-token', NOW);
  await syncInitProgressRepository.savePage(db, STORE, 'product', null, 'completed', NOW);
  await syncStoreMetaRepository.setPermissionsVersion(db, STORE, permissionsVersion, NOW);
}

describe('rebaseOnPermissionGrant — cold-start permission backfill (S-5)', () => {
  it('wipes cursor + progress when permissions_version has increased', async () => {
    const db = createTestDb();
    await seedSyncedStore(db, 5);

    const rebased = await rebaseOnPermissionGrant(db, STORE, 6);

    expect(rebased).toBe(true);
    expect(await syncCursorRepository.get(db, STORE)).toBeNull(); // next open cold-starts
    expect(await syncInitProgressRepository.listFor(db, STORE)).toHaveLength(0);
  });

  it('does nothing when the version is unchanged', async () => {
    const db = createTestDb();
    await seedSyncedStore(db, 5);

    const rebased = await rebaseOnPermissionGrant(db, STORE, 5);

    expect(rebased).toBe(false);
    expect(await syncCursorRepository.get(db, STORE)).toBe('cursor-token');
    expect(await syncInitProgressRepository.listFor(db, STORE)).toHaveLength(1);
  });

  it('does not rebase on a version DECREASE (a revoke is handled by the delta path)', async () => {
    const db = createTestDb();
    await seedSyncedStore(db, 5);

    expect(await rebaseOnPermissionGrant(db, STORE, 4)).toBe(false);
    expect(await syncCursorRepository.get(db, STORE)).toBe('cursor-token');
  });

  it('no-ops when there is no cursor yet (a fresh store cold-starts anyway)', async () => {
    const db = createTestDb();
    await syncStoreMetaRepository.setPermissionsVersion(db, STORE, 5, NOW);

    expect(await rebaseOnPermissionGrant(db, STORE, 6)).toBe(false);
  });

  it('no-ops when no version was ever stamped (store pre-dates this bookkeeping)', async () => {
    const db = createTestDb();
    await syncCursorRepository.set(db, STORE, 'cursor-token', NOW);
    await syncInitProgressRepository.savePage(db, STORE, 'product', null, 'completed', NOW);

    expect(await rebaseOnPermissionGrant(db, STORE, 6)).toBe(false);
    expect(await syncCursorRepository.get(db, STORE)).toBe('cursor-token'); // untouched
  });

  it('no-ops when the current version is unknown (snapshot not loaded)', async () => {
    const db = createTestDb();
    await seedSyncedStore(db, 5);

    expect(await rebaseOnPermissionGrant(db, STORE, null)).toBe(false);
    expect(await syncCursorRepository.get(db, STORE)).toBe('cursor-token');
  });
});