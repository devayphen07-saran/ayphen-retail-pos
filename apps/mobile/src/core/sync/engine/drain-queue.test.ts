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
// Relative to the real clock so queued mutations stay within the client's
// idempotency-replay window (C2) — a hardcoded past date would be dead-lettered
// as too-old-to-replay once the wall clock moved >45 d past it.
const NOW = new Date().toISOString();

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

  it('restores the pre-image when the server rejects an update (C5 — no lost prior state)', async () => {
    const db = createTestDb();
    // The row already exists with its committed state (row_version 3).
    const priorRow = { ...optimisticProductRow('g-1'), name: 'Original', row_version: 3 };
    await appliersRegistry.get('product')!.upsertAll(db, 'store-A', [priorRow]);

    // An optimistic update changed the local name, capturing the prior row as
    // the pre-image, and queued the update.
    await appliersRegistry
      .get('product')!
      .upsertAll(db, 'store-A', [{ ...priorRow, name: 'Optimistic Edit' }]);
    await mutationQueueRepository.enqueue(
      db,
      createEntry({
        action: 'update',
        expectedRowVersion: 3,
        payload: { guuid: 'g-1', name: 'Optimistic Edit' },
        preImage: priorRow,
      }),
    );

    mockPush.mockResolvedValueOnce({
      mutation_results: [{ mutation_id: 'm-1', status: 'rejected', code: 'VALIDATION_FAILED', message: 'bad' }],
      changes: {},
      sync_cursor: null,
      has_more: false,
      server_time: NOW,
      permissions_version: 1,
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    const [restored] = await db.select().from(products);
    expect(restored.name).toBe('Original'); // pre-image restored, not left as 'Optimistic Edit'
    expect(restored.rowVersion).toBe(3);
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

  it('applies a just-pushed row echoed back in the same response (C6 — self-echo not shadowed)', async () => {
    const db = createTestDb();
    await seedOptimisticCreate(db);
    // Server accepted the create and assigned a real id, and the piggybacked
    // delta page in the SAME response echoes that authoritative row back.
    const authoritative = { ...optimisticProductRow('g-1'), id: 'server-id-1', name: 'Widget (server)' };
    mockPush.mockResolvedValueOnce({
      mutation_results: [{ mutation_id: 'm-1', status: 'applied', data: authoritative }],
      changes: { product: { upserts: [authoritative], deletes: [] } },
      sync_cursor: 'cur-1',
      has_more: false,
      server_time: NOW,
      permissions_version: 1,
    } as unknown as Awaited<ReturnType<typeof pushDelta>>);

    await drainMutationQueueOnce(db, 'store-A');

    // The mutation is 'applied' (no longer a live queue row), so the echoed row
    // is NOT shadowed by B1 — it lands as the authoritative server row, exactly
    // once (no phantom temp row, no duplicate from the echo).
    const rows = await db.select().from(products);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('server-id-1');
    expect(rows[0].name).toBe('Widget (server)');
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
