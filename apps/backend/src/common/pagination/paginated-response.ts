/**
 * Standard cursor-paginated response envelope. `next_cursor` is an opaque
 * base64url token to pass back as `?cursor=` for the next page; `null` when
 * there are no more rows.
 */
export interface PaginatedResponse<T> {
  data:        T[];
  next_cursor: string | null;
  has_more:    boolean;
}

/** Bounds a client-supplied `limit`, applying a default and a hard cap. */
export function clampLimit(
  raw: unknown,
  { def = 20, max = 100 }: { def?: number; max?: number } = {},
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
