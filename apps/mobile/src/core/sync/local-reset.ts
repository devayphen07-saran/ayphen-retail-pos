import { inArray } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as FileSystem from 'expo-file-system/legacy';
import { getSyncDb, runMigrations } from './db/client';
import { withTransaction } from './db/transaction';
import { drainMutationQueueOnce } from './engine/drain-queue';
import {
  stores,
  units,
  taxRates,
  lookups,
  paymentMethods,
  paymentAccounts,
  products,
  productCases,
  customers,
  suppliers,
  syncCursors,
  syncInitProgress,
  mutationQueue,
  failedApplies,
  schemaMeta,
  syncStoreMeta,
  attachment,
} from './db/schema';
import { logger } from '../../utils/logger';

/**
 * Every local sync table. The set must stay COMPLETE — a table omitted here
 * would leak the previous user's rows across a logout wipe. `__drizzle_migrations`
 * is deliberately NOT included, so the schema + applied-migration state survive
 * and the next login cold-starts without a re-migrate.
 */
const ALL_SYNC_TABLES: SQLiteTable[] = [
  attachment,
  mutationQueue,
  failedApplies,
  syncCursors,
  syncInitProgress,
  syncStoreMeta,
  schemaMeta,
  products,
  productCases,
  customers,
  suppliers,
  paymentMethods,
  paymentAccounts,
  taxRates,
  units,
  lookups,
  stores,
];

/** Local writes not yet durably accepted by the server — discarded by a wipe. */
const UNSYNCED_STATES = ['pending', 'inflight', 'conflict'] as const;

/** How many 100-row batches the pre-logout flush attempts before giving up. */
const MAX_FLUSH_BATCHES = 20;
/** Hard wall-clock ceiling on the pre-logout flush so a slow network can't hang logout. */
const FLUSH_TIMEOUT_MS = 8000;

/** Count queued local writes a wipe would discard (drives the offline warning). */
export async function countUnsyncedWrites(): Promise<number> {
  const db = getSyncDb();
  const rows = await db
    .select({ id: mutationQueue.mutationId })
    .from(mutationQueue)
    .where(inArray(mutationQueue.status, [...UNSYNCED_STATES]));
  return rows.length;
}

/**
 * Best-effort final push of the mutation queue before a logout wipe, so an
 * online logout loses nothing. Bounded in batches AND wall-clock; all errors are
 * swallowed (the offline warning covers the genuinely-can't-sync case).
 */
export async function flushPendingWrites(storeId: string): Promise<void> {
  const db = getSyncDb();
  const drainAll = (async () => {
    for (let i = 0; i < MAX_FLUSH_BATCHES; i++) {
      const { drained } = await drainMutationQueueOnce(db, storeId);
      if (drained === 0) return;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });

  try {
    await Promise.race([drainAll, timeout]);
  } catch (err) {
    logger.warn('[reset] pre-logout flush failed', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wipe ALL local sync data (logout). Deletes on-disk attachment blobs, then
 * truncates every sync table in one transaction. Keeps the schema + drizzle
 * migration state intact, so the next login cold-starts (no cursor → full
 * re-pull "from the first") without a re-migrate. Idempotent + safe to call on
 * a partially-initialized DB (runs migrations first).
 */
export async function wipeLocalData(): Promise<void> {
  await runMigrations(); // idempotent — guarantees the tables exist before deleting
  const db = getSyncDb();

  // Best-effort: remove retained image blobs so wiped rows don't orphan files.
  try {
    const files = await db
      .select({ path: attachment.localPath, thumb: attachment.localThumbPath })
      .from(attachment);
    await Promise.all(
      files
        .flatMap((f) => [f.path, f.thumb])
        .filter((p): p is string => Boolean(p))
        .map((p) => FileSystem.deleteAsync(p, { idempotent: true }).catch(() => undefined)),
    );
  } catch (err) {
    logger.warn('[reset] attachment blob cleanup failed', err);
  }

  await withTransaction(db, async (tx) => {
    for (const table of ALL_SYNC_TABLES) {
      await tx.delete(table);
    }
  });
}
