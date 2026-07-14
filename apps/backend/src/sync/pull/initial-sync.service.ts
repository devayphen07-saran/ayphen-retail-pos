import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '#db/db.module.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { BadRequestError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { SyncCursorService, type EntityWatermark } from '../cursor/sync-cursor.service.js';
import { SyncFilterRegistry } from '../registry/sync-filter.registry.js';
import { ZERO_UUID, type SyncPullContext } from '../registry/entity-filter.js';
import {
  SyncInitProgressRepository,
  type InitProgressRow,
} from '../repositories/sync-init-progress.repository.js';
import { DeviceSyncHealthRepository } from '../repositories/device-sync-health.repository.js';
import { INITIAL_PAGE_SIZE } from '../sync.constants.js';
import { microIsoFromDate } from '../us-timestamp.js';
import { PullResponseMapper, type InitialPullDomainResult } from '../mappers/response/pull.response-mapper.js';
import type { InitialPullResponse } from '../dto/response/pull.response.js';

export interface InitialQuery {
  entityType?: string;
  cursor?: string;
  reset?: boolean;
  supportedEntityTypes?: string[];
  /** The client's live delta cursor, if any — new-entity anchors merge into it. */
  syncCursor?: string;
}

/**
 * Cold start (sync-engine.md §5). One entity type per call in dependencyOrder,
 * INITIAL_PAGE_SIZE rows/page keyset on id ASC. Progress is persisted per
 * (store, device, entity) so a crash mid-cold-start resumes from the last page
 * — the deterministic keyset returns the same rows for the same cursor.
 *
 * Each entity's delta anchor is ITS OWN session start (S-4): the first
 * /sync/changes for an entity re-delivers anything written during that
 * entity's dump window (harmless idempotent re-delivery, never a gap).
 */
@Injectable()
export class InitialSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: SyncFilterRegistry,
    private readonly cursors: SyncCursorService,
    private readonly rbac: RbacService,
    private readonly progress: SyncInitProgressRepository,
    private readonly health: DeviceSyncHealthRepository,
  ) {}

  async pull(
    userId: string,
    deviceId: string,
    storeId: string,
    q: InitialQuery,
  ): Promise<InitialPullResponse> {
    const now = new Date();
    await this.health.touch(deviceId, now);   // F1 — advance last_sync_at on cold start too
    const permissions = await this.rbac.getCachedPermissions(userId, storeId, false);
    const ctx: SyncPullContext = { db: this.db, storeId, userId, permissions };

    if (q.reset) await this.progress.reset(storeId, deviceId);

    const filters = this.registry.supported(q.supportedEntityTypes);
    let progressRows = await this.progress.listFor(storeId, deviceId);
    const phaseOf = (entity: string) =>
      progressRows.find((r) => r.entityType === entity)?.phase;

    // Explicit entity_type, or the first in dependencyOrder not yet completed.
    const filter = q.entityType
      ? filters.find((f) => f.entityType === q.entityType)
      : filters.find((f) => phaseOf(f.entityType) !== 'completed');

    if (q.entityType && !filter) {
      throw new BadRequestError(
        ErrorCodes.VALIDATION_FAILED,
        `Unknown or unsupported entity_type '${q.entityType}'`,
      );
    }

    if (!filter) {
      // Everything already complete — hand back the delta cursor and stop.
      return this.completedResult(userId, storeId, filters.map((f) => f.entityType), progressRows, q.syncCursor, now);
    }

    const row = await this.progress.ensure(storeId, deviceId, filter.entityType);
    if (!progressRows.some((r) => r.entityType === filter.entityType)) {
      progressRows = [...progressRows, row];
    }

    // Resume point: an explicit page cursor (prefixed so it can't be replayed
    // against another entity) beats the stored one.
    let afterId: string | null = row.cursor;
    if (q.cursor) {
      const sep = q.cursor.indexOf(':');
      const prefix = sep >= 0 ? q.cursor.slice(0, sep) : '';
      if (prefix !== filter.entityType) {
        throw new BadRequestError(ErrorCodes.INVALID_CURSOR, 'Page cursor does not match the entity being pulled');
      }
      afterId = q.cursor.slice(sep + 1) || null;
    }

    // No `view` on this entity → nothing to dump; mark completed so the loop
    // proceeds. (Claw-back on later revocation is the client's job, S-5.)
    const canView = this.rbac.checkCrud(permissions, filter.permissionEntity, 'view');

    const page = canView
      ? await filter.pullInitial(ctx, afterId, INITIAL_PAGE_SIZE)
      : { rows: [], lastId: null, hasMore: false };

    const phase = page.hasMore ? ('in_progress' as const) : ('completed' as const);
    await this.progress.savePage(storeId, deviceId, filter.entityType, page.lastId ?? afterId, phase);

    const estimatedTotal =
      afterId === null && canView ? await filter.estimateCount(ctx) : undefined;

    // Recompute remaining with this page's phase applied.
    const phases = new Map(progressRows.map((r) => [r.entityType, r.phase]));
    phases.set(filter.entityType, phase);
    const remaining = filters
      .map((f) => f.entityType)
      .filter((entity) => phases.get(entity) !== 'completed');
    const allComplete = remaining.length === 0;

    const domain: InitialPullDomainResult = {
      entityType: filter.entityType,
      upserts: page.rows,
      hasMore: page.hasMore,
      pageCursor: page.lastId ? `${filter.entityType}:${page.lastId}` : null,
      allEntitiesComplete: allComplete,
      remainingEntityTypes: remaining,
      estimatedTotal,
      nextDeltaCursor: allComplete
        ? this.buildDeltaCursor(
            userId, storeId, filters.map((f) => f.entityType), progressRows, q.syncCursor, now,
          )
        : undefined,
      serverTime: now.toISOString(),
    };
    return PullResponseMapper.toInitialResponse(domain);
  }

  private completedResult(
    userId: string,
    storeId: string,
    entities: string[],
    progressRows: InitProgressRow[],
    syncCursor: string | undefined,
    now: Date,
  ): InitialPullResponse {
    return PullResponseMapper.toInitialResponse({
      entityType: null,
      upserts: [],
      hasMore: false,
      pageCursor: null,
      allEntitiesComplete: true,
      remainingEntityTypes: [],
      nextDeltaCursor: this.buildDeltaCursor(userId, storeId, entities, progressRows, syncCursor, now),
      serverTime: now.toISOString(),
    });
  }

  /**
   * The global delta cursor handed to the first /sync/changes. Every entity is
   * anchored at ITS OWN cold-start session start (S-4, BR-SYNC-006); the
   * tombstone stream at the oldest of them. When the client already holds a
   * live delta cursor (new entity added mid-life), its steady-state watermarks
   * win — merging must never regress entities that were already delta-syncing.
   */
  private buildDeltaCursor(
    userId: string,
    storeId: string,
    entities: string[],
    progressRows: InitProgressRow[],
    existingCursorToken: string | undefined,
    now: Date,
  ): string {
    const anchors: Record<string, EntityWatermark> = {};
    let oldestStart: Date | null = null;

    for (const entity of entities) {
      const row = progressRows.find((r) => r.entityType === entity);
      const start = row?.sessionStartedAt ?? now;
      anchors[entity] = { ts: microIsoFromDate(start), id: ZERO_UUID };
      if (!oldestStart || start < oldestStart) oldestStart = start;
    }

    let tombstone: EntityWatermark = {
      ts: microIsoFromDate(oldestStart ?? now),
      id: ZERO_UUID,
    };

    if (existingCursorToken) {
      try {
        const existing = this.cursors.decode(existingCursorToken, userId, storeId, now);
        for (const [entity, watermark] of Object.entries(existing.e)) {
          anchors[entity] = watermark;
        }
        if (existing.t) tombstone = existing.t;
      } catch {
        // Invalid/expired merge source — fresh anchors are the safe fallback
        // (worst case: idempotent re-delivery).
      }
    }

    return this.cursors.mint(userId, storeId, anchors, tombstone, now);
  }
}