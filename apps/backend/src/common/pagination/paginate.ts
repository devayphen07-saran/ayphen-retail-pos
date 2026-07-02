import type { SQL } from 'drizzle-orm';
import { and, lt, or, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { decodeCursor, encodeCursor } from './cursor.js';

export interface CursorPage<T> {
  items:      T[];
  nextCursor: string | null;
  hasMore:    boolean;
}

interface PaginateOptions<T> {
  /** Client cursor (opaque base64url) or undefined for the first page. */
  cursor?: string;
  /** Page size (already clamped by the caller). */
  limit: number;
  /**
   * The column the result is ordered by, DESC. Must be sortable and stored as
   * something `decodeCursor().v` (an ISO string) compares against — typically a
   * timestamp column.
   */
  sortColumn: AnyPgColumn;
  /** Unique tie-breaker column (usually the PK). */
  tieColumn: AnyPgColumn;
  /**
   * Runs the actual query. Receives the keyset predicate to AND into the base
   * WHERE (undefined on the first page) and the row count to fetch (limit + 1).
   * Must apply `ORDER BY sortColumn DESC, tieColumn DESC` and the given limit.
   */
  fetch: (keyset: SQL | undefined, take: number) => Promise<T[]>;
  /** Extracts the sort value (ISO string) from a row for the next cursor. */
  sortValue: (row: T) => string;
  /** Extracts the tie-breaker id from a row for the next cursor. */
  idValue: (row: T) => string;
}

/**
 * Generic keyset (cursor) pagination over a DESC-ordered query. Fetches
 * `limit + 1` rows to detect `hasMore`, trims the extra, and builds the next
 * cursor from the last returned row. Stable under concurrent inserts/deletes.
 *
 * The keyset predicate encodes `(sortColumn, tieColumn) < (cursor.v, cursor.id)`
 * so paging never skips or repeats a row even as the table changes.
 */
export async function paginateByCursor<T>(opts: PaginateOptions<T>): Promise<CursorPage<T>> {
  const { cursor, limit, sortColumn, tieColumn, fetch, sortValue, idValue } = opts;

  let keyset: SQL | undefined;
  if (cursor) {
    const { v, id } = decodeCursor(cursor);
    // Keyset predicate: `(sortColumn, tieColumn) < (v, id)` in DESC order.
    //
    // Timestamp-precision fix: the cursor's `v` is a millisecond-precision ISO
    // string (`Date.toISOString()` — the postgres-js driver hands the app JS
    // `Date`s, which are ms-precision), but a `timestamptz` column stores
    // MICROSECONDS. Comparing the raw column against `v` would strand any row
    // that shares the cursor's millisecond but has extra sub-ms precision: it is
    // neither `< v` nor `= v`, so it matches neither branch and is skipped
    // forever. We compare a millisecond-truncated view of the column
    // (`date_trunc('milliseconds', sortColumn)`) so both sides share the exact
    // precision the cursor round-trips at. The unique `tieColumn` still breaks
    // ties within a millisecond, keeping the ordering total and duplicate-free.
    const sortAtCursorPrecision = sql`date_trunc('milliseconds', ${sortColumn})`;
    keyset = or(
      lt(sortAtCursorPrecision, v),
      and(eq(sortAtCursorPrecision, v), lt(tieColumn, id)),
    );
  }

  const rows = await fetch(keyset, limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(idValue(last), sortValue(last)) : null;

  return { items, nextCursor, hasMore };
}
