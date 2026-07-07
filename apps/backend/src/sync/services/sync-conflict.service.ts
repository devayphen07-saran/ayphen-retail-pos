import { Injectable } from '@nestjs/common';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { SyncFilterRegistry } from '../registry/sync-filter.registry.js';
import {
  SyncConflictRepository,
  type SyncConflictRow,
  type ConflictStatus,
  type ConflictType,
} from '../repositories/sync-conflict.repository.js';

/** Conflict-resolution use cases (sync-engine.md §11) — bookkeeping only, the server never merges. */
@Injectable()
export class SyncConflictService {
  constructor(
    private readonly repo: SyncConflictRepository,
    private readonly registry: SyncFilterRegistry,
    private readonly rbac: RbacService,
  ) {}

  /**
   * Every other sync surface gates by the mutation's entity-level `view`
   * permission (registry/entity-filter.ts); conflicts must match — a role
   * denied view on an entity shouldn't see or resolve its conflicts, which
   * carry the full server_row/client_payload (PII, pricing, etc).
   */
  private canView(
    entityType: string,
    permissions: Awaited<ReturnType<RbacService['getCachedPermissions']>>,
  ): boolean {
    const filter = this.registry.get(entityType);
    return (
      !filter ||
      this.rbac.checkCrud(permissions, filter.permissionEntity, 'view')
    );
  }

  async list(
    storeId: string,
    userId: string,
    filter: { status?: ConflictStatus; conflictType?: ConflictType },
  ): Promise<SyncConflictRow[]> {
    const permissions = await this.rbac.getCachedPermissions(
      userId,
      storeId,
      false,
    );
    const rows = await this.repo.list(storeId, filter);
    return rows.filter((row) => this.canView(row.entityType, permissions));
  }

  async resolve(
    storeId: string,
    userId: string,
    mutationId: string,
    patch: {
      status: 'resolved' | 'discarded';
      note?: string;
      resolvedBy: string;
    },
  ): Promise<SyncConflictRow> {
    // Authorize BEFORE mutating — checking after resolve() would let an
    // unauthorized caller flip a conflict's status and only hide the response.
    const existing = await this.repo.findByMutationId(storeId, mutationId);
    const permissions = await this.rbac.getCachedPermissions(
      userId,
      storeId,
      false,
    );
    // Same 404 (not 403) for "doesn't exist" and "exists but not viewable" —
    // matches TenantGuard/lookup.service's existence-hiding convention.
    if (!existing || !this.canView(existing.entityType, permissions)) {
      throw new NotFoundError(
        ErrorCodes.SYNC_CONFLICT_NOT_FOUND,
        'No conflict recorded for this mutation',
      );
    }
    const row = await this.repo.resolve(storeId, mutationId, patch);
    if (!row) {
      throw new NotFoundError(
        ErrorCodes.SYNC_CONFLICT_NOT_FOUND,
        'No conflict recorded for this mutation',
      );
    }
    return row;
  }
}
