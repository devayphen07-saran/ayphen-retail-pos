import { reconcileMutationResult } from './reconcile-mutation-result';
import type { MutationResultWire } from '../transport/sync-wire-types';

/**
 * The five-way result contract (sync-engine.md §9 / delta.service.ts). The
 * one rule worth a dedicated test: `retry_later` must never be reconciled the
 * same way as `rejected` — it's a transient account-level block (subscription
 * paused / reconciliation pending), not a rejection of the write itself.
 * Treating it as `rejected` would silently revert a real optimistic edit
 * during a self-healing state instead of leaving it queued to retry.
 */
describe('reconcileMutationResult', () => {
  it('retry_later keeps the write queued — it is NOT a rollback', () => {
    const result: MutationResultWire = {
      mutation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'retry_later',
      code: 'SUBSCRIPTION_RECONCILIATION_REQUIRED',
      message: 'a plan downgrade is awaiting reconciliation',
    };

    expect(reconcileMutationResult(result)).toEqual({ kind: 'keep-queued' });
  });

  it('rejected DOES roll back — the one kind retry_later must never be confused with', () => {
    const result: MutationResultWire = {
      mutation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'rejected',
      code: 'SUBSCRIPTION_LAPSED_AT_WRITE',
      message: 'write was queued after the subscription lapsed',
    };

    const action = reconcileMutationResult(result);
    expect(action.kind).toBe('rollback');
    expect(action).not.toEqual({ kind: 'keep-queued' });
  });

  it('applied commits the write with the server-assigned row_version', () => {
    const result: MutationResultWire = {
      mutation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'applied',
      entity_id: 'e1',
      entity_guuid: 'g1',
      row_version: 2,
      data: { name: 'Widget' },
    };

    expect(reconcileMutationResult(result)).toEqual({
      kind: 'commit-applied',
      entityId: 'e1',
      entityGuuid: 'g1',
      rowVersion: 2,
      data: { name: 'Widget' },
    });
  });

  it('duplicate is treated as applied (idempotent replay)', () => {
    const result: MutationResultWire = {
      mutation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'duplicate',
      cached: { status: 'applied' },
    };

    expect(reconcileMutationResult(result)).toEqual({
      kind: 'commit-duplicate',
      cached: { status: 'applied' },
    });
  });

  it('conflict keeps the row queued with the server_row attached for the resolver', () => {
    const result: MutationResultWire = {
      mutation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'conflict',
      conflict_type: 'MASTER_DATA',
      server_row: { row_version: 5 },
      message: 'stale row_version: expected 4, server has 5',
    };

    expect(reconcileMutationResult(result)).toEqual({
      kind: 'mark-conflict',
      serverRow: { row_version: 5 },
      message: 'stale row_version: expected 4, server has 5',
    });
  });
});
