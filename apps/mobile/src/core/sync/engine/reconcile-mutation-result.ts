import type { MutationResultWire } from '../transport/sync-wire-types';

/**
 * What the queue-drain loop must do for each of the server's five result
 * kinds (sync-engine.md §9, delta.service.ts). This is a PURE decision
 * function on purpose — no DB, no network — so the one rule that matters most
 * here (`retry_later` is not `rejected`) is verifiable without any I/O.
 *
 *  - applied / duplicate → the optimistic write is confirmed; commit it.
 *  - conflict            → keep the queue row, attach server_row, surface the resolver.
 *  - rejected            → terminal; the caller MUST roll back the optimistic write.
 *  - retry_later         → transient (subscription paused/lapsed-pending-renewal/
 *                          reconciliation-pending). The optimistic write is
 *                          NOT wrong — it's just not applied yet. Do nothing
 *                          to local state; the next drain cycle resubmits the
 *                          same queue row unchanged. Treating this as
 *                          `rejected` would silently revert a real edit during
 *                          a transient, self-healing account state.
 */
export type ReconcileAction =
  | {
      kind: 'commit-applied';
      entityId?: string;
      entityGuuid?: string;
      rowVersion?: number;
      data?: unknown;
    }
  | { kind: 'commit-duplicate'; cached: unknown }
  | { kind: 'mark-conflict'; serverRow: unknown; message: string }
  | { kind: 'rollback'; code: string; message: string }
  | { kind: 'keep-queued' };

export function reconcileMutationResult(
  result: MutationResultWire,
): ReconcileAction {
  switch (result.status) {
    case 'applied':
      return {
        kind: 'commit-applied',
        entityId: result.entity_id,
        entityGuuid: result.entity_guuid,
        rowVersion: result.row_version,
        data: result.data,
      };
    case 'duplicate':
      return { kind: 'commit-duplicate', cached: result.cached };
    case 'conflict':
      return {
        kind: 'mark-conflict',
        serverRow: result.server_row,
        message: result.message,
      };
    case 'rejected':
      return { kind: 'rollback', code: result.code, message: result.message };
    case 'retry_later':
      return { kind: 'keep-queued' };
  }
}
