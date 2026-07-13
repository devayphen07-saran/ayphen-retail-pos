import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '#db/db.module.js';
import { syncTombstones } from '#db/schema.js';
import { assertMicroIso, microIso } from '../us-timestamp.js';
import { readLagPredicate } from '../pull/read-cutoff.js';
import type { EntityWatermark } from '../cursor/sync-cursor.service.js';
import { ZERO_UUID } from '../registry/entity-filter.js';

export interface TombstoneWrite {
  storeFk: string;
  entityType: string;
  entityGuuid: string;
  entityId?: string;
  deletedByUserFk?: string;
  hardDelete?: boolean;
}

/** Wire shape (§8) — deliberately no deleted_by_*: pure sync needs guuid + hard_delete only. */
export interface TombstoneWireRow {
  entity_type: string;
  guuid: string;
  entity_id: string | null;
  deleted_at: string;
  hard_delete: boolean;
}

export interface TombstonePage {
  rows: TombstoneWireRow[];
  watermark: EntityWatermark | null;
  hasMore: boolean;
}

/**
 * The shared delete stream (sync-engine.md §8). `write` takes a MANDATORY tx —
 * a tombstone written outside the business delete's transaction can be lost on
 * rollback (delete undone, tombstone kept) or vice versa (row gone, no
 * tombstone → resurrected on the next pull, the failure class §8 calls worse
 * than a missed upsert).
 */
@Injectable()
export class TombstoneRepository {
  /** Same-tx tombstone write. Re-delete refreshes deleted_at so the keyset re-surfaces it. */
  async write(tx: DbExecutor, entry: TombstoneWrite): Promise<void> {
    await tx
      .insert(syncTombstones)
      .values({
        storeFk: entry.storeFk,
        entityType: entry.entityType,
        entityGuuid: entry.entityGuuid,
        entityId: entry.entityId,
        deletedByUserFk: entry.deletedByUserFk,
        hardDelete: entry.hardDelete ?? false,
      })
      .onConflictDoUpdate({
        target: [syncTombstones.entityType, syncTombstones.entityGuuid],
        set: {
          deletedAt: sql`now()`,
          deletedByUserFk: entry.deletedByUserFk ?? null,
          hardDelete: entry.hardDelete ?? false,
        },
      });
  }

  /**
   * One shared (deleted_at, id) keyset per store — same no-gap advance as
   * upserts. A delete committed during the read window is picked up next poll.
   */
  async pullSince(
    db: DbExecutor,
    storeId: string,
    after: EntityWatermark,
    limit: number,
    // Read-safety cutoff (B3). `deleted_at` is stamped at tx-START like
    // `modified_at`, so without this a delete transaction open longer than the
    // lag can drop a tombstone behind an already-advanced watermark →
    // permanently undelivered → resurrected row. This path previously had NO
    // lag at all, asymmetric with the upsert filter; the predicate closes it.
    cutoff: string | null,
  ): Promise<TombstonePage> {
    const keyset = sql`(${syncTombstones.deletedAt} > ${after.ts}::timestamptz OR (${syncTombstones.deletedAt} = ${after.ts}::timestamptz AND ${syncTombstones.id} > ${after.id || ZERO_UUID}::uuid))`;
    const lag = readLagPredicate(syncTombstones.deletedAt, cutoff);

    const rows = await db
      .select({
        id: syncTombstones.id,
        entityType: syncTombstones.entityType,
        entityGuuid: syncTombstones.entityGuuid,
        entityId: syncTombstones.entityId,
        hardDelete: syncTombstones.hardDelete,
        __deletedAtUs: microIso(syncTombstones.deletedAt),
      })
      .from(syncTombstones)
      .where(and(eq(syncTombstones.storeFk, storeId), keyset, lag))
      .orderBy(asc(syncTombstones.deletedAt), asc(syncTombstones.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map((r) => ({
        entity_type: r.entityType,
        guuid: r.entityGuuid,
        entity_id: r.entityId,
        deleted_at: assertMicroIso(r.__deletedAtUs, 'tombstone'),
        hard_delete: r.hardDelete,
      })),
      watermark: last
        ? { ts: assertMicroIso(last.__deletedAtUs, 'tombstone'), id: last.id }
        : null,
      hasMore,
    };
  }
}