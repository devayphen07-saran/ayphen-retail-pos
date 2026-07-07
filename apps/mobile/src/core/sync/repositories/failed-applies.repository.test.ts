import { createTestDb } from '../db/__testing__/create-test-db';
import { failedAppliesRepository } from './failed-applies.repository';
import { lookupRepository } from './lookup.repository';
import { appliersRegistry } from '../appliers/appliers.registry';
import { retryFailedApplies } from '../engine/retry-failed-applies';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';

/** A valid `lookup` wire row — the retry path feeds this straight through the
 *  real lookup applier, so it must match what the server projects. */
function validLookup(guuid: string) {
  return {
    id: `lookup-${guuid}`,
    guuid,
    lookup_type_fk: 'BUSINESS_CATEGORY',
    code: 'RETAIL',
    label: 'Retail',
    row_version: 1,
    modified_at: '2026-01-01T00:00:00.000000Z',
  };
}

function record(
  db: ReturnType<typeof createTestDb>,
  over: Partial<Parameters<typeof failedAppliesRepository.record>[1]> = {},
) {
  return failedAppliesRepository.record(db, {
    storeId: 'store-A',
    entityType: 'lookup',
    entityGuuid: 'g-1',
    operation: 'upsert',
    data: validLookup('g-1'),
    error: 'missing FK',
    now: T0,
    ...over,
  });
}

describe('failedAppliesRepository — DLQ dedup (mobile-10 §3)', () => {
  it('bumps attempts in place instead of spawning a duplicate for the same (store, entity, guuid)', async () => {
    const db = createTestDb();
    await record(db, { error: 'first', now: T0 });
    await record(db, { error: 'second', now: T1 });

    const rows = await failedAppliesRepository.listByStore(db, 'store-A');
    expect(rows).toHaveLength(1); // one row, not two
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].lastError).toBe('second'); // refreshed to the latest failure
    expect(rows[0].lastAttemptAt).toBe(T1);
  });

  it('keeps distinct rows for different guuids', async () => {
    const db = createTestDb();
    await record(db, { entityGuuid: 'g-1', data: validLookup('g-1') });
    await record(db, { entityGuuid: 'g-2', data: validLookup('g-2') });

    expect(await failedAppliesRepository.listByStore(db, 'store-A')).toHaveLength(2);
  });
});

describe('retryFailedApplies — dependency backfill', () => {
  it('applies a previously-failed row and clears it from the DLQ once it succeeds', async () => {
    const db = createTestDb();
    await record(db, { entityGuuid: 'g-1', data: validLookup('g-1') });

    await retryFailedApplies(db, 'store-A', T1);

    // Row is gone from the DLQ and now present in the real table.
    expect(await failedAppliesRepository.listByStore(db, 'store-A')).toHaveLength(0);
    const applied = await lookupRepository.listByStore(db, 'store-A');
    expect(applied).toHaveLength(1);
    expect(applied[0].guuid).toBe('g-1');
  });

  it('keeps the row and bumps attempts when it still fails to apply', async () => {
    const db = createTestDb();
    await record(db, { entityGuuid: 'g-1', data: validLookup('g-1') });
    // Simulate the still-missing dependency: the applier rejects this pass.
    const spy = jest.spyOn(appliersRegistry, 'get').mockReturnValue({
      entityType: 'lookup',
      upsertAll: () => Promise.reject(new Error('missing FK parent not yet synced')),
      applyDeletes: () => Promise.resolve(),
    });

    try {
      await retryFailedApplies(db, 'store-A', T1);
    } finally {
      spy.mockRestore();
    }

    const [row] = await failedAppliesRepository.listByStore(db, 'store-A');
    expect(row).toBeDefined(); // still parked, not lost
    expect(row.attempts).toBe(2); // 1 from record + 1 from the failed retry
    expect(row.lastError).toBe('missing FK parent not yet synced');
    expect(row.lastAttemptAt).toBe(T1);
  });

  it('does not retry a poison row that has hit the cap', async () => {
    const db = createTestDb();
    await record(db, { entityGuuid: 'g-1', data: validLookup('g-1') });
    // Drive attempts up to the cap (7) — first record already set it to 1.
    for (let i = 0; i < 6; i++) {
      const [r] = await failedAppliesRepository.listByStore(db, 'store-A');
      await failedAppliesRepository.recordAttempt(db, r.id, 'still failing', T1);
    }

    await retryFailedApplies(db, 'store-A', T1);

    // Capped → skipped: nothing applied, row still parked in the DLQ.
    expect(await lookupRepository.listByStore(db, 'store-A')).toHaveLength(0);
    expect(await failedAppliesRepository.listByStore(db, 'store-A')).toHaveLength(1);
  });

  it('retries a failed DELETE as a delete, not an upsert of its {guuid} placeholder', async () => {
    const db = createTestDb();
    // Seed the row as if it had synced successfully before the tombstone
    // failed to apply (e.g. a transient DB error inside deleteWithIsolation).
    await appliersRegistry.get('lookup')!.upsertAll(db, 'store-A', [validLookup('g-1')]);
    await record(db, { entityGuuid: 'g-1', operation: 'delete', data: { guuid: 'g-1' } });

    await retryFailedApplies(db, 'store-A', T1);

    // The row is gone (deleted), not left behind or overwritten with a
    // near-empty `{ guuid }` upsert — the pre-fix bug this guards against.
    expect(await lookupRepository.listByStore(db, 'store-A')).toHaveLength(0);
    expect(await failedAppliesRepository.listByStore(db, 'store-A')).toHaveLength(0);
  });

  it('keeps a failed DELETE parked (bumps attempts) when the delete still fails', async () => {
    const db = createTestDb();
    await record(db, { entityGuuid: 'g-1', operation: 'delete', data: { guuid: 'g-1' } });
    const spy = jest.spyOn(appliersRegistry, 'get').mockReturnValue({
      entityType: 'lookup',
      upsertAll: () => Promise.reject(new Error('should never be called for a delete')),
      applyDeletes: () => Promise.reject(new Error('still broken')),
    });

    try {
      await retryFailedApplies(db, 'store-A', T1);
    } finally {
      spy.mockRestore();
    }

    const [row] = await failedAppliesRepository.listByStore(db, 'store-A');
    expect(row).toBeDefined();
    expect(row.operation).toBe('delete');
    expect(row.lastError).toBe('still broken'); // proves applyDeletes (not upsertAll) was called
    expect(row.attempts).toBe(2);
  });
});