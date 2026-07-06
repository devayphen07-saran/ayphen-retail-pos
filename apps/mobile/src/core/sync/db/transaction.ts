import { sql } from 'drizzle-orm';
import type { SyncDb } from './types';

/**
 * Manual BEGIN/COMMIT/ROLLBACK — deliberately NOT Drizzle's `db.transaction()`.
 *
 * Both sync SQLite drivers this app uses (better-sqlite3 in tests,
 * expo-sqlite on device — both `BaseSQLiteDatabase<'sync', ...>`) reject a
 * transaction callback that returns a Promise at RUNTIME:
 * better-sqlite3/lib/methods/transaction.js throws
 * `TypeError('Transaction function cannot return a promise')` the moment the
 * callback resolves to a thenable. Drizzle's `db.transaction()` passes the
 * callback straight through to that native wrapper, so
 * `db.transaction(async (tx) => ...)` crashes the process — even though it
 * typechecks cleanly, because TypeScript's `void`-returning-callback rule
 * silently accepts an async function there (a well-known TS gotcha).
 *
 * Every repository in this module is async by design (so an eventual
 * async-kind driver — libsql/turso — needs no rewrite), so instead of forcing
 * transaction bodies to be synchronous, we sequence the SQL ourselves.
 * Correctness holds because both drivers are single-connection/single-writer —
 * but ONLY if this module itself never lets two BEGIN/COMMIT pairs interleave.
 * `fn` is async and typically awaits I/O (network for push, other DB calls),
 * which yields the JS event loop — a second, unrelated `withTransaction` call
 * (a background push overlapping a foreground pull, say) could otherwise start
 * its own BEGIN before this one COMMITs. The module-level queue below serializes
 * every call through this function so that never happens, regardless of how
 * many independent call sites invoke it concurrently.
 */

/** Tail of the serialization queue — always a settled (never-rejecting)
 *  promise, so one transaction's failure can never wedge every later caller. */
let tail: Promise<void> = Promise.resolve();

export function withTransaction<T>(db: SyncDb, fn: (tx: SyncDb) => Promise<T>): Promise<T> {
  const result = tail.then(() => runTransaction(db, fn));
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function runTransaction<T>(db: SyncDb, fn: (tx: SyncDb) => Promise<T>): Promise<T> {
  await db.run(sql`BEGIN`);
  try {
    const result = await fn(db);
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch {
      // Best-effort — if ROLLBACK itself fails, the connection is already
      // broken; surface the ORIGINAL error, not this secondary one.
    }
    throw err;
  }
}
