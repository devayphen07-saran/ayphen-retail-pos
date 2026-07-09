import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE, type Database } from '#db/db.module.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { SyncCursorService, type EntityWatermark } from '../cursor/sync-cursor.service.js';
import { SyncFilterRegistry } from '../registry/sync-filter.registry.js';
import { ZERO_UUID, type SyncPullContext, type WireRow } from '../registry/entity-filter.js';
import { TombstoneRepository, type TombstoneWireRow } from '../repositories/tombstone.repository.js';
import { DeviceSyncHealthRepository } from '../repositories/device-sync-health.repository.js';
import { DELTA_PAGE_SIZE, PER_ENTITY_FLOOR } from '../sync.constants.js';

export interface EntityChanges {
  upserts: WireRow[];
  deletes: TombstoneWireRow[];
}

export interface ChangesResult {
  changes: Record<string, EntityChanges>;
  sync_cursor: string;
  has_more: boolean;
  server_time: string;
}

/** Legacy cursors without a tombstone watermark start from epoch — over-delivery is idempotent, a skipped delete is a resurrected row. */
const EPOCH_WATERMARK: EntityWatermark = { ts: '1970-01-01T00:00:00.000000Z', id: ZERO_UUID };

/**
 * Delta pull (sync-engine.md §7). Per-entity watermarks advance independently
 * with the no-gap rule (BR-SYNC-005): a drained page advances only to the last
 * row actually returned; an empty page keeps the previous watermark — a row
 * committed during the read window is never skipped, only re-delivered.
 */
@Injectable()
export class SyncChangesService {
  private readonly logger = new Logger(SyncChangesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: SyncFilterRegistry,
    private readonly cursors: SyncCursorService,
    private readonly rbac: RbacService,
    private readonly tombstones: TombstoneRepository,
    private readonly health: DeviceSyncHealthRepository,
  ) {}

  async pull(
    userId: string,
    storeId: string,
    cursorToken: string,
    supportedEntityTypes?: string[],
    // Present only on the standalone /sync/changes path — advances last_sync_at
    // so a pull-only device isn't stranded (F1). Omitted when called from
    // /sync/delta, which stamps once for the whole push+pull round trip.
    deviceId?: string,
  ): Promise<ChangesResult> {
    const now = new Date();
    if (deviceId) await this.health.touch(deviceId, now);
    const cursor = this.cursors.decode(cursorToken, userId, storeId, now);
    const permissions = await this.rbac.getCachedPermissions(userId, storeId, false);
    const ctx: SyncPullContext = { db: this.db, storeId, userId, permissions };

    // A requested type this server has never heard of (typo, stale client
    // constant, casing mismatch against a non-snake_case wire string like
    // `taxrate`) would otherwise vanish with no trace — log it, but never
    // fail the pull over it; every other requested entity must still work.
    const unknown = this.registry.unknownTypes(supportedEntityTypes);
    if (unknown.length) {
      this.logger.warn(
        `Unrecognized supported_entity_types requested by user=${userId} store=${storeId}: ${unknown.join(', ')}`,
      );
    }

    // Only entities this cursor tracks — a brand-new entity type cold-starts
    // through /sync/initial (which merges its anchor into the cursor), it is
    // never epoch-dumped through the delta path.
    const filters = this.registry
      .supported(supportedEntityTypes)
      .filter((f) => cursor.e[f.entityType] !== undefined);

    // Fair share with a floor so one entity's backlog still drains at a usable
    // rate when many entities are registered (S-11).
    const perEntityLimit = Math.max(
      Math.floor(DELTA_PAGE_SIZE / Math.max(filters.length, 1)),
      PER_ENTITY_FLOOR,
    );

    const changes: Record<string, EntityChanges> = {};
    const nextEntities: Record<string, EntityWatermark> = { ...cursor.e };
    let hasMore = false;

    for (const filter of filters) {
      // Entity-level RBAC (§18): no `view` → empty page. The watermark is
      // deliberately NOT advanced — after a re-grant the client back-fills
      // from where it stopped instead of permanently missing the gap (S-5).
      if (!this.rbac.checkCrud(permissions, filter.permissionEntity, 'view')) {
        changes[filter.entityType] = { upserts: [], deletes: [] };
        continue;
      }

      const page = await filter.pullChanges(ctx, cursor.e[filter.entityType], perEntityLimit);
      changes[filter.entityType] = { upserts: page.rows, deletes: [] };
      if (page.watermark) nextEntities[filter.entityType] = page.watermark;
      hasMore ||= page.hasMore;
    }

    // Shared tombstone stream (§8) — merged into changes[entity].deletes. The
    // client applies an entity's upserts before its deletes within one page
    // (BR-SYNC-021: created+deleted in-window must end deleted).
    const tombstoneAfter = cursor.t ?? EPOCH_WATERMARK;
    const tombstonePage = await this.tombstones.pullSince(this.db, storeId, tombstoneAfter, DELTA_PAGE_SIZE);
    for (const del of tombstonePage.rows) {
      (changes[del.entity_type] ??= { upserts: [], deletes: [] }).deletes.push(del);
    }
    hasMore ||= tombstonePage.hasMore;

    return {
      changes,
      sync_cursor: this.cursors.mint(
        userId,
        storeId,
        nextEntities,
        tombstonePage.watermark ?? tombstoneAfter,
        now,
      ),
      has_more: hasMore,
      server_time: now.toISOString(),
    };
  }
}