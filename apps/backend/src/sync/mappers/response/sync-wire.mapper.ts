import { assertMicroIso } from '../../us-timestamp.js';
import type { SyncEntityType } from '../../sync.constants.js';

/** A wire row: snake_case, `modified_at` as the µs watermark string. */
export type WireRow = Record<string, unknown>;

/** camelCase → snake_case key conversion for wire rows — shared by every
 *  push handler that serializes a full DB row for `applied.data` and by the
 *  pull-side registry (`entity-filter.ts`), which needs the identical rule. */
export const camelToSnake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const SyncWireMapper = {
  /**
   * Serialize a full DB row for a push handler's `applied.data` — snake_case
   * keys, ISO timestamps. NOT the pull path (toWireRow below handles the µs
   * `modified_at` watermark specially); a client re-pulls the row anyway, so
   * plain ISO is fine here. Composite mutation handlers (sale/refund/customer-
   * payment/supplier-payment) MUST return the full row through this, not a
   * hand-picked subset of fields — drain-queue.ts feeds `applied.data` straight
   * into the entity's local repository `fromWire`, which expects every column
   * (id, every FK, row_version, modified_at) to be present; a partial object
   * corrupts the local row (id/modifiedAt become the literal string
   * "undefined", rowVersion becomes NaN) and produces a duplicate on the next
   * pull once the real row arrives under its actual id.
   */
  toAppliedRow(row: Record<string, unknown>): WireRow {
    const out: WireRow = {};
    for (const [key, value] of Object.entries(row)) {
      out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  },

  /**
   * Serialize a DB row to the wire: snake_case keys, ISO timestamps, and
   * `modified_at` replaced by the SQL-rendered µs string (never the JS Date —
   * BR-SYNC-004). `assertMicroIso` is the S-8 runtime enforcement point.
   */
  toWireRow(row: Record<string, unknown>, entityType: SyncEntityType): WireRow {
    const out: WireRow = {};
    const micro = row['__modifiedAtUs'];
    for (const [key, value] of Object.entries(row)) {
      if (key === '__modifiedAtUs') continue;
      if (key === 'modifiedAt') {
        out['modified_at'] = assertMicroIso(String(micro), entityType);
        continue;
      }
      out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  },
};
