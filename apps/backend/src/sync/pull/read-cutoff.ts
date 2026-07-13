import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '#db/db.module.js';
import { READ_SAFETY_LAG_MS } from '../sync.constants.js';

/**
 * The read-side safety cutoff (B2/B3). A delta/tombstone read may only serve
 * rows whose `modified_at`/`deleted_at` is STRICTLY OLDER than this timestamp.
 *
 * Why not a fixed `now() - lag`: the sync triggers stamp `now()` =
 * transaction-START time (0019_sync_touch_triggers.sql), so a write transaction
 * open longer than the fixed lag can commit a row whose timestamp already sits
 * behind an advanced watermark → the no-gap advance (§7) never sees it →
 * permanently skipped upsert (or, on the tombstone stream that previously had
 * NO lag at all, a resurrected row — the worst failure class, §8).
 *
 * The cutoff is therefore the EARLIER of:
 *   - `now() - READ_SAFETY_LAG_MS` (the original floor), and
 *   - the start time of the oldest in-flight client write transaction.
 * Any row a still-open transaction will later commit carries `modified_at` =
 * that transaction's start time, which is `>= min(xact_start) >= cutoff`, so it
 * can never fall below a line we have already served — its delivery is simply
 * deferred until the transaction commits and the cutoff moves past it.
 *
 * Only `client backend` transactions count: autovacuum/wal/background workers
 * never fire the sync trigger, and folding their (often long) `xact_start` in
 * would needlessly stall the delta stream. This assumes writers share the DB
 * role whose transactions are visible in `pg_stat_activity`; if the stats query
 * is unavailable we return `null` and the caller falls back to the inline
 * fixed-lag predicate, which remains correct for sub-lag transactions.
 */
export async function computeReadCutoff(db: DbExecutor): Promise<string | null> {
  const lagSecs = READ_SAFETY_LAG_MS / 1000;
  try {
    const rows = await db.execute<{ cutoff: string | null }>(sql`
      SELECT to_char(
        LEAST(
          now() - make_interval(secs => ${lagSecs}),
          COALESCE(
            (
              SELECT min(xact_start)
              FROM pg_stat_activity
              WHERE backend_type = 'client backend'
                AND xact_start IS NOT NULL
                AND pid <> pg_backend_pid()
            ),
            'infinity'::timestamptz
          )
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS cutoff
    `);
    return rows[0]?.cutoff ?? null;
  } catch {
    // pg_stat_activity unavailable (permissions / managed-PG edge) — the
    // caller's inline `now() - lag` predicate stays as the safe floor.
    return null;
  }
}

/**
 * The SQL predicate a keyset read applies so it never serves a row a still-open
 * write transaction could reorder behind it. `cutoff` is `computeReadCutoff`'s
 * result: a µs timestamp string, or `null` to fall back to the inline fixed lag.
 */
export function readLagPredicate(column: AnyPgColumn, cutoff: string | null): SQL {
  return cutoff
    ? sql`${column} < ${cutoff}::timestamptz`
    : sql`${column} < now() - make_interval(secs => ${READ_SAFETY_LAG_MS / 1000})`;
}