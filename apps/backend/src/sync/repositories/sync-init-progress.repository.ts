import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type DbExecutor } from '#db/db.module.js';
import { ConflictError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { syncInitProgress } from '#db/schema.js';

export type InitProgressRow = typeof syncInitProgress.$inferSelect;

/**
 * Cold-start progress, PK (store, device, entity) — two devices cold-start the
 * same store independently (§21). Each entity row carries its OWN
 * session_started_at (S-4): the delta anchor for a brand-new entity type on an
 * otherwise-complete device is its own cold-start session, never a months-old
 * inherited one.
 */
@Injectable()
export class SyncInitProgressRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async listFor(storeId: string, deviceId: string, tx?: DbExecutor): Promise<InitProgressRow[]> {
    return this.client(tx)
      .select()
      .from(syncInitProgress)
      .where(and(eq(syncInitProgress.storeFk, storeId), eq(syncInitProgress.deviceFk, deviceId)));
  }

  /** Ensure a row exists for this entity; a fresh row anchors its own session. */
  async ensure(
    storeId: string,
    deviceId: string,
    entityType: string,
    tx?: DbExecutor,
  ): Promise<InitProgressRow> {
    const client = this.client(tx);
    const [inserted] = await client
      .insert(syncInitProgress)
      .values({ storeFk: storeId, deviceFk: deviceId, entityType })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;

    const [existing] = await client
      .select()
      .from(syncInitProgress)
      .where(and(
        eq(syncInitProgress.storeFk, storeId),
        eq(syncInitProgress.deviceFk, deviceId),
        eq(syncInitProgress.entityType, entityType),
      ));
    // The insert conflicted (row existed) but the re-select found nothing — a
    // concurrent delete raced between the two statements. Rare; report cleanly.
    if (!existing) {
      throw new ConflictError(ErrorCodes.CONCURRENT_MODIFICATION, 'Sync progress row changed concurrently; retry');
    }
    return existing;
  }

  async savePage(
    storeId: string,
    deviceId: string,
    entityType: string,
    cursor: string | null,
    phase: 'in_progress' | 'completed',
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(syncInitProgress)
      .set({ cursor, phase, updatedAt: sql`now()` })
      .where(and(
        eq(syncInitProgress.storeFk, storeId),
        eq(syncInitProgress.deviceFk, deviceId),
        eq(syncInitProgress.entityType, entityType),
      ));
  }

  /** `reset=true` — local DB wipe: forget everything and cold-start from scratch. */
  async reset(storeId: string, deviceId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .delete(syncInitProgress)
      .where(and(eq(syncInitProgress.storeFk, storeId), eq(syncInitProgress.deviceFk, deviceId)));
  }
}