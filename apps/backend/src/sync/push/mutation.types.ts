import type { DbTransaction } from '#db/db.module.js';
import type { EntityCode } from '#common/rbac/permission-matrix.constants.js';
import type { ErrorCode } from '#common/error-codes.js';
import type { ConflictType } from '../repositories/sync-conflict.repository.js';
import type { WireRow } from '../registry/entity-filter.js';
import type { SyncEntityType } from '../sync.constants.js';

export type MutationAction = 'create' | 'update' | 'delete';

export interface MutationContext {
  tx: DbTransaction;
  storeId: string;
  userId: string;
  deviceId: string;
  /** Skew-clamped client_modified_at (§12) — what "when it was queued" means server-side. */
  effectiveAsOf: Date;
}

/**
 * What a handler's apply() can produce. `rejected` thrown from inside the
 * business tx rolls the tx back (the delta pipeline converts it to a
 * per-mutation result); `conflict` commits its bookkeeping in-tx.
 */
export type HandlerOutcome =
  | {
      kind: 'applied';
      entityId?: string;
      entityGuuid?: string;
      rowVersion?: number;
      data?: WireRow;
    }
  | {
      kind: 'conflict';
      entityGuuid?: string;
      serverRow: WireRow | null;
      message: string;
    }
  | {
      kind: 'rejected';
      code: ErrorCode;
      message: string;
      conflictType: ConflictType;
    };

/**
 * One entity's push implementation. Resolution goes through the
 * MutationHandlerRegistry (an entity→handler map) — adding order/shift/cash
 * handlers (WS-5) is registry registration, never a switch in the pipeline.
 */
export interface SyncMutationHandler {
  entityType: SyncEntityType;
  /** RBAC entity the §12 current/point-in-time authorization checks run against. */
  permissionEntity: EntityCode;
  apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome>;
}
