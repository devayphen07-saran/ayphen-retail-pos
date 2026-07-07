import { createTestDb } from '../db/__testing__/create-test-db';
import { mutationQueueRepository, type EnqueueInput } from './mutation-queue.repository';

function entry(over: Partial<EnqueueInput> = {}): EnqueueInput {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    mutationId: 'm-1',
    storeId: 'store-A',
    entityType: 'product',
    entityGuuid: 'g-1',
    action: 'create',
    payload: { guuid: 'g-1', name: 'Widget' },
    clientModifiedAt: now,
    now,
    ...over,
  };
}

describe('mutationQueueRepository — failure recovery (P0: stranded-write loss)', () => {
  it('recordTransportFailureBatch resets in-flight rows to pending WITHOUT bumping attempts', async () => {
    const db = createTestDb();
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-1', entityGuuid: 'g-1' }));
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-2', entityGuuid: 'g-2' }));
    await mutationQueueRepository.markInflight(db, ['m-1', 'm-2']);

    await mutationQueueRepository.recordTransportFailureBatch(
      db,
      ['m-1', 'm-2'],
      'offline',
      '2026-01-01T00:01:00.000Z',
    );

    const rows = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('pending'); // re-drainable, not stranded in 'inflight'
      // A connectivity/transport failure must never age a mutation toward
      // 'dead' — only a genuine poison rejection does that (see below).
      expect(r.attempts).toBe(0);
      expect(r.lastFailureAt).toBe('2026-01-01T00:01:00.000Z');
    }
  });

  it('never dead-letters a row across unlimited transport failures alone', async () => {
    const db = createTestDb();
    await mutationQueueRepository.enqueue(db, entry());

    for (let i = 1; i <= 20; i++) {
      await mutationQueueRepository.recordTransportFailureBatch(
        db,
        ['m-1'],
        'offline',
        `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      );
    }

    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.attempts).toBe(0);
    expect(row.status).toBe('pending'); // an extended offline period is not a poison signal
  });

  it('recordPoisonFailureBatch resets in-flight rows to pending and bumps attempts once', async () => {
    const db = createTestDb();
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-1', entityGuuid: 'g-1' }));
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-2', entityGuuid: 'g-2' }));
    await mutationQueueRepository.markInflight(db, ['m-1', 'm-2']);

    await mutationQueueRepository.recordPoisonFailureBatch(
      db,
      ['m-1', 'm-2'],
      'rejected: bad payload',
      '2026-01-01T00:01:00.000Z',
    );

    const rows = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('pending'); // re-drainable, not stranded in 'inflight'
      expect(r.attempts).toBe(1);
      expect(r.firstFailureAt).toBe('2026-01-01T00:01:00.000Z');
      expect(r.lastFailureAt).toBe('2026-01-01T00:01:00.000Z');
    }
  });

  it('dead-letters a poison row after MAX_ATTEMPTS_BEFORE_DEAD (7) poison failures', async () => {
    const db = createTestDb();
    await mutationQueueRepository.enqueue(db, entry());

    for (let i = 1; i <= 7; i++) {
      await mutationQueueRepository.recordPoisonFailureBatch(
        db,
        ['m-1'],
        'err',
        `2026-01-01T00:0${i}:00.000Z`,
      );
    }

    const [row] = await mutationQueueRepository.listByStore(db, 'store-A');
    expect(row.attempts).toBe(7);
    expect(row.status).toBe('dead'); // one poison mutation can't block the queue forever
  });

  it('resetOrphanedInflight re-pends only the target store’s inflight rows', async () => {
    const db = createTestDb();
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-A', storeId: 'store-A' }));
    await mutationQueueRepository.enqueue(db, entry({ mutationId: 'm-B', storeId: 'store-B' }));
    await mutationQueueRepository.markInflight(db, ['m-A', 'm-B']);

    await mutationQueueRepository.resetOrphanedInflight(db, 'store-A');

    const [a] = await mutationQueueRepository.listByStore(db, 'store-A');
    const [b] = await mutationQueueRepository.listByStore(db, 'store-B');
    expect(a.status).toBe('pending'); // crash-orphaned row recovered
    expect(b.status).toBe('inflight'); // other store untouched
    expect(a.attempts).toBe(0); // a crash is not a mutation-attempt failure
  });
});
