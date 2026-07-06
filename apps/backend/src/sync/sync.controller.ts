import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import {
  AllowExpiredSubscription,
  SubscriptionStatusGuard,
} from '#auth/mobile/guards/subscription-status.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import {
  CurrentUser,
  CurrentStoreContext,
  RequirePermissions,
  StoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { SkipTransform } from '#common/decorators/skip-transform.decorator.js';
import { parse } from '#common/validation/parse.js';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { InitialSyncService, type InitialResult } from './pull/initial-sync.service.js';
import { SyncChangesService, type ChangesResult } from './pull/changes.service.js';
import { SyncDeltaService, type SyncDeltaResult } from './push/delta.service.js';
import {
  SyncConflictRepository,
  type SyncConflictRow,
} from './repositories/sync-conflict.repository.js';
import {
  ChangesQuerySchema,
  ConflictListQuerySchema,
  ConflictResolveSchema,
  InitialQuerySchema,
} from './dto/sync-delta.schema.js';

function conflictToWire(row: SyncConflictRow) {
  return {
    mutation_id: row.mutationId,
    entity_type: row.entityType,
    entity_guuid: row.entityGuuid,
    conflict_type: row.conflictType,
    server_row: row.serverRow,
    client_payload: row.clientPayload,
    message: row.message,
    status: row.status,
    note: row.note,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}

const splitTypes = (raw?: string): string[] | undefined =>
  raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

/**
 * The sync engine's HTTP surface (sync-engine.md §2). Standard guard chain;
 * @SkipTransform because clients parse the PRD wire shapes at the top level.
 * /delta carries @AllowExpiredSubscription — the guard's hard write-block is
 * replaced by the per-mutation point-in-time gate (§20): offline sales stamped
 * before access_valid_until must still apply after a lapse.
 */
@Controller('stores/:storeId/sync')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
@SkipTransform()
export class SyncController {
  constructor(
    private readonly initial: InitialSyncService,
    private readonly changes: SyncChangesService,
    private readonly delta: SyncDeltaService,
    private readonly conflicts: SyncConflictRepository,
  ) {}

  /** Cold-start dump — one entity type per call, resumable (F-SYNC-1). */
  @Get('initial')
  @RequirePermissions({ entity: 'Store', action: 'view' })
  async pullInitial(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<InitialResult> {
    const q = parse(query, InitialQuerySchema);
    return this.initial.pull(user.userId, user.deviceId, storeId, {
      entityType: q.entity_type,
      cursor: q.cursor,
      reset: q.reset === 'true',
      supportedEntityTypes: splitTypes(q.supported_entity_types),
      syncCursor: q.sync_cursor,
    });
  }

  /** Delta pull — upserts + tombstones since the cursor (F-SYNC-3/4). */
  @Get('changes')
  @RequirePermissions({ entity: 'Store', action: 'view' })
  async pullChanges(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<ChangesResult> {
    const q = parse(query, ChangesQuerySchema);
    return this.changes.pull(user.userId, storeId, q.cursor, splitTypes(q.supported_entity_types), user.deviceId);
  }

  /** Combined mutation push + delta pull (F-SYNC-5). Always HTTP 200; outcomes are per-mutation. */
  @Post('delta')
  @HttpCode(200)
  @AllowExpiredSubscription()
  @RequirePermissions({ entity: 'Store', action: 'view' })
  async pushDelta(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @CurrentStoreContext() ctx: ResolvedStoreContext,
    @Body() body: unknown,
  ): Promise<SyncDeltaResult> {
    return this.delta.process(user, { storeId, accountId: ctx.accountId }, body);
  }

  /** Open conflicts for the resolution screen (§11), filterable by conflict_type (§11.1). */
  @Get('conflicts')
  @RequirePermissions({ entity: 'Store', action: 'view' })
  async listConflicts(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = parse(query, ConflictListQuerySchema);
    const rows = await this.conflicts.list(storeId, {
      status: q.status,
      conflictType: q.conflict_type,
    });
    return { conflicts: rows.map(conflictToWire) };
  }

  /** Bookkeeping only — the client rebases and resubmits under the new row_version. */
  @Patch('conflicts/:mutationId')
  @AllowExpiredSubscription()
  @RequirePermissions({ entity: 'Store', action: 'view' })
  async resolveConflict(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('mutationId') mutationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ) {
    const b = parse(body, ConflictResolveSchema);
    const row = await this.conflicts.resolve(storeId, mutationId, {
      status: b.status,
      note: b.note,
      resolvedBy: user.userId,
    });
    if (!row) {
      throw new NotFoundError(ErrorCodes.SYNC_CONFLICT_NOT_FOUND, 'No conflict recorded for this mutation');
    }
    return conflictToWire(row);
  }
}