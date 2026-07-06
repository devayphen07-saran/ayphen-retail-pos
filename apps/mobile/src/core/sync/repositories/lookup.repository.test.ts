import { createTestDb } from '../db/__testing__/create-test-db';
import { lookupRepository } from './lookup.repository';

/**
 * A global lookup row (server `store_fk` NULL) is pulled once per store but
 * shares the SAME server `id` regardless of which store requested it. Before
 * `lookups` had a composite (storeId, id) primary key, upserting that row
 * under a second store would overwrite the first store's local `storeId`
 * stamp on the SAME row (onConflictDoUpdate targeted `id` alone) — a
 * multi-store owner switching stores on one device would see a global lookup
 * silently vanish from whichever store synced it first. This proves the
 * composite key keeps each store's local copy independent.
 */
describe('lookupRepository — composite (storeId, id) PK', () => {
  it("does not let store B's sync clobber store A's local copy of the same global lookup id", async () => {
    const db = createTestDb();
    const globalRow = {
      id: 'lookup-global-1',
      guuid: 'guuid-1',
      lookup_type_fk: 'BUSINESS_CATEGORY',
      code: 'RETAIL',
      label: 'Retail',
      row_version: 1,
      modified_at: '2026-01-01T00:00:00.000000Z',
    };

    await lookupRepository.upsertAll(db, 'store-A', [globalRow]);
    await lookupRepository.upsertAll(db, 'store-B', [globalRow]);

    const forA = await lookupRepository.listByStore(db, 'store-A');
    const forB = await lookupRepository.listByStore(db, 'store-B');

    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0].storeId).toBe('store-A');
    expect(forB[0].storeId).toBe('store-B');
  });
});
