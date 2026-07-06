/**
 * Pure display-formatting helpers for the Sync Issues screen — no DB, no
 * React, no RN — so they're verifiable without any I/O (same reasoning as
 * core/sync/engine/reconcile-mutation-result.ts's own pure-function split).
 */

/** Best-effort human label for a queued/server payload — most synced entities
 *  carry a `name`; falling back to the guuid keeps the row identifiable even
 *  for entities that don't. */
export function summarize(payload: unknown, fallbackGuuid: string): string {
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const name = (payload as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return fallbackGuuid;
}

/** `product_case` -> "Product case"; `product` -> "Product". */
export function entityLabel(entityType: string): string {
  return entityType.charAt(0).toUpperCase() + entityType.slice(1).replace(/_/g, ' ');
}
