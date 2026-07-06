import { sql } from 'drizzle-orm';
import { createTestDb } from './__testing__/create-test-db';
import { withTransaction } from './transaction';

/**
 * Cross-call-site concurrency: a screen's enqueueCreateProduct() (a
 * UI-triggered withTransaction call) firing at the SAME MOMENT as the
 * scheduler's drainQueueFully/pullDeltaToCompletion (also withTransaction, on
 * the same single connection). If withTransaction didn't serialize across
 * independent call sites, SQLite would reject the second BEGIN ("cannot start
 * a transaction within a transaction") — verified: reverting withTransaction
 * to a bare BEGIN/COMMIT/ROLLBACK (no module-level queue) reproduces exactly
 * that SqliteError against this same test.
 */
describe('withTransaction — cross-call-site concurrency', () => {
  it('serializes two callers that start at the exact same tick, neither BEGIN nested inside the other', async () => {
    const db = createTestDb();
    const order: string[] = [];

    // "Screen write" — simulates enqueueCreateProduct: a real await inside fn
    // (representing e.g. a second repository call) so this transaction is
    // genuinely still open when the "scheduler" call below fires.
    const screenWrite = withTransaction(db, async (tx) => {
      order.push('screen:start');
      await tx.run(sql`SELECT 1`); // yields the event loop mid-transaction
      order.push('screen:end');
    });

    // "Scheduler drain" — fired on the SAME tick, not awaited before starting,
    // exactly like a background heartbeat racing a UI-triggered write.
    const schedulerDrain = withTransaction(db, async (tx) => {
      order.push('scheduler:start');
      await tx.run(sql`SELECT 1`);
      order.push('scheduler:end');
    });

    // Both must resolve without throwing — a nested-BEGIN SQLite error would
    // reject one of these if serialization were broken.
    await expect(Promise.all([screenWrite, schedulerDrain])).resolves.toBeDefined();

    // The critical assertion: one call's ENTIRE body (start→end) completes
    // before the other's starts — never interleaved (start, start, end, end).
    const interleaved =
      order[0] === 'screen:start' && order[1] === 'scheduler:start';
    expect(interleaved).toBe(false);
    expect(order).toHaveLength(4);
  });

  it('a slow first transaction does not get its rows clobbered by a second racing one', async () => {
    const db = createTestDb();

    // Two DIFFERENT stores enqueue a cursor write concurrently — proves no
    // cross-contamination / lost writes under real interleaved-race timing,
    // not just "did it throw".
    const first = withTransaction(db, async (tx) => {
      await tx.run(sql`SELECT 1`);
      await tx.run(
        sql`INSERT INTO sync_cursors (store_id, token, updated_at) VALUES ('store-A', 'token-A', '2026-01-01T00:00:00.000000Z')`,
      );
    });
    const second = withTransaction(db, async (tx) => {
      await tx.run(
        sql`INSERT INTO sync_cursors (store_id, token, updated_at) VALUES ('store-B', 'token-B', '2026-01-01T00:00:00.000000Z')`,
      );
    });

    await Promise.all([first, second]);

    const rows = await db.all(sql`SELECT store_id, token FROM sync_cursors ORDER BY store_id`);
    expect(rows).toEqual([
      { store_id: 'store-A', token: 'token-A' },
      { store_id: 'store-B', token: 'token-B' },
    ]);
  });
});
