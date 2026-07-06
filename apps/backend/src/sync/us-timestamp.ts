import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The µs-precision watermark contract (sync-engine.md §4, S-8, BR-SYNC-004).
 *
 * Per-entity watermarks carry modified_at as a 6-decimal µs string produced by
 * Postgres (`to_char(.., 'US')`) and passed VERBATIM through the cursor. A JS
 * `Date` round-trip truncates to ms, collapsing the keyset tiebreaker — with
 * >1 row on one ms boundary the same page is served forever (infinite loop).
 * Every filter must read watermarks through `microIso()` and every value
 * entering a cursor must pass `assertMicroIso()`.
 */

export const MICRO_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Render a timestamptz column as a 6-decimal µs UTC ISO string, in SQL. */
export function microIso(column: AnyPgColumn | SQL): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Runtime enforcement of the contract — a ms-precision watermark is a latent infinite-loop page. */
export function assertMicroIso(value: string, context: string): string {
  if (!MICRO_ISO_RE.test(value)) {
    throw new Error(
      `[sync] non-µs watermark from ${context}: "${value}" — filters must read modified_at via microIso() (S-8)`,
    );
  }
  return value;
}

/**
 * Server-now as a µs ISO string. JS Dates are ms-precision, so the µs digits
 * are zero-padded — fine for clamps and anchors (both compare lexicographically
 * against real µs strings; fixed-width UTC ISO makes string order = time order).
 */
export function microIsoFromDate(d: Date): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}