import { Injectable } from '@nestjs/common';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import type { CursorPage } from '#common/pagination/paginate.js';
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
    page: { limit: number; cursor?: string },
  ): Promise<CursorPage<SyncConflictRow>> {
    const permissions = await this.rbac.getCachedPermissions(
      userId,
      storeId,
      false,
    );
    // The repo paginates in SQL, so the permission filter must be pushed into
    // the query itself rather than applied after fetching — else a store with
    // many conflicts skewed toward types this caller can't view would
    // silently return a short/empty page even though older, visible
    // conflicts exist beyond the cursor. Mirror `canView`'s rule (a type with
    // no registry entry is always visible) by only excluding types the
    // registry knows about AND the caller lacks `view` on.
    const excludeEntityTypes = this.registry
      .all()
      .filter((f) => !this.rbac.checkCrud(permissions, f.permissionEntity, 'view'))
      .map((f) => f.entityType);
    return this.repo.list(storeId, { ...filter, excludeEntityTypes }, page);
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
      // The optimistic guard (C4) matched nothing though the conflict existed
      // at authorization time — a concurrent resolve already moved it out of
      // 'open'. Re-read: if it's now terminal, the resolve is idempotently
      // satisfied, so return the current row instead of a misleading 404.
      const current = await this.repo.findByMutationId(storeId, mutationId);
      if (current && current.status !== 'open') return current;
      throw new NotFoundError(
        ErrorCodes.SYNC_CONFLICT_NOT_FOUND,
        'No conflict recorded for this mutation',
      );
    }
    return row;
  }
}
