import { createTestDb } from '../db/__testing__/create-test-db';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { failedAppliesRepository } from '../repositories/failed-applies.repository';
import { applyChangesPage, type ApplierLookup } from './apply-changes';
import type { SyncDb } from '../db/types';
import type { EntityChanges } from '../transport/sync-wire-types';

/**
 * INV-9: the cursor advances only after the rows commit, in the SAME
 * transaction. This runs against a REAL SQLite engine (better-sqlite3, in
 * memory) — not a mock — so it actually proves rollback behavior, not just
 * that the code calls the right functions in the right order.
 */
describe('applyChangesPage — cursor-commit-ordering invariant (INV-9)', () => {
  const storeId = 'store-1';
  const noopApplier = { entityType: 'noop', upsertAll: async () => undefined, applyDeletes: async () => undefined };

  function registryWith(applier: { entityType: string; upsertAll: (db: SyncDb, storeId: string, rows: unknown[]) => Promise<void>; applyDeletes: (db: SyncDb, guuids: string[]) => Promise<void> }): ApplierLookup {
    return {
      get: (entityType) => (entityType === applier.entityType ? applier : undefined),
      entityTypes: () => [applier.entityType],
    };
  }

  it('advances the cursor when every applier succeeds', async () => {
    const db = createTestDb();
    const changes: Record<string, EntityChanges> = {
      widget: { upserts: [{ id: '1' }], deletes: [] },
    };

    await applyChangesPage(db, storeId, changes, 'cursor-token-v2', '2026-01-01T00:00:00.000000Z', registryWith(noopApplier));

    expect(await syncCursorRepository.get(db, storeId)).toBe('cursor-token-v2');
  });

  it('isolates a poison row to the DLQ instead of blocking the whole page', async () => {
    const db = createTestDb();
    await syncCursorRepository.set(db, storeId, 'cursor-token-v1', '2026-01-01T00:00:00.000000Z');

    const applied: { id: string }[] = [];
    // Fails whenever the poison row ('2') is PRESENT in the call — same as a
    // real NOT NULL/type-constraint violation, which fails the statement
    // regardless of how many other rows are in the same batch. This is what
    // makes the batch call fail, and then makes the '2'-only retry fail too;
    // '1' and '3' each succeed once isolated into their own single-row calls.
    const flakyApplier = {
      entityType: 'widget',
      upsertAll: async (_db: SyncDb, _storeId: string, rows: unknown[]) => {
        const batch = rows as { id: string }[];
        if (batch.some((row) => row.id === '2')) {
          throw new Error('simulated poison row');
        }
        applied.push(...batch);
      },
      applyDeletes: async () => undefined,
    };

    const changes: Record<string, EntityChanges> = {
      widget: { upserts: [{ id: '1' }, { id: '2' }, { id: '3' }], deletes: [] },
    };

    // The page as a whole succeeds — a poison row is isolated, not fatal.
    await applyChangesPage(
      db,
      storeId,
      changes,
      'cursor-token-v2',
      '2026-01-02T00:00:00.000000Z',
      registryWith(flakyApplier),
    );

    // '1' and '3' applied; '2' did not — isolation, not silent loss.
    expect(applied).toEqual([{ id: '1' }, { id: '3' }]);

    // The page committed, so the cursor advances — re-fetching the exact same
    // poison row forever (the alternative) would wedge this store's sync on
    // one bad row permanently instead of just losing that row's visibility.
    expect(await syncCursorRepository.get(db, storeId)).toBe('cursor-token-v2');

    // The poison row is recorded, not silently dropped (mobile-10 §3 DLQ).
    const failed = await failedAppliesRepository.listByStore(db, storeId);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      entityType: 'widget',
      entityGuuid: '2',
      lastError: 'simulated poison row',
    });
  });

  it('does NOT advance the cursor when the cursor write itself is what fails', async () => {
    // upsertWithIsolation only isolates failures INSIDE an applier call — a
    // failure from somewhere else in the same transaction (here, the cursor
    // write itself) must still roll back everything. "Commit rows, then
    // commit cursor" as two separate steps (even inside one function) is only
    // safe if they're the same DB transaction.
    const db = createTestDb();
    await syncCursorRepository.set(db, storeId, 'cursor-token-v1', '2026-01-01T00:00:00.000000Z');

    let upsertCalls = 0;
    const countingApplier = {
      entityType: 'widget',
      upsertAll: async () => {
        upsertCalls += 1;
      },
      applyDeletes: async () => undefined,
    };

    const changes: Record<string, EntityChanges> = {
      widget: { upserts: [{ id: '1' }], deletes: [] },
    };

    // An invalid cursor token (undefined coerced to a NOT NULL column) is a
    // convenient way to force the final statement in the transaction to fail.
    await expect(
      applyChangesPage(
        db,
        storeId,
        changes,
        // @ts-expect-error — deliberately invalid to force a NOT NULL violation
        null,
        '2026-01-02T00:00:00.000000Z',
        registryWith(countingApplier),
      ),
    ).rejects.toThrow();

    expect(upsertCalls).toBe(1); // the applier DID run...
    expect(await syncCursorRepository.get(db, storeId)).toBe('cursor-token-v1'); // ...but its effect was rolled back
  });
});
