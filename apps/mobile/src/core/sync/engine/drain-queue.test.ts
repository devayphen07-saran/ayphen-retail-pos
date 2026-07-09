jest.mock('../transport/sync-transport', () => ({ pushDelta: jest.fn() }));

import { createTestDb } from '../db/__testing__/create-test-db';
import { drainMutationQueueOnce } from './drain-queue';
import { pushDelta } from '../transport/sync-transport';
import { appliersRegistry } from '../appliers/appliers.registry';
import { mutationQueueRepository, type EnqueueInput } from '../repositories/mutation-queue.repository';
import { products } from '../db/schema';
import { useAuthStore } from '@store';
import type { SyncDb } from '../db/types';

const mockPush = pushDelta as jest.MockedFunction<typeof pushDelta>;
const NOW = '2026-01-01T00:00:00.000Z';

function createEntry(over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    mutationId: 'm-1',
    storeId: 'store-A',
    entityType: 'product',
    entityGuuid: 'g-1',
    action: 'create',
    payload: { guuid: 'g-1', name: 'Widget', selling_price: '10.00' },
    clientModifiedAt: NOW,
    now: NOW,
    ...over,
  };
}

function optimisticProductRow(guuid: string) {
  return {
    id: guuid, // create optimistically uses guuid as the temp id
    guuid,
    name: 'Widget',
    sku: null,
    barcode: null,
    category_lookup_fk: null,
    unit_fk: null,
    taxrate_fk: null,
    selling_price: '10.00',
    cost_price: null,
    mrp: null,
    hsn_code: null,
    track_inventory: null,
    is_active: true,
    row_version: 0,
    modified_at: NOW,
  };
}

async function seedOptimisticCreate(db: SyncDb) {
  await appliersRegistry.get('product')!.upsertAll(db, 'store-A', [optimisticProductRow('g-1')]);
  await mutationQueueRepository.enqueue(db, createEntry());
}

beforeEach(() => mockPush.mockReset());

describe('drainMutationQueueOnce — failure paths (P0)', () => {
  it('re-pends the in-flight batch (and rethrows) when pushDelta throws — no stranded writes', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    mockPush.mockRejectedValueOnce(new Error('Network Error'));

    await expect(drainMutationQueueOnce(db, 'store-A')).rejects.toThrow('Network Error');

    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.status).toBe('pending'); // re-drainable next tick, not stranded 'inflight'
    // A transport failure (this isn't a recognizable axios rejection — the
    // safe default) must NOT bump attempts: an extended offline period alone
    // must never age this mutation toward 'dead'.
    expect(row.attempts).toBe(0);

    // The optimistic product row is untouched — a transient failure is not a rejection.
    expect(await db.select().from(products)).toHaveLength(1);
  });

  it('never dead-letters a mutation across repeated transport failures alone', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    mockPush.mockRejectedValue(new Error('Network Error'));

    for (let i = 0; i < 10; i++) {
      await expect(drainMutationQueueOnce(db, 'store-A')).rejects.toThrow('Network Error');
    }

    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.status).toBe('pending'); // still re-drainable, not 'dead'
    expect(row.attempts).toBe(0);
  });

  it('rolls back the optimistic create when the server rejects it (no phantom row)', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    mockPush.mockResolvedValueOnce({
      mutation_results: [{ mutation_id: 'm-1', status: 'rejected', code: 'DUPLICATE_ENTRY', message: 'dup' }],
      changes: {},
      sync_cursor: null,
      has_more: false,
      server_time: NOW,
      permissions_version: 1,
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    expect(await db.select().from(products)).toHaveLength(0); // phantom row reverted
    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.status).toBe('rejected');
  });

  it('re-pends a mutation the server returned no result for', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    mockPush.mockResolvedValueOnce({
      mutation_results: [], // server dropped/truncated the result for m-1
      changes: {},
      sync_cursor: null,
      has_more: false,
      server_time: NOW,
      permissions_version: 1,
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.status).toBe('pending'); // not stranded in 'inflight'
    expect(row.attempts).toBe(1);
  });
});

describe('drainMutationQueueOnce — snapshot refresh on push (freshness)', () => {
  beforeEach(() => {
    useAuthStore.setState({ snapshot: null, snapshotSignature: null });
  });

  it('applies the snapshot the server piggybacks on a push response', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    const snapshot = {
      userId: 'u-1',
      permissionsVersion: 2,
      generatedAt: NOW,
      stores: [{ store_id: 'store-A', name: 'Main', permissions: ['Product:create'] }],
    };
    mockPush.mockResolvedValueOnce({
      mutation_results: [{ mutation_id: 'm-1', status: 'applied', data: optimisticProductRow('g-1') }],
      changes: {},
      sync_cursor: null,
      has_more: false,
      server_time: NOW,
      permissions_version: 2,
      snapshot,
      snapshot_signature: 'sig-1',
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    expect(useAuthStore.getState().snapshot).toEqual(snapshot);
    expect(useAuthStore.getState().snapshotSignature).toBe('sig-1');
  });

  it('does not touch the stored snapshot when the push response carries none', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    mockPush.mockResolvedValueOnce({
      mutation_results: [{ mutation_id: 'm-1', status: 'applied', data: optimisticProductRow('g-1') }],
      changes: {},
      sync_cursor: null,
      has_more: false,
      server_time: NOW,
      permissions_version: 1,
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    expect(useAuthStore.getState().snapshot).toBeNull();
  });
});
