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
import { SyncRateLimitGuard, SyncRateLimit } from './guards/sync-rate-limit.guard.js';
import { DeviceSlotGuard } from './guards/device-slot.guard.js';
import {
  CurrentUser,
  CurrentStoreContext,
  StoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { SkipTransform } from '#common/decorators/skip-transform.decorator.js';
import { parse } from '#common/validation/parse.js';
import { InitialSyncService } from './pull/initial-sync.service.js';
import { SyncChangesService } from './pull/changes.service.js';
import { SyncDeltaService } from './push/delta.service.js';
import { SyncConflictService } from './services/sync-conflict.service.js';
import { ConflictResponseMapper } from './mappers/response/conflict.response-mapper.js';
import type { ConflictResponse } from './dto/response/conflict.response.js';
import type { InitialPullResponse, ChangesPullResponse } from './dto/response/pull.response.js';
import type { SyncDeltaResponse } from './dto/response/delta.response.js';
import type { PaginatedResponse } from '#common/pagination/paginated-response.js';
import {
  ChangesQuerySchema,
  ConflictListQuerySchema,
  ConflictResolveSchema,
  InitialQuerySchema,
  SyncDeltaSchema,
  splitTypes,
} from './dto/sync-delta.schema.js';

/**
 * The sync engine's HTTP surface (sync-engine.md §2). Standard guard chain;
 * @SkipTransform because clients parse the PRD wire shapes at the top level.
 *
 * No @RequirePermissions here: TenantGuard already confirms the caller is a
 * member of this store, and the entity-type-level filters inside the sync
 * engine (§18) gate individual entities by their own `view` permission — a
 * blanket Store:view on top would lock out every staff role (Store isn't in
 * DEFAULT_ROLE_CRUD by design) before that per-entity logic ever runs.
 *
 * /delta carries @AllowExpiredSubscription — the guard's hard write-block is
 * replaced by the per-mutation point-in-time gate (§20): offline sales stamped
 * before access_valid_until must still apply after a lapse.
 */
@Controller('stores/:storeId/sync')
@UseGuards(MobileJwtGuard, SyncRateLimitGuard, TenantGuard, DeviceSlotGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
@SkipTransform()
export class SyncController {
  constructor(
    private readonly initial: InitialSyncService,
    private readonly changes: SyncChangesService,
    private readonly delta: SyncDeltaService,
    private readonly conflicts: SyncConflictService,
  ) {}

  /** Cold-start dump — one entity type per call, resumable (F-SYNC-1). */
  @Get('initial')
  async pullInitial(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<InitialPullResponse> {
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
  @SyncRateLimit('changes')
  async pullChanges(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<ChangesPullResponse> {
    const q = parse(query, ChangesQuerySchema);
    return this.changes.pull(user.userId, storeId, q.cursor, splitTypes(q.supported_entity_types), user.deviceId);
  }

  /** Combined mutation push + delta pull (F-SYNC-5). Always HTTP 200; outcomes are per-mutation. */
  @Post('delta')
  @HttpCode(200)
  @SyncRateLimit('delta')
  @AllowExpiredSubscription()
  async pushDelta(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @CurrentStoreContext() ctx: ResolvedStoreContext,
    @Body() rawBody: unknown,
  ): Promise<SyncDeltaResponse> {
    const body = parse(rawBody, SyncDeltaSchema);
    return this.delta.process(user, { storeId, accountId: ctx.accountId }, body);
  }

  /** Open conflicts for the resolution screen (§11), filterable by conflict_type (§11.1). */
  @Get('conflicts')
  async listConflicts(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedResponse<ConflictResponse>> {
    const q = parse(query, ConflictListQuerySchema);
    const page = await this.conflicts.list(
      storeId,
      user.userId,
      { status: q.status, conflictType: q.conflict_type },
      { limit: q.limit, cursor: q.cursor },
    );
    return ConflictResponseMapper.toListResponse(page);
  }

  /** Bookkeeping only — the client rebases and resubmits under the new row_version. */
  @Patch('conflicts/:mutationId')
  @AllowExpiredSubscription()
  async resolveConflict(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('mutationId') mutationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<ConflictResponse> {
    const b = parse(body, ConflictResolveSchema);
    const row = await this.conflicts.resolve(storeId, user.userId, mutationId, {
      status: b.status,
      note: b.note,
      resolvedBy: user.userId,
    });
    return ConflictResponseMapper.toResponse(row);
  }
}